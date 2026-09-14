// Cubre dos fixes chicos pero importantes para la resiliencia del backend:
// - /auth/login ahora tiene rate limit (antes permitía fuerza bruta de
//   contraseñas a velocidad ilimitada, a diferencia de forgot-password).
// - pool.on("error") está registrado, así que un error de conexión en un
//   cliente ocioso no tira abajo el proceso entero.
import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://localhost:5432/postgres";
process.env.JWT_SECRET ||= "test-secret";

const { app } = await import("../src/index.js");
const { pool } = await import("../src/db.js");

test("pool.on('error') está registrado", () => {
  assert.ok(pool.listenerCount("error") > 0);
  // Si nadie escuchara "error", esto sería una excepción no capturada que
  // tumba el proceso de test entero -no algo que un try/catch alrededor
  // pueda atajar. Que el test siguiente corra confirma que no pasó.
  pool.emit("error", new Error("simulated idle client error"));
});

test("POST /auth/login tiene rate limit por IP y por email", async (t) => {
  const originalQuery = pool.query.bind(pool);
  pool.query = async () => {
    // Nunca debería llegar a consultar la base una vez agotado el cupo.
    return { rowCount: 0, rows: [] };
  };

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

  const login = (email) =>
    fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "cualquiera" })
    });

  await t.test("agotar el límite por email da 429, no 401", async () => {
    let lastStatus;
    for (let i = 0; i < 11; i += 1) {
      const res = await login("victima@test.com");
      lastStatus = res.status;
    }
    assert.equal(lastStatus, 429);
  });

  await t.test("un email distinto no está bloqueado por el límite del otro", async () => {
    const res = await login("otra-persona@test.com");
    assert.notEqual(res.status, 429);
  });
});
