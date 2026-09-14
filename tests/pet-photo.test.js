import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import test, { mock } from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://localhost:5432/postgres";
process.env.JWT_SECRET ||= "test-secret";

const FAKE_PHOTO_URL = "https://example.com/fake-photo.png";
let uploadPhotoCalls = 0;

// Must mock before importing index.js, which imports storage.js eagerly at
// module-load time — mocking after that point would leave index.js's bound
// reference pointing at the real uploadPhoto.
mock.module("../src/storage.js", {
  namedExports: {
    uploadPhoto: async () => {
      uploadPhotoCalls += 1;
      return FAKE_PHOTO_URL;
    }
  }
});

const { app } = await import("../src/index.js");
const { pool } = await import("../src/db.js");
const jwt = (await import("jsonwebtoken")).default;

const TENANT_ID = crypto.randomUUID();
const PET_ID = crypto.randomUUID();

function signTestToken() {
  return jwt.sign(
    { sub: crypto.randomUUID(), role: "admin", email: "test@example.com", tenant_id: TENANT_ID },
    process.env.JWT_SECRET
  );
}

// 1x1 transparent PNG
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const createPetsPoolMock = () => {
  const pets = new Map([
    [PET_ID, { id: PET_ID, name: "Firulais", tenant_id: TENANT_ID, photo_url: null }]
  ]);

  const query = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();

    if (normalized.startsWith("select status, suspended_reason from tenants")) {
      return { rowCount: 1, rows: [{ status: "active", suspended_reason: null }] };
    }

    if (normalized.startsWith("select 1 from pets where id")) {
      const [id, tenantId] = params;
      const pet = pets.get(id);
      return pet && pet.tenant_id === tenantId
        ? { rowCount: 1, rows: [{ "?column?": 1 }] }
        : { rowCount: 0, rows: [] };
    }

    if (normalized.startsWith("update pets set photo_url")) {
      const [photoUrl, id, tenantId] = params;
      const pet = pets.get(id);
      if (!pet || pet.tenant_id !== tenantId) return { rowCount: 0, rows: [] };
      pet.photo_url = photoUrl;
      return { rowCount: 1, rows: [{ ...pet }] };
    }

    throw new Error(`Unexpected SQL in pet-photo test: ${sql}`);
  };

  return { query };
};

const requestJson = async (baseUrl, path, { method = "GET", body, token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await response.json();
  return { status: response.status, body: json };
};

test("POST /v2/pets/:id/photo", async (t) => {
  const originalQuery = pool.query.bind(pool);
  pool.query = createPetsPoolMock().query;

  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = signTestToken();

  t.after(async () => {
    pool.query = originalQuery;
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  await t.test("rejects requests without a valid data URL", async () => {
    const { status, body } = await requestJson(baseUrl, `/v2/pets/${PET_ID}/photo`, {
      method: "POST",
      token,
      body: { image: "not-a-data-url" }
    });
    assert.equal(status, 400);
    assert.match(body.message, /inválido/i);
  });

  await t.test("rejects disallowed mime types", async () => {
    const { status, body } = await requestJson(baseUrl, `/v2/pets/${PET_ID}/photo`, {
      method: "POST",
      token,
      body: { image: `data:image/gif;base64,${TINY_PNG_BASE64}` }
    });
    assert.equal(status, 400);
    assert.match(body.message, /no permitido/i);
  });

  await t.test("rejects oversized payloads", async () => {
    // Just over the app's 4MB decoded-image limit, but comfortably under the
    // 6MB express.json() body limit (which would otherwise 500 first).
    const bigBase64 = Buffer.alloc(4.2 * 1024 * 1024, 1).toString("base64");
    const { status, body } = await requestJson(baseUrl, `/v2/pets/${PET_ID}/photo`, {
      method: "POST",
      token,
      body: { image: `data:image/png;base64,${bigBase64}` }
    });
    assert.equal(status, 400);
    assert.match(body.message, /tamaño máximo/i);
  });

  await t.test("uploads a valid PNG and persists photo_url", async () => {
    const { status, body } = await requestJson(baseUrl, `/v2/pets/${PET_ID}/photo`, {
      method: "POST",
      token,
      body: { image: `data:image/png;base64,${TINY_PNG_BASE64}` }
    });
    assert.equal(status, 200);
    assert.equal(body.photo_url, FAKE_PHOTO_URL);
  });

  await t.test("returns 404 for a pet outside the tenant, and never uploads its photo", async () => {
    const otherToken = jwt.sign(
      { sub: crypto.randomUUID(), role: "admin", email: "other@example.com", tenant_id: crypto.randomUUID() },
      process.env.JWT_SECRET
    );
    const callsBefore = uploadPhotoCalls;
    const { status } = await requestJson(baseUrl, `/v2/pets/${PET_ID}/photo`, {
      method: "POST",
      token: otherToken,
      body: { image: `data:image/png;base64,${TINY_PNG_BASE64}` }
    });
    assert.equal(status, 404);
    // La key de storage (pets/{id}) no lleva tenant: si esto llegara a
    // subir, pisaría el archivo real de la mascota del otro tenant aunque
    // la base rechace el guardado.
    assert.equal(uploadPhotoCalls, callsBefore, "no debería haber subido nada a storage");
  });
});
