// Cubre dos endurecimientos chicos:
// - jwt.verify ahora fija algorithms: ["HS256"] explícitamente, en vez de
//   confiar en el default de la librería.
// - las contraseñas nuevas (POST/PUT /v2/users, POST
//   /v2/super/tenants/:id/admin) exigen 8 caracteres como mínimo, igual
//   que el flujo de reseteo -antes aceptaban 6.
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

async function withServer(fn) {
  const originalQuery = pool.query.bind(pool);
  pool.query = async (sql, params = []) => {
    const authRow = handleAuthRevalidation(sql, params);
    if (authRow) return authRow;
    return { rowCount: 0, rows: [] };
  };

  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    pool.query = originalQuery;
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

test("jwt.verify rechaza un token firmado con alg none", async () => {
  await withServer(async (baseUrl) => {
    // jsonwebtoken exige explícitamente permitir "none" para poder firmar
    // con él (si no, tira). Armamos el token a mano para simular un
    // atacante que fuerza el algoritmo, no algo que la librería produzca.
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: crypto.randomUUID(), role: "admin", tenant_id: TENANT_ID })
    ).toString("base64url");
    const forgedToken = `${header}.${payload}.`;

    const res = await fetch(`${baseUrl}/v2/employees`, {
      headers: { authorization: `Bearer ${forgedToken}` }
    });
    assert.equal(res.status, 401);
  });
});

test("una contraseña de 6 caracteres ya no alcanza para crear un usuario", async () => {
  await withServer(async (baseUrl) => {
    const adminSub = registerUser({ role: "admin", tenant_id: TENANT_ID });
    const adminToken = jwt.sign(
      { sub: adminSub, role: "admin", email: "admin@test.com", tenant_id: TENANT_ID },
      process.env.JWT_SECRET
    );
    const res = await fetch(`${baseUrl}/v2/users`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ email: "nuevo@test.com", password: "corta1", role: "staff" })
    });
    assert.equal(res.status, 400);
  });
});
