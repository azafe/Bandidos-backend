// Cubre POST /agenda/:id/photo con el mismo enfoque que pet-photo.test.js:
// la key de storage (turnos/{id}) no lleva tenant, así que hay que
// confirmar la pertenencia ANTES de subir el archivo, no solo al guardar
// en la base.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import test, { mock } from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://localhost:5432/postgres";
process.env.JWT_SECRET ||= "test-secret";

const FAKE_PHOTO_URL = "https://example.com/fake-turno-photo.png";
let uploadPhotoCalls = 0;

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
const TURNO_ID = crypto.randomUUID();

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const tokenFor = (tenantId) =>
  jwt.sign(
    { sub: crypto.randomUUID(), role: "admin", email: "test@example.com", tenant_id: tenantId },
    process.env.JWT_SECRET
  );

function createTurnosPoolMock() {
  const turnos = new Map([
    [TURNO_ID, { id: TURNO_ID, tenant_id: TENANT_ID, photo_url: null }]
  ]);

  const query = async (sql, params = []) => {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();

    if (q.startsWith("select status, suspended_reason from tenants")) {
      return { rowCount: 1, rows: [{ status: "active", suspended_reason: null }] };
    }
    if (q.startsWith("select 1 from agenda_turnos where id")) {
      const [id, tenantId] = params;
      const turno = turnos.get(id);
      return turno && turno.tenant_id === tenantId
        ? { rowCount: 1, rows: [{ "?column?": 1 }] }
        : { rowCount: 0, rows: [] };
    }
    if (q.startsWith("update agenda_turnos set photo_url")) {
      const [photoUrl, id, tenantId] = params;
      const turno = turnos.get(id);
      if (!turno || turno.tenant_id !== tenantId) return { rowCount: 0, rows: [] };
      turno.photo_url = photoUrl;
      return { rowCount: 1, rows: [{ ...turno }] };
    }

    throw new Error(`Unexpected SQL in agenda-photo test: ${sql}`);
  };

  return { query };
}

test("POST /agenda/:id/photo", async (t) => {
  const originalQuery = pool.query.bind(pool);
  pool.query = createTurnosPoolMock().query;

  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    pool.query = originalQuery;
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  const postPhoto = (token) =>
    fetch(`${baseUrl}/agenda/${TURNO_ID}/photo`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ image: `data:image/png;base64,${TINY_PNG_BASE64}` })
    });

  await t.test("el dueño del turno sube la foto normalmente", async () => {
    const res = await postPhoto(tokenFor(TENANT_ID));
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.photo_url, FAKE_PHOTO_URL);
    assert.equal(uploadPhotoCalls, 1);
  });

  await t.test("un turno de otro tenant da 404 y nunca sube nada a storage", async () => {
    const callsBefore = uploadPhotoCalls;
    const res = await postPhoto(tokenFor(crypto.randomUUID()));
    assert.equal(res.status, 404);
    assert.equal(uploadPhotoCalls, callsBefore);
  });
});
