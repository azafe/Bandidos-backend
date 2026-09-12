// Cubre los tres bugs de aislamiento entre tenants encontrados en la auditoría:
// - /auth/register ya no crea usuarios sin tenant_id (estaba deshabilitado).
// - el campo role no acepta "super_admin" vía /v2/users (evita auto-escalar).
// - un usuario sin tenant_id (o de otro tenant) no puede leer ni tocar datos
//   de un tenant ajeno.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://localhost:5432/postgres";
process.env.JWT_SECRET ||= "test-secret";

const { app } = await import("../src/index.js");
const { pool } = await import("../src/db.js");
const jwt = (await import("jsonwebtoken")).default;

const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();
const USER_IN_B = crypto.randomUUID();

const norm = (sql) => sql.replace(/\s+/g, " ").trim().toLowerCase();

const signToken = (payload) => jwt.sign(payload, process.env.JWT_SECRET);

const adminTokenFor = (tenantId) =>
  signToken({ sub: crypto.randomUUID(), role: "admin", email: "admin@a.test", tenant_id: tenantId });

function createFakeDb() {
  const users = new Map([
    [USER_IN_B, { id: USER_IN_B, email: "victim@b.test", role: "staff", tenant_id: TENANT_B }]
  ]);

  const query = async (sql, params = []) => {
    const q = norm(sql);

    if (q.startsWith("select status, suspended_reason from tenants")) {
      return { rowCount: 1, rows: [{ status: "active", suspended_reason: null }] };
    }

    if (q.startsWith("update users set")) {
      const tenantId = params[params.length - 1];
      const id = params[params.length - 2];
      const user = users.get(id);
      if (!user || user.tenant_id !== tenantId) {
        return { rowCount: 0, rows: [] };
      }
      const setMatch = sql.match(/set\s+([\s\S]+?)\s+where/i);
      for (const assignment of setMatch[1].split(",")) {
        const [field] = assignment.split("=").map((s) => s.trim());
        const placeholder = assignment.match(/\$(\d+)/);
        if (field && placeholder) {
          user[field] = params[Number(placeholder[1]) - 1];
        }
      }
      return { rowCount: 1, rows: [{ id: user.id, email: user.email, role: user.role, created_at: user.created_at }] };
    }

    throw new Error(`Unexpected SQL in tenant-security test: ${sql}`);
  };

  return { query };
}

test("aislamiento entre tenants", async (t) => {
  const originalQuery = pool.query.bind(pool);
  let db = createFakeDb();
  pool.query = (sql, params) => db.query(sql, params);

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

  const requestJson = async (path, { method = "GET", token, body } = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  };

  await t.test("POST /auth/register está deshabilitado", async () => {
    const { status } = await requestJson("/auth/register", {
      method: "POST",
      body: { email: "nuevo@test.com", password: "abcdefg" }
    });
    assert.equal(status, 410);
  });

  await t.test("un token sin tenant_id no puede leer datos de negocio", async () => {
    const tokenSinTenant = signToken({
      sub: crypto.randomUUID(),
      role: "admin",
      email: "sin-tenant@test.com",
      tenant_id: null
    });
    const { status, body } = await requestJson("/v2/users", { token: tokenSinTenant });
    assert.equal(status, 403);
    assert.equal(body.message, "User has no tenant assigned");
  });

  await t.test("no se puede crear un usuario con role super_admin", async () => {
    const { status } = await requestJson("/v2/users", {
      method: "POST",
      token: adminTokenFor(TENANT_A),
      body: { email: "hacker@a.test", password: "abcdefg", role: "super_admin" }
    });
    assert.equal(status, 400);
  });

  await t.test("un admin de un tenant no puede editar un usuario de otro tenant", async () => {
    const { status } = await requestJson(`/v2/users/${USER_IN_B}`, {
      method: "PUT",
      token: adminTokenFor(TENANT_A),
      body: { role: "admin" }
    });
    assert.equal(status, 404);
  });

  await t.test("un admin sí puede editar un usuario de su propio tenant", async () => {
    const { status, body } = await requestJson(`/v2/users/${USER_IN_B}`, {
      method: "PUT",
      token: adminTokenFor(TENANT_B),
      body: { role: "admin" }
    });
    assert.equal(status, 200);
    assert.equal(body.role, "admin");
  });
});
