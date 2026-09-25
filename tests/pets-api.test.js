import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { registerUser, handleAuthRevalidation } from "./helpers/authRevalidation.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://localhost:5432/postgres";
process.env.JWT_SECRET ||= "test-secret";

const { app } = await import("../src/index.js");
const { pool } = await import("../src/db.js");
const jwt = (await import("jsonwebtoken")).default;

const TENANT_ID = crypto.randomUUID();
const PET_WITH_TURNOS = crypto.randomUUID();
const PET_WITHOUT_TURNOS = crypto.randomUUID();

function signTestToken() {
  const sub = registerUser({ role: "admin", tenant_id: TENANT_ID });
  return jwt.sign(
    { sub, role: "admin", email: "test@example.com", tenant_id: TENANT_ID },
    process.env.JWT_SECRET
  );
}

// Guarda cada SQL que llega para poder afirmar sobre su forma.
function createPoolMock() {
  const calls = [];
  const deleted = [];
  const query = async (sql, params = []) => {
    const authRow = handleAuthRevalidation(sql, params);
    if (authRow) return authRow;
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    calls.push({ sql: normalized, params });

    if (normalized.startsWith("select p.*")) {
      return { rowCount: 1, rows: [{ id: PET_WITH_TURNOS, services_count: 3 }] };
    }
    if (normalized.startsWith("select * from agenda_turnos where pet_id")) {
      return { rowCount: 1, rows: [{ id: "t1", pet_id: params[0], status: "finished" }] };
    }
    if (normalized.startsWith("select count(*)::int as count from agenda_turnos")) {
      const count = params[0] === PET_WITH_TURNOS ? 4 : 0;
      return { rowCount: 1, rows: [{ count }] };
    }
    if (normalized.startsWith("delete from pets")) {
      deleted.push(params[0]);
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected SQL in pets-api test: ${sql}`);
  };
  return { query, calls, deleted };
}

async function requestJson(baseUrl, path, { method = "GET", token } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: response.status, body: await response.json() };
}

test("pets API", async (t) => {
  const originalQuery = pool.query.bind(pool);
  const mockPool = createPoolMock();
  pool.query = mockPool.query;

  const server = app.listen(0);
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const token = signTestToken();

  t.after(async () => {
    pool.query = originalQuery;
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  await t.test("search matches owner name and phone digits", async () => {
    mockPool.calls.length = 0;
    const { status } = await requestJson(baseUrl, `/v2/pets?q=${encodeURIComponent("381 688")}`, { token });
    assert.equal(status, 200);
    const { sql, params } = mockPool.calls.at(-1);
    assert.match(sql, /p\.owner_name ilike/);
    assert.match(sql, /regexp_replace\(coalesce\(p\.owner_phone/);
    assert.ok(params.includes("%381688%"), "phone compared by digits only");
  });

  await t.test("text-only search does not add the phone condition", async () => {
    mockPool.calls.length = 0;
    await requestJson(baseUrl, "/v2/pets?q=Rocco", { token });
    const { sql } = mockPool.calls.at(-1);
    assert.doesNotMatch(sql, /regexp_replace/);
  });

  await t.test("list and detail share the same stats definition", async () => {
    mockPool.calls.length = 0;
    await requestJson(baseUrl, "/v2/pets", { token });
    await requestJson(baseUrl, `/v2/pets/${PET_WITH_TURNOS}`, { token });
    const [list, detail] = mockPool.calls.map((c) => c.sql);
    for (const sql of [list, detail]) {
      assert.match(sql, /count\(\*\) filter \(where status = 'finished'\)::int as services_count/);
      assert.match(sql, /sum\(price\) filter \(where status = 'finished'\)/);
    }
  });

  await t.test("GET /v2/pets/:id/turnos returns only that pet's turnos", async () => {
    const { status, body } = await requestJson(baseUrl, `/v2/pets/${PET_WITH_TURNOS}/turnos`, { token });
    assert.equal(status, 200);
    assert.equal(body[0].pet_id, PET_WITH_TURNOS);
  });

  await t.test("DELETE is refused when the pet has turnos", async () => {
    const { status, body } = await requestJson(baseUrl, `/v2/pets/${PET_WITH_TURNOS}`, {
      method: "DELETE",
      token,
    });
    assert.equal(status, 409);
    assert.match(body.message, /4 turnos registrados/);
    assert.equal(mockPool.deleted.length, 0);
  });

  await t.test("DELETE goes through when the pet has no turnos", async () => {
    const { status } = await requestJson(baseUrl, `/v2/pets/${PET_WITHOUT_TURNOS}`, {
      method: "DELETE",
      token,
    });
    assert.equal(status, 200);
    assert.deepEqual(mockPool.deleted, [PET_WITHOUT_TURNOS]);
  });
});
