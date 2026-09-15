// Cubre la revalidación de rol/tenant en cada request (src/index.js, el
// middleware que corre justo después de requireAuth): el JWT dura 7 días,
// así que sin esto un cambio de rol, una baja de usuario o una suspensión
// de tenant tardarían hasta 7 días en aplicarse -el token viejo seguiría
// siendo válido y con los permisos de antes. Estos tests prueban que el
// MISMO token, sin volver a loguearse, refleja el cambio en el siguiente
// request.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { registerUser, updateUser, removeUser, handleAuthRevalidation } from "./helpers/authRevalidation.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://localhost:5432/postgres";
process.env.JWT_SECRET ||= "test-secret";

const { app } = await import("../src/index.js");
const { pool } = await import("../src/db.js");
const jwt = (await import("jsonwebtoken")).default;

const norm = (sql) => sql.replace(/\s+/g, " ").trim().toLowerCase();
const EXISTING_ID = crypto.randomUUID();

// Igual que la query real de revalidación (SELECT u.role, u.tenant_id, t.status
// AS tenant_status, t.suspended_reason FROM users u LEFT JOIN tenants t ...),
// pero manejada acá con el propio registro de authRevalidation.js para poder
// simular cambios mid-test con updateUser()/removeUser().
async function fakeQuery(sql, params = []) {
  const authRow = handleAuthRevalidation(sql, params);
  if (authRow) return authRow;

  const q = norm(sql);
  // Cualquier SELECT/INSERT/UPDATE/DELETE de negocio: alcanza con no explotar,
  // lo que importa acá es si el middleware de auth deja pasar o no.
  if (q.startsWith("select") || q.startsWith("insert") || q.startsWith("update") || q.startsWith("delete")) {
    return { rowCount: 1, rows: [{ id: EXISTING_ID }] };
  }
  throw new Error(`Unexpected SQL in jwt-revalidation test: ${sql}`);
}

test("revalidación de rol/tenant en cada request", async (t) => {
  const originalQuery = pool.query.bind(pool);
  pool.query = fakeQuery;

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

  const request = (method, path, token) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: method === "GET" ? undefined : JSON.stringify({ name: "Ana", role: "Groomer", status: "active" })
    });

  await t.test("un ascenso de staff a admin se aplica sin volver a loguearse", async () => {
    const tenantId = crypto.randomUUID();
    const sub = registerUser({ role: "staff", tenant_id: tenantId });
    const token = jwt.sign({ sub, role: "staff", email: "s@test.com", tenant_id: tenantId }, process.env.JWT_SECRET);

    const before = await request("POST", "/v2/employees", token);
    assert.equal(before.status, 403, "staff no puede crear empleados todavía");

    updateUser(sub, { role: "admin" });

    const after = await request("POST", "/v2/employees", token);
    assert.notEqual(after.status, 403, "el MISMO token ya debería poder, sin re-loguearse");
  });

  await t.test("borrar el usuario invalida su token vigente al toque", async () => {
    const tenantId = crypto.randomUUID();
    const sub = registerUser({ role: "admin", tenant_id: tenantId });
    const token = jwt.sign({ sub, role: "admin", email: "a@test.com", tenant_id: tenantId }, process.env.JWT_SECRET);

    const before = await request("GET", "/v2/employees", token);
    assert.equal(before.status, 200);

    removeUser(sub);

    const after = await request("GET", "/v2/employees", token);
    assert.equal(after.status, 401, "el token firmado sigue siendo válido, pero el usuario ya no existe");
  });

  await t.test("suspender el tenant bloquea el token vigente al toque", async () => {
    const tenantId = crypto.randomUUID();
    const sub = registerUser({ role: "admin", tenant_id: tenantId, status: "active" });
    const token = jwt.sign({ sub, role: "admin", email: "a2@test.com", tenant_id: tenantId }, process.env.JWT_SECRET);

    const before = await request("GET", "/v2/employees", token);
    assert.equal(before.status, 200);

    updateUser(sub, { status: "suspended", suspended_reason: "Falta de pago" });

    const after = await request("GET", "/v2/employees", token);
    assert.equal(after.status, 403);
    const body = await after.json();
    assert.equal(body.message, "Tenant is inactive");
    assert.equal(body.suspended_reason, "Falta de pago");
  });
});
