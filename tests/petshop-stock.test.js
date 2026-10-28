// Stock del PetShop con conteo, contra PostgreSQL embebido: la migración 030
// sobre datos anteriores, el historial de cada cambio, el conteo con motivo,
// la idempotencia de los reintentos, la revisión y el aislamiento por local.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import jwt from "jsonwebtoken";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://localhost:5432/unused";
process.env.JWT_SECRET ||= "test-secret";
const { app } = await import("../src/index.js");
const { pool } = await import("../src/db.js");

const uid = () => crypto.randomUUID();

async function createDb() {
  const db = new PGlite({ parsers: { 1082: (value) => value } });
  await db.exec(`
    CREATE TABLE tenants(id uuid PRIMARY KEY,status text DEFAULT 'active',suspended_reason text);
    CREATE TABLE employees(id uuid PRIMARY KEY,tenant_id uuid,status text,is_driver boolean);
    CREATE TABLE users(id uuid PRIMARY KEY,tenant_id uuid REFERENCES tenants(id),role text,email text,chofer_id uuid);
    CREATE TABLE petshop_products(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,sku text,category text,supplier_id uuid,
      cost numeric(12,2) NOT NULL DEFAULT 0,price numeric(12,2) NOT NULL,stock int NOT NULL DEFAULT 0,stock_min int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),tenant_id uuid NOT NULL REFERENCES tenants(id));
    CREATE TABLE petshop_sales(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),date date NOT NULL,customer_id uuid,stylist_id uuid,
      payment_method_id uuid NOT NULL,notes text,total numeric(12,2) NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),tenant_id uuid NOT NULL);
    CREATE TABLE petshop_sale_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sale_id uuid NOT NULL REFERENCES petshop_sales(id) ON DELETE CASCADE,
      product_id uuid NOT NULL REFERENCES petshop_products(id) ON DELETE RESTRICT,quantity int NOT NULL,unit_price numeric(12,2) NOT NULL,tenant_id uuid);
    CREATE TABLE petshop_stock_movements(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),date date NOT NULL,
      product_id uuid NOT NULL REFERENCES petshop_products(id) ON DELETE RESTRICT,type text NOT NULL CHECK (type IN ('in','out','adjust')),
      quantity int NOT NULL,note text,created_at timestamptz NOT NULL DEFAULT now(),tenant_id uuid NOT NULL REFERENCES tenants(id));
  `);
  let tail = Promise.resolve();
  const query = async (sql, params = []) => {
    const result = await db.query(sql, params);
    return { ...result, rowCount: result.affectedRows || result.rows.length };
  };
  return {
    db,
    query,
    async migrate() {
      const sql = await readFile(new URL("../db/migrations/030_petshop_stock_conteo.sql", import.meta.url), "utf8");
      await db.exec(sql);
    },
    async connect() {
      const previous = tail;
      let release;
      tail = new Promise((resolve) => { release = resolve; });
      await previous;
      return { query, release };
    },
  };
}

test("stock del PetShop: historial, conteo con motivo, revisión y aislamiento", async (t) => {
  const db = await createDb();
  const A = uid(), B = uid(), pm = uid(), legacyProduct = uid();
  await db.query("INSERT INTO tenants(id) VALUES($1),($2)", [A, B]);
  // Un movimiento anterior a la migración conserva su sentido.
  await db.query("INSERT INTO petshop_products(id,name,price,stock,tenant_id) VALUES($1,'Viejo',100,4,$2)", [legacyProduct, A]);
  await db.query("INSERT INTO petshop_stock_movements(date,product_id,type,quantity,tenant_id) VALUES('2026-01-02',$1,'in',4,$2)", [legacyProduct, A]);
  await db.migrate();
  await db.migrate(); // repetible
  const legacy = (await db.query("SELECT kind, delta, stock_after FROM petshop_stock_movements WHERE product_id=$1", [legacyProduct])).rows[0];
  assert.deepEqual(legacy, { kind: "ingreso", delta: null, stock_after: null });

  const tokens = {};
  for (const [key, role, tenant] of [["admin", "admin", A], ["staff", "staff", A], ["other", "admin", B]]) {
    const id = uid();
    await db.query("INSERT INTO users(id,tenant_id,role,email) VALUES($1,$2,$3,$4)", [id, tenant, role, `${key}@test.com`]);
    tokens[key] = jwt.sign({ sub: id, role, tenant_id: tenant }, process.env.JWT_SECRET);
  }

  const old = { query: pool.query, connect: pool.connect };
  pool.query = db.query;
  pool.connect = db.connect;
  const server = app.listen(0);
  await once(server, "listening");
  t.after(async () => {
    await new Promise((r) => server.close(r));
    Object.assign(pool, old);
    await db.db.close();
  });
  const request = async (path, method = "GET", body, key = "admin") => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokens[key]}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const move = (body, key) => request("/v2/petshop/stock/movements", "POST", body, key);
  const stockOf = async (id, key = "admin") => (await request("/v2/petshop/stock", "GET", undefined, key)).body.items.find((p) => p.id === id);

  // Alta con stock: queda el movimiento inicial, pero sigue sin contar.
  const created = await request("/v2/petshop/products", "POST", { name: "Shampoo", price: 5000, cost: 2000, stock: 10, stock_min: 3 });
  assert.equal(created.status, 201);
  const P = created.body.id;
  let item = await stockOf(P);
  assert.equal(item.stock, 10);
  assert.equal(item.last_counted_at, null);

  // Ingreso con costo.
  const ingreso = await move({ product_id: P, kind: "ingreso", quantity: 5, unit_cost: 2100 }, "staff");
  assert.equal(ingreso.status, 201);
  assert.equal(ingreso.body.stock, 15);
  assert.equal((await stockOf(P)).last_cost, 2100);

  // Conteo distinto sin motivo: se rechaza y devuelve el saldo del sistema.
  const sinMotivo = await move({ product_id: P, kind: "conteo", quantity: 13 });
  assert.equal(sinMotivo.status, 422);
  assert.equal(sinMotivo.body.stock, 15);
  assert.equal((await stockOf(P)).stock, 15);

  const clientId = uid();
  const conteo = await move({ client_id: clientId, product_id: P, kind: "conteo", quantity: 13, note: "Diferencia: Se rompió o se perdió" });
  assert.equal(conteo.status, 201);
  assert.equal(conteo.body.movement.delta, -2);
  assert.equal(conteo.body.movement.stock_after, 13);
  item = await stockOf(P);
  assert.equal(item.stock, 13);
  assert.ok(item.last_counted_at);

  // Reintento igual: no duplica. Mismo id con otro número: conflicto.
  const replay = await move({ client_id: clientId, product_id: P, kind: "conteo", quantity: 13, note: "Diferencia: Se rompió o se perdió" });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal((await move({ client_id: clientId, product_id: P, kind: "conteo", quantity: 12, note: "x" })).status, 409);
  assert.equal((await stockOf(P)).stock, 13);

  // Conteo que coincide: no pide motivo.
  assert.equal((await move({ product_id: P, kind: "conteo", quantity: 13 })).status, 201);

  // Baja: pide motivo.
  assert.equal((await move({ product_id: P, kind: "merma", quantity: 1 })).status, 422);
  assert.equal((await move({ product_id: P, kind: "merma", quantity: 1, note: "Vencido" })).body.stock, 12);
  assert.equal((await move({ product_id: P, kind: "ingreso", quantity: 0 })).status, 400);

  // Una venta descuenta y deja su movimiento atado a la venta.
  const sale = await request("/v2/petshop/sales", "POST", {
    date: "2026-10-20", payment_method_id: pm, total: 15000, items: [{ product_id: P, quantity: 3, unit_price: 5000 }],
  });
  assert.equal(sale.status, 201);
  assert.equal((await stockOf(P)).stock, 9);
  assert.equal((await stockOf(P)).sold_30d >= 0, true);

  // Editar el stock a mano deja un ajuste con la diferencia.
  assert.equal((await request(`/v2/petshop/products/${P}`, "PUT", { stock: 20 })).status, 200);

  // Borrar la venta devuelve lo vendido.
  assert.equal((await request(`/v2/petshop/sales/${sale.body.id}`, "DELETE")).status, 200);
  assert.equal((await stockOf(P)).stock, 23);

  const history = (await request(`/v2/petshop/stock/movements?product_id=${P}`)).body.items;
  assert.deepEqual(
    history.map((m) => [m.kind, m.delta, m.stock_after]).reverse(),
    [["inicial", 10, 10], ["ingreso", 5, 15], ["conteo", -2, 13], ["conteo", 0, 13], ["merma", -1, 12], ["venta", -3, 9], ["ajuste", 11, 20], ["devolucion", 3, 23]]
  );
  assert.equal(history.find((m) => m.kind === "ingreso").user_email, "staff@test.com");
  const onlyCounts = (await request(`/v2/petshop/stock/movements?kind=conteo`)).body.items;
  assert.equal(onlyCounts.length, 2);
  assert.equal((await request(`/v2/petshop/stock/movements?kind=robo`)).status, 400);

  // El endpoint anterior sigue funcionando y ahora deja tipo y saldo.
  const legacyPost = await request("/v2/petshop/stock-movements", "POST", { date: "2026-10-21", product_id: P, type: "adjust", quantity: 25 });
  assert.equal(legacyPost.status, 201);
  assert.equal(legacyPost.body.movement.kind, "ajuste");
  assert.equal(legacyPost.body.movement.delta, 2);
  assert.equal(legacyPost.body.product.stock, 25);

  // Revisión.
  const negative = (await request("/v2/petshop/products", "POST", { name: "Collar", price: 3000, cost: 1000 })).body.id;
  await move({ product_id: negative, kind: "merma", quantity: 2, note: "Roto" });
  const review = (await request("/v2/petshop/stock/review")).body;
  assert.deepEqual(review.negatives.map((p) => p.id), [negative]);
  assert.ok(review.never_counted.some((p) => p.id === negative));
  assert.ok(!review.never_counted.some((p) => p.id === P));
  assert.deepEqual(review.differences.map((d) => [d.product_id, d.delta]), [[P, -2]]);
  assert.equal(review.differences_value, -4000);

  // Otro local no ve ni toca nada.
  assert.equal((await move({ product_id: P, kind: "ingreso", quantity: 5 }, "other")).status, 404);
  assert.equal((await request("/v2/petshop/stock", "GET", undefined, "other")).body.items.length, 0);
  assert.equal((await request(`/v2/petshop/stock/movements?product_id=${P}`, "GET", undefined, "other")).body.items.length, 0);
  assert.equal((await stockOf(P)).stock, 25);

  // Un producto sin ventas se puede borrar aunque tenga historial.
  assert.equal((await request(`/v2/petshop/products/${negative}`, "DELETE")).status, 200);
});
