// Cubre cierres parciales y aislamiento por local con el mismo doble de base
// que el resto de la API. Los históricos no se reclasifican al editar notas.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { signTokenFor, handleAuthRevalidation } from "./helpers/authRevalidation.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://localhost:5432/postgres";
process.env.JWT_SECRET ||= "test-secret";
const { app } = await import("../src/index.js");
const { pool } = await import("../src/db.js");
const A = crypto.randomUUID();
const B = crypto.randomUUID();
const PM = crypto.randomUUID();
const DATE = "2026-10-16";
const norm = (sql) => sql.replace(/\s+/g, " ").trim().toLowerCase();

function createDb() {
  const rows = new Map();
  const queries = [];
  const add = (overrides = {}) => {
    const row = { id: crypto.randomUUID(), tenant_id: A, date: DATE, time: "10:00", pet_name: "Luna", owner_name: "Ana", status: "reserved", traslado: true, traslado_amount: "0.00", traslado_bonificado: null, traslado_direccion: null, payment_method_id: PM, price: 27000, deposit_amount: 2000, ...overrides };
    rows.set(row.id, row);
    return row;
  };
  const query = async (sql, params = []) => {
    const auth = handleAuthRevalidation(sql, params);
    if (auth) return auth;
    const q = norm(sql);
    queries.push({ sql: q, params });
    if (["begin", "commit", "rollback"].includes(q)) return { rows: [], rowCount: 0 };
    if (q.startsWith("select * from agenda_turnos where id")) {
      assert.match(q, /tenant_id = \$2 for update/);
      const row = rows.get(params[0]);
      return row?.tenant_id === params[1] ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (q.startsWith("update agenda_turnos set")) {
      assert.match(q, /and tenant_id = \$\d+/);
      const row = rows.get(params.at(-2));
      if (!row || row.tenant_id !== params.at(-1)) return { rows: [], rowCount: 0 };
      for (const assignment of sql.match(/SET ([\s\S]+?)\s+WHERE/i)[1].split(",")) {
        const [, field, position] = assignment.trim().match(/^(\w+)\s*=\s*\$(\d+)$/);
        row[field] = params[Number(position) - 1];
      }
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (q.startsWith("insert into agenda_turnos")) {
      const fields = sql.match(/agenda_turnos\s*\(([^)]+)\)/i)[1].split(",").map((f) => f.trim());
      const row = add(Object.fromEntries(fields.map((field, i) => [field, params[i]])));
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (q.startsWith("insert into customers") || q.startsWith("insert into pets")) {
      return { rows: [{ id: crypto.randomUUID() }], rowCount: 1 };
    }
    if (q.startsWith("select coalesce(sum(traslado_amount)")) {
      assert.match(q, /where date = \$1 and tenant_id = \$2 and status = 'finished' and traslado = true/);
      assert.doesNotMatch(q, /payment_method_id/);
      const amount = [...rows.values()].filter((r) => r.date === params[0] && r.tenant_id === params[1] && r.status === "finished" && r.traslado).reduce((sum, r) => sum + Number(r.traslado_amount), 0);
      return { rows: [{ amount: String(amount) }], rowCount: 1 };
    }
    if (q.includes("group by")) {
      assert.match(q, /tenant_id = \$2/);
      assert.doesNotMatch(q, /traslado_amount/);
      if (q.includes("from services") || q.includes("from petshop_sales")) return { rows: [], rowCount: 0 };
      const isDeposit = q.includes("as payment_method_id, sum");
      const groups = new Map();
      for (const r of rows.values()) {
        if (r.tenant_id !== params[1] || r.date !== params[0] || !r.payment_method_id) continue;
        if (isDeposit ? r.status === "cancelled" : r.status !== "finished") continue;
        const amount = isDeposit ? r.deposit_amount : r.price - r.deposit_amount;
        groups.set(r.payment_method_id, (groups.get(r.payment_method_id) || 0) + amount);
      }
      return { rows: [...groups].map(([payment_method_id, total]) => ({ payment_method_id, total: String(total) })) };
    }
    throw new Error(`Consulta inesperada: ${sql}`);
  };
  let released = 0;
  return { rows, add, queries, query, connect: async () => ({ query, release: () => { released += 1; } }), get released() { return released; } };
}

test("traslados: cierre, caja y aislamiento por local", async (t) => {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  let db;
  pool.query = (...args) => db.query(...args);
  pool.connect = (...args) => db.connect(...args);
  const server = app.listen(0);
  await once(server, "listening");
  t.after(async () => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const tokenA = signTokenFor({ role: "admin", tenant_id: A }).token;
  const tokenB = signTokenFor({ role: "admin", tenant_id: B }).token;
  const request = async (path, { method = "GET", body, token = tokenA } = {}) => {
    const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const check = (name, fn) => t.test(name, async () => { db = createDb(); await fn(); });
  const update = (row, body, token) => request(`/agenda/${row.id}`, { method: "PUT", body, token });

  await check("no finaliza si falta el monto o es cero sin bonificación", async () => {
    for (const extra of [{}, { traslado_amount: "" }, { traslado_amount: 0 }, { traslado_amount: null }]) {
      const row = db.add();
      const result = await update(row, { status: "finished", ...extra });
      assert.equal(result.status, 400);
      assert.ok(result.body.errors.traslado_amount);
      assert.equal(row.status, "reserved");
    }
    assert.equal(db.released, 4);
  });
  await check("permite importe positivo guardado o enviado al finalizar", async () => {
    for (const stored of [0, "7800.50"]) {
      const row = db.add({ traslado_amount: stored });
      const result = await update(row, { status: "finished", ...(stored ? {} : { traslado_amount: 7800.50 }) });
      assert.equal(result.status, 200);
      assert.equal(Number(result.body.traslado_amount), 7800.50);
    }
    assert.equal(db.queries.filter((q) => q.sql === "commit").length, 2);
  });
  await check("bonificado exige decisión explícita y monto cero", async () => {
    const row = db.add();
    const result = await update(row, { status: "finished", traslado_bonificado: true, traslado_amount: 0 });
    assert.equal(result.status, 200);
    assert.equal(result.body.traslado_bonificado, true);
    assert.equal((await update(row, { traslado_amount: 7000 })).status, 400);
    assert.equal(Number(row.traslado_amount), 0);
    assert.equal((await update(row, { traslado_bonificado: false })).status, 400);
  });
  await check("no permite borrar el importe de un traslado finalizado", async () => {
    const row = db.add({ status: "finished", traslado_amount: 5000, traslado_bonificado: false });
    assert.equal((await update(row, { traslado_amount: 0 })).status, 400);
    assert.equal(Number(row.traslado_amount), 5000);
    assert.equal((await update(row, { traslado_amount: 0, traslado_bonificado: true })).status, 200);
  });
  await check("agregar traslado a un turno finalizado también exige importe", async () => {
    const row = db.add({ status: "finished", traslado: false });
    assert.equal((await update(row, { traslado: true })).status, 400);
    assert.equal((await update(row, { traslado: true, traslado_amount: 9000 })).status, 200);
  });
  await check("conserva históricos al editar notas o reenviar valores iguales", async () => {
    const row = db.add({ status: "finished" });
    assert.equal((await update(row, { notes: "Dato corregido" })).status, 200);
    assert.equal((await update(row, { status: "finished", traslado: true, traslado_amount: 0 })).status, 200);
    assert.equal(row.traslado_bonificado, null);
    assert.equal((await update(row, { traslado_direccion: "Otra dirección" })).status, 400);
  });
  await check("sin traslado o en reserva no obliga a indicar importe", async () => {
    assert.equal((await update(db.add({ traslado: false }), { status: "finished" })).status, 200);
    assert.equal((await update(db.add(), { traslado_direccion: "San Martín 100" })).status, 200);
  });
  await check("rechaza negativos, infinitos y bonificaciones que no son booleanos", async () => {
    const row = db.add();
    for (const body of [{ traslado_amount: -1 }, { traslado_amount: "Infinity" }, { traslado_amount: "texto" }, { traslado_bonificado: "false" }]) {
      assert.equal((await update(row, body)).status, 400);
    }
  });
  await check("un error de escritura revierte la transacción y libera la conexión", async () => {
    const row = db.add();
    const connect = db.connect;
    db.connect = async () => {
      const client = await connect();
      return { ...client, query: async (sql, params) => {
        if (norm(sql).startsWith("update agenda_turnos set")) throw new Error("Fallo simulado de escritura");
        return client.query(sql, params);
      } };
    };
    const result = await update(row, { status: "finished", traslado_amount: 8000 });
    assert.equal(result.status, 500);
    assert.equal(row.status, "reserved");
    assert.equal(db.queries.at(-1).sql, "rollback");
    assert.equal(db.released, 1);
  });
  await check("otro local no puede finalizar ni editar el traslado", async () => {
    const row = db.add();
    assert.equal((await update(row, { status: "finished", traslado_amount: 8000 }, tokenB)).status, 404);
    assert.equal((await update(row, { notes: "Ajeno" }, tokenB)).status, 404);
    assert.equal(row.status, "reserved");
  });
  for (const path of ["/agenda", "/v2/agenda/with-new-pet"]) {
    await check(`${path}: valida también las altas finalizadas y conserva el local autenticado`, async () => {
      const payload = { date: DATE, time: "09:00", pet_name: "Milo", owner_name: "César", status: "finished", traslado: true };
      for (const extra of [{}, { traslado_amount: 0 }, { traslado_amount: 100, traslado_bonificado: true }]) {
        assert.equal((await request(path, { method: "POST", body: { ...payload, ...extra } })).status, 400);
      }
      assert.equal(db.rows.size, 0);
      for (const extra of [{ traslado_amount: 6000 }, { traslado_amount: 0, traslado_bonificado: true }, { status: "reserved" }]) {
        const result = await request(path, { method: "POST", token: tokenB, body: { ...payload, tenant_id: A, ...extra } });
        assert.equal(result.status, 201);
        assert.equal(result.body.tenant_id, B);
        assert.equal(result.body.traslado_bonificado, extra.traslado_bonificado ?? false);
      }
    });
  }
  await check("resumen informativo incluye sin medio de pago y excluye otros días, estados y locales", async () => {
    db.add({ status: "finished", traslado_amount: 5000 });
    db.add({ status: "finished", traslado_amount: 3000, payment_method_id: null });
    db.add({ status: "finished", traslado_amount: 0, traslado_bonificado: true });
    db.add({ status: "cancelled", traslado_amount: 100 });
    db.add({ traslado_amount: 100 });
    db.add({ status: "finished", traslado: false, traslado_amount: 100 });
    db.add({ status: "finished", tenant_id: B, traslado_amount: 9000 });
    db.add({ status: "finished", date: "2026-10-15", traslado_amount: 100 });
    assert.deepEqual((await request(`/v2/daily-incomes/traslados-summary?date=${DATE}`)).body, { amount: 8000 });
    assert.deepEqual((await request(`/v2/daily-incomes/traslados-summary?date=${DATE}`, { token: tokenB })).body, { amount: 9000 });
    assert.deepEqual((await request('/v2/daily-incomes/traslados-summary?date=2026-10-14')).body, { amount: 0 });
  });
  await check("system-totals conserva servicios y señas, excluye traslados y otros locales", async () => {
    db.add({ status: "finished", traslado_amount: 8000 });
    db.add({ tenant_id: B, status: "finished", price: 99999, traslado_amount: 9000 });
    const result = await request(`/v2/daily-incomes/system-totals?date=${DATE}`);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, [{ concept: "servicios", payment_method_id: PM, amount: 25000 }, { concept: "señas", payment_method_id: PM, amount: 2000 }]);
    assert.equal(result.body.reduce((total, r) => total + r.amount, 0), 27000);
    const other = await request(`/v2/daily-incomes/system-totals?date=${DATE}`, { token: tokenB });
    assert.equal(other.body.reduce((total, r) => total + r.amount, 0), 99999);
  });
  await check("ambos resúmenes requieren autenticación y una fecha", async () => {
    for (const path of ["system-totals", "traslados-summary"]) {
      const basePath = `/v2/daily-incomes/${path}`;
      assert.equal((await request(`${basePath}?date=${DATE}`, { token: null })).status, 401);
      assert.equal((await request(basePath)).status, 400);
      assert.equal((await request(`${basePath}?date=incorrecta`)).status, 400);
      const noTenant = signTokenFor({ role: "admin", tenant_id: null }).token;
      assert.equal((await request(`${basePath}?date=${DATE}`, { token: noTenant })).status, 403);
    }
  });
});
