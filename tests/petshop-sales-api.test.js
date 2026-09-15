// Cubre PUT y DELETE de ventas de PetShop. Lo delicado no es el CRUD sino el
// stock: editar una venta tiene que mover el inventario por la DIFERENCIA, y
// borrarla tiene que devolver todo lo vendido.
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
const OTHER_TENANT_ID = crypto.randomUUID();
const SALE_ID = crypto.randomUUID();
const SHAMPOO_ID = crypto.randomUUID();
const COLLAR_ID = crypto.randomUUID();
const PAYMENT_METHOD_ID = crypto.randomUUID();

const signToken = (tenantId) => {
  const sub = registerUser({ role: "admin", tenant_id: tenantId });
  return jwt.sign(
    { sub, role: "admin", email: "test@example.com", tenant_id: tenantId },
    process.env.JWT_SECRET
  );
};

const norm = (sql) => sql.replace(/\s+/g, " ").trim().toLowerCase();

// Base en memoria con transacciones de verdad: BEGIN saca una foto del estado y
// ROLLBACK la restaura. Sin eso no se puede afirmar que un error deja el stock
// como estaba.
function createFakeDb() {
  const state = {
    products: new Map([
      [SHAMPOO_ID, { id: SHAMPOO_ID, stock: 10, tenant_id: TENANT_ID }],
      [COLLAR_ID, { id: COLLAR_ID, stock: 5, tenant_id: TENANT_ID }]
    ]),
    sales: new Map([
      [
        SALE_ID,
        {
          id: SALE_ID,
          date: "2026-08-01",
          customer_id: null,
          stylist_id: null,
          payment_method_id: PAYMENT_METHOD_ID,
          notes: null,
          total: 3000,
          tenant_id: TENANT_ID
        }
      ]
    ]),
    // La venta original: 2 shampoos a 1000 y 1 collar a 1000.
    items: [
      { id: 1, sale_id: SALE_ID, product_id: SHAMPOO_ID, quantity: 2, unit_price: 1000 },
      { id: 2, sale_id: SALE_ID, product_id: COLLAR_ID, quantity: 1, unit_price: 1000 }
    ]
  };
  let nextItemId = 3;
  let snapshot = null;

  const clone = () => ({
    products: new Map([...state.products].map(([k, v]) => [k, { ...v }])),
    sales: new Map([...state.sales].map(([k, v]) => [k, { ...v }])),
    items: state.items.map((i) => ({ ...i }))
  });

  const restore = (snap) => {
    state.products = snap.products;
    state.sales = snap.sales;
    state.items = snap.items;
  };

  const query = async (sql, params = []) => {
    const authRow = handleAuthRevalidation(sql, params);
    if (authRow) return authRow;

    const q = norm(sql);

    if (q === "begin") {
      snapshot = clone();
      return { rowCount: 0, rows: [] };
    }
    if (q === "commit") {
      snapshot = null;
      return { rowCount: 0, rows: [] };
    }
    if (q === "rollback") {
      if (snapshot) restore(snapshot);
      snapshot = null;
      return { rowCount: 0, rows: [] };
    }

    if (q.startsWith("select * from petshop_sales where id")) {
      const [id, tenantId] = params;
      const sale = state.sales.get(id);
      if (!sale || sale.tenant_id !== tenantId) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [{ ...sale }] };
    }

    if (q.startsWith("select id from petshop_sales where id")) {
      const [id, tenantId] = params;
      const sale = state.sales.get(id);
      if (!sale || sale.tenant_id !== tenantId) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [{ id: sale.id }] };
    }

    if (q.startsWith("select product_id, quantity, unit_price from petshop_sale_items")) {
      const [saleId] = params;
      const rows = state.items
        .filter((i) => i.sale_id === saleId)
        .sort((a, b) => a.id - b.id)
        .map(({ product_id, quantity, unit_price }) => ({ product_id, quantity, unit_price }));
      return { rowCount: rows.length, rows };
    }

    if (q.startsWith("select id, stock from petshop_products")) {
      const [ids, tenantId] = params;
      const rows = ids
        .map((id) => state.products.get(id))
        .filter((p) => p && p.tenant_id === tenantId)
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .map(({ id, stock }) => ({ id, stock }));
      return { rowCount: rows.length, rows };
    }

    if (q.startsWith("update petshop_products set stock = stock +")) {
      const [delta, productId, tenantId] = params;
      const product = state.products.get(productId);
      if (!product || product.tenant_id !== tenantId) return { rowCount: 0, rows: [] };
      product.stock += Number(delta);
      return { rowCount: 1, rows: [{ ...product }] };
    }

    if (q.startsWith("delete from petshop_sale_items where sale_id")) {
      const [saleId] = params;
      state.items = state.items.filter((i) => i.sale_id !== saleId);
      return { rowCount: 0, rows: [] };
    }

    if (q.startsWith("insert into petshop_sale_items")) {
      const [saleId, productId, quantity, unitPrice] = params;
      const row = {
        id: nextItemId++,
        sale_id: saleId,
        product_id: productId,
        quantity: Number(quantity),
        unit_price: Number(unitPrice)
      };
      state.items.push(row);
      return { rowCount: 1, rows: [{ ...row }] };
    }

    if (q.startsWith("update petshop_sales set")) {
      // "update petshop_sales set date = $1, total = $2 where id = $3 and ..."
      const setPart = q.slice(q.indexOf("set ") + 4, q.indexOf(" where "));
      const fields = setPart.split(",").map((f) => f.split("=")[0].trim());
      const sale = state.sales.get(params[params.length - 2]);
      const tenantId = params[params.length - 1];
      if (!sale || sale.tenant_id !== tenantId) return { rowCount: 0, rows: [] };
      fields.forEach((field, i) => {
        sale[field] = params[i];
      });
      return { rowCount: 1, rows: [{ ...sale }] };
    }

    if (q.startsWith("delete from petshop_sales where id")) {
      const [id, tenantId] = params;
      const sale = state.sales.get(id);
      if (!sale || sale.tenant_id !== tenantId) return { rowCount: 0, rows: [] };
      state.sales.delete(id);
      state.items = state.items.filter((i) => i.sale_id !== id);
      return { rowCount: 1, rows: [] };
    }

    throw new Error(`SQL inesperado en el test de ventas: ${sql}`);
  };

  return { state, query };
}

const requestJson = async (baseUrl, path, { method = "GET", body, token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
};

test("PUT y DELETE /v2/petshop/sales/:id", async (t) => {
  const originalQuery = pool.query.bind(pool);
  const originalConnect = pool.connect.bind(pool);
  let db = createFakeDb();

  pool.query = (sql, params) => db.query(sql, params);
  pool.connect = async () => ({ query: (sql, params) => db.query(sql, params), release() {} });

  const server = app.listen(0);
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const token = signToken(TENANT_ID);

  t.after(async () => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  t.beforeEach(() => {
    db = createFakeDb();
  });

  await t.test("editar la cantidad mueve el stock solo por la diferencia", async () => {
    // 2 shampoos -> 3: el stock baja 1 (de 10 a 9), no 3.
    const { status, body } = await requestJson(baseUrl, `/v2/petshop/sales/${SALE_ID}`, {
      method: "PUT",
      token,
      body: {
        date: "2026-08-01",
        payment_method_id: PAYMENT_METHOD_ID,
        total: 4000,
        items: [
          { product_id: SHAMPOO_ID, quantity: 3, unit_price: 1000 },
          { product_id: COLLAR_ID, quantity: 1, unit_price: 1000 }
        ]
      }
    });

    assert.equal(status, 200);
    assert.equal(db.state.products.get(SHAMPOO_ID).stock, 9);
    assert.equal(db.state.products.get(COLLAR_ID).stock, 5, "el collar no cambió: no se toca");
    assert.equal(Number(body.total), 4000);
  });

  await t.test("sacar un producto de la venta le devuelve el stock", async () => {
    const { status } = await requestJson(baseUrl, `/v2/petshop/sales/${SALE_ID}`, {
      method: "PUT",
      token,
      body: {
        payment_method_id: PAYMENT_METHOD_ID,
        items: [{ product_id: SHAMPOO_ID, quantity: 2, unit_price: 1000 }]
      }
    });

    assert.equal(status, 200);
    assert.equal(db.state.products.get(SHAMPOO_ID).stock, 10, "misma cantidad: sin movimiento");
    assert.equal(db.state.products.get(COLLAR_ID).stock, 6, "el collar volvió al inventario");
  });

  await t.test("si cambian los ítems y no mandan total, se recalcula", async () => {
    const { status, body } = await requestJson(baseUrl, `/v2/petshop/sales/${SALE_ID}`, {
      method: "PUT",
      token,
      body: {
        items: [{ product_id: SHAMPOO_ID, quantity: 4, unit_price: 1500 }]
      }
    });

    assert.equal(status, 200);
    assert.equal(Number(body.total), 6000);
  });

  await t.test("un producto inexistente da 400 y no toca el stock", async () => {
    const { status } = await requestJson(baseUrl, `/v2/petshop/sales/${SALE_ID}`, {
      method: "PUT",
      token,
      body: {
        items: [{ product_id: crypto.randomUUID(), quantity: 1, unit_price: 500 }]
      }
    });

    assert.equal(status, 400);
    assert.equal(db.state.products.get(SHAMPOO_ID).stock, 10);
    assert.equal(db.state.products.get(COLLAR_ID).stock, 5);
    assert.equal(db.state.items.length, 2, "los ítems originales siguen ahí");
  });

  await t.test("no se puede editar una venta de otro tenant", async () => {
    const { status } = await requestJson(baseUrl, `/v2/petshop/sales/${SALE_ID}`, {
      method: "PUT",
      token: signToken(OTHER_TENANT_ID),
      body: { total: 999999 }
    });

    assert.equal(status, 404);
    assert.equal(Number(db.state.sales.get(SALE_ID).total), 3000);
  });

  await t.test("borrar la venta devuelve todo el stock vendido", async () => {
    const { status } = await requestJson(baseUrl, `/v2/petshop/sales/${SALE_ID}`, {
      method: "DELETE",
      token
    });

    assert.equal(status, 200);
    assert.equal(db.state.products.get(SHAMPOO_ID).stock, 12);
    assert.equal(db.state.products.get(COLLAR_ID).stock, 6);
    assert.equal(db.state.sales.has(SALE_ID), false);
  });

  await t.test("borrar una venta de otro tenant da 404 y no mueve nada", async () => {
    const { status } = await requestJson(baseUrl, `/v2/petshop/sales/${SALE_ID}`, {
      method: "DELETE",
      token: signToken(OTHER_TENANT_ID)
    });

    assert.equal(status, 404);
    assert.equal(db.state.sales.has(SALE_ID), true);
    assert.equal(db.state.products.get(SHAMPOO_ID).stock, 10);
  });
});
