// Cubre POST /v2/petshop/stock-movements: a diferencia del resto del módulo
// de PetShop (ventas), este endpoint buscaba y actualizaba el producto sin
// filtrar por tenant_id -un usuario del Tenant A que supiera/adivinara el
// UUID de un producto del Tenant B podía alterarle el stock y recibir de
// vuelta su costo/precio/proveedor (RETURNING *). El fix reusa lockProducts,
// el mismo helper tenant-scoped que ya usan las ventas.
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

const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();
const PRODUCT_OF_B = crypto.randomUUID();

const norm = (sql) => sql.replace(/\s+/g, " ").trim().toLowerCase();

const tokenFor = (tenantId) => {
  const sub = registerUser({ role: "admin", tenant_id: tenantId });
  return jwt.sign(
    { sub, role: "admin", email: "admin@test.com", tenant_id: tenantId },
    process.env.JWT_SECRET
  );
};

function createFakeDb() {
  const products = new Map([
    [PRODUCT_OF_B, { id: PRODUCT_OF_B, stock: 10, tenant_id: TENANT_B, cost: 500, price: 1200 }]
  ]);

  const query = async (sql, params = []) => {
    const authRow = handleAuthRevalidation(sql, params);
    if (authRow) return authRow;

    const q = norm(sql);

    if (q === "begin" || q === "commit" || q === "rollback") {
      return { rowCount: 0, rows: [] };
    }
    // lockProducts: SELECT id, stock FROM petshop_products WHERE id = ANY($1) AND tenant_id = $2 ... FOR UPDATE
    if (q.startsWith("select id, stock from petshop_products")) {
      const [ids, tenantId] = params;
      const rows = ids
        .map((id) => products.get(id))
        .filter((p) => p && p.tenant_id === tenantId)
        .map((p) => ({ id: p.id, stock: p.stock }));
      return { rowCount: rows.length, rows };
    }
    if (q.startsWith("update petshop_products set stock = $1")) {
      const [newStock, id, tenantId] = params;
      const product = products.get(id);
      if (!product || product.tenant_id !== tenantId) {
        return { rowCount: 0, rows: [] };
      }
      product.stock = newStock;
      return { rowCount: 1, rows: [{ ...product }] };
    }
    if (q.startsWith("insert into petshop_stock_movements")) {
      return { rowCount: 1, rows: [{ id: crypto.randomUUID(), ...params }] };
    }

    throw new Error(`Unexpected SQL in petshop-stock-movements test: ${sql}`);
  };

  return { query, products };
}

test("POST /v2/petshop/stock-movements respeta el aislamiento entre tenants", async (t) => {
  const originalQuery = pool.query.bind(pool);
  const originalConnect = pool.connect.bind(pool);
  const db = createFakeDb();
  // La ruta usa pool.connect() (transacción BEGIN/COMMIT/ROLLBACK), no
  // pool.query() directo -hay que mockear ambos o el connect() real intenta
  // conectarse a una base que no existe en el entorno de test.
  pool.query = (sql, params) => db.query(sql, params);
  pool.connect = async () => ({ query: (sql, params) => db.query(sql, params), release() {} });

  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  const postMovement = (tenantId, product_id) =>
    fetch(`${baseUrl}/v2/petshop/stock-movements`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor(tenantId)}` },
      body: JSON.stringify({ date: "2026-09-14", product_id, type: "in", quantity: 5 })
    });

  await t.test("un tenant no puede mover el stock de un producto de otro tenant", async () => {
    const res = await postMovement(TENANT_A, PRODUCT_OF_B);
    assert.equal(res.status, 400);
    // Y el stock real del producto de B no se tocó.
    assert.equal(db.products.get(PRODUCT_OF_B).stock, 10);
  });

  await t.test("el dueño del producto sí puede mover su propio stock", async () => {
    const res = await postMovement(TENANT_B, PRODUCT_OF_B);
    assert.equal(res.status, 201);
    assert.equal(db.products.get(PRODUCT_OF_B).stock, 15);
  });
});
