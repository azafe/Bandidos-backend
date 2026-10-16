import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import jwt from "jsonwebtoken";
import { createTrasladosDb } from "./helpers/trasladosDb.js";
import { cobradoEnPeriodo } from "../src/traslados.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://localhost:5432/unused";
process.env.JWT_SECRET ||= "test-secret";
const { app } = await import("../src/index.js");
const { pool } = await import("../src/db.js");
const uid = () => crypto.randomUUID();
const basePath = "/v2/traslados/historicos";
const cutoff = "2026-10-15";

test("importación histórica revisada por local, sin tocar hoy ni cambiar totales", async (t) => {
  const pg = await createTrasladosDb({ realAuth: true });
  const old = { query: pool.query, connect: pool.connect };
  pool.query = pg.query; pool.connect = pg.connect;
  const A = uid(), B = uid(), driver = uid();
  await pg.query("INSERT INTO tenants(id) VALUES($1),($2)", [A, B]);
  await pg.query("INSERT INTO employees(id,tenant_id,name,role,is_driver) VALUES($1,$2,'Jorge','Socio',true)", [driver, A]);
  const users = {};
  for (const [key, role, tenant, chofer] of [["admin", "admin", A, null], ["staff", "staff", A, null], ["driver", "staff", A, driver], ["other", "admin", B, null]]) {
    const id = uid();
    await pg.query("INSERT INTO users(id,tenant_id,role,chofer_id) VALUES($1,$2,$3,$4)", [id, tenant, role, chofer]);
    users[key] = { id, token: jwt.sign({ sub: id, role, tenant_id: tenant }, process.env.JWT_SECRET) };
  }
  const fixtures = [];
  async function seed(date, status, amount, bonificado, tenant = A, traslado = true) {
    const result = await pg.query(
      "INSERT INTO agenda_turnos(tenant_id,date,time,pet_name,owner_name,status,traslado,traslado_amount,traslado_bonificado,traslado_direccion) VALUES($1,$2,'10:00','Histórico','Ana',$3,$4,$5,$6,'San Martín 100') RETURNING *",
      [tenant, date, status, traslado, amount, bonificado],
    );
    fixtures.push(result.rows[0]); return result.rows[0];
  }
  await seed("2026-10-14", "finished", 7800.5, null);
  await seed(cutoff, "finished", 0, null);
  await seed(cutoff, "finished", 0, true);
  await seed(cutoff, "reserved", 11000, false);
  await seed(cutoff, "cancelled", 4000, null);
  await seed(cutoff, "no_show", 5000, null);
  await seed("2026-10-13", "finished", -100, null);
  await seed(cutoff, "finished", 3000, true);
  await seed(cutoff, "finished", 0, false);
  const today = await seed("2026-10-16", "finished", 9000, null);
  await seed("2026-10-17", "reserved", 7000, null);
  await seed(cutoff, "finished", 6000, null, A, false);
  const foreign = await seed(cutoff, "finished", 2222, null, B);
  const already = await seed(cutoff, "reserved", 7777, false);
  await pg.query("INSERT INTO traslado_solicitudes(tenant_id,turno_id,precio_total) VALUES($1,$2,7777)", [A, already.id]);
  const originalAgenda = (await pg.query("SELECT * FROM agenda_turnos ORDER BY id")).rows;
  const before = await cobradoEnPeriodo(pg, A, "2026-01-01", "2026-12-31");
  const server = app.listen(0); await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    Object.assign(pool, old); await pg.close();
  });
  async function request(path, method = "GET", body, key = "admin") {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { "Content-Type": "application/json", ...(users[key] ? { Authorization: `Bearer ${users[key].token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  const review = (key) => request(`${basePath}/revision?hasta=${cutoff}`, "GET", undefined, key);
  let preview, input;
  await t.test("revisión solo lectura, corte exacto, SQL y cantidades verificables", async () => {
    preview = await review();
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.resumen.cantidad, 9);
    assert.equal(preview.body.resumen.solicitudes, 9);
    assert.equal(preview.body.resumen.tramos, 9);
    assert.equal(preview.body.resumen.copias_historicas, 9);
    assert.equal(preview.body.resumen.ceros_sin_clasificar, 2);
    assert.equal(preview.body.resumen.importe_en_reportes, 10700.5);
    assert.ok(preview.body.items.every((r) => r.date <= cutoff));
    assert.ok(!preview.body.items.some((r) => [today.id, foreign.id, already.id].includes(r.id)));
    assert.match(preview.body.sql, /a.date <= DATE '2026-10-15'/);
    assert.match(preview.body.sql, /a.id=ANY\(\$4::uuid\[\]\)/);
    assert.equal((await pg.query("SELECT count(*)::int AS n FROM traslado_historicos")).rows[0].n, 0);
    input = { hasta: cutoff, revision: preview.body.revision, cantidad: 9, confirmar: true };
  });
  await t.test("permiso administrador, otro local y confirmación expresa", async () => {
    for (const key of ["none", "staff", "driver"]) {
      assert.equal((await review(key)).status, key === "none" ? 401 : 403);
      assert.equal((await request(`${basePath}/importar`, "POST", input, key)).status, key === "none" ? 401 : 403);
    }
    assert.equal((await review("other")).body.resumen.cantidad, 1);
    assert.equal((await request(`${basePath}/importar`, "POST", input, "other")).status, 409);
    for (const body of [{ ...input, confirmar: false }, { ...input, hasta: "2026-10-16" }, { ...input, cantidad: 0 }]) {
      assert.equal((await request(`${basePath}/importar`, "POST", body)).status, 400);
    }
    assert.equal((await request(`${basePath}/revision?hasta=2026-10-16`)).status, 400);
  });
  await t.test("un cambio posterior a la revisión impide importar con cantidad o datos viejos", async () => {
    await pg.query("UPDATE agenda_turnos SET traslado_amount=7900 WHERE id=$1", [fixtures[0].id]);
    assert.equal((await request(`${basePath}/importar`, "POST", input)).status, 409);
    assert.equal((await pg.query("SELECT count(*)::int AS n FROM traslado_historicos")).rows[0].n, 0);
    await pg.query("UPDATE agenda_turnos SET traslado_amount=$2 WHERE id=$1", [fixtures[0].id, fixtures[0].traslado_amount]);
    assert.equal((await request(`${basePath}/importar`, "POST", { ...input, cantidad: 8 })).status, 409);
  });
  await t.test("importación atómica y reintentos concurrentes no duplican registros", async () => {
    const results = await Promise.all([request(`${basePath}/importar`, "POST", input), request(`${basePath}/importar`, "POST", input)]);
    assert.ok(results.every((r) => r.status === 200), JSON.stringify(results));
    assert.deepEqual(results.map((r) => r.body.repetida).sort(), [false, true]);
    for (const table of ["traslado_historicos", "traslados"]) {
      assert.equal((await pg.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 9);
    }
    assert.equal((await review()).body.resumen.cantidad, 0);
    assert.deepEqual((await pg.query("SELECT * FROM agenda_turnos ORDER BY id")).rows, originalAgenda);
    assert.equal((await pg.query("SELECT count(*)::int AS n FROM traslado_cobros")).rows[0].n, 0);
  });
  await t.test("importes, bonificación desconocida y totales se conservan exactamente", async () => {
    const copies = (await pg.query("SELECT * FROM traslado_historicos ORDER BY turno_id")).rows;
    for (const copy of copies) {
      const source = fixtures.find((r) => r.id === copy.turno_id);
      assert.equal(copy.fecha, source.date);
      assert.equal(copy.turno_status, source.status);
      assert.equal(copy.monto, source.traslado_amount);
      assert.equal(copy.bonificado, source.traslado_bonificado);
      assert.equal(copy.direccion, source.traslado_direccion);
      assert.equal(copy.importado_por, users.admin.id);
    }
    assert.equal(await cobradoEnPeriodo(pg, A, "2026-01-01", "2026-12-31"), before);
    assert.equal(await cobradoEnPeriodo(pg, A, "2026-01-01", "2026-12-31", "chofer"), before);
    assert.equal(await cobradoEnPeriodo(pg, A, "2026-01-01", "2026-12-31", "local"), 0);
    assert.equal(await cobradoEnPeriodo(pg, B, "2026-01-01", "2026-12-31"), 2222);
    assert.equal((await request("/v2/daily-incomes/traslados-summary?date=2026-10-14")).body.amount, 7800.5);
    assert.equal((await request("/v2/daily-incomes/system-totals?date=2026-10-14")).body.some((r) => r.concept === "traslados"), false);
  });
  await t.test("historial separado de rutas: no inventa chofer, móvil, hora o estado", async () => {
    const tramos = (await pg.query("SELECT * FROM traslados")).rows;
    for (const tramo of tramos) {
      assert.equal(tramo.tipo, "ida_y_vuelta");
      for (const key of ["estado", "chofer_id", "vehiculo_id", "zona_id", "hora_programada", "orden_ruta"]) assert.equal(tramo[key], null);
    }
    const route = (await request("/v2/traslados/hoja-de-ruta?fecha=2026-10-15")).body;
    assert.equal(route.items.length, 0);
    assert.equal(route.historicos_pendientes, 0);
    assert.equal(route.historial.length, 7);
    const own = await request("/v2/traslados/hoja-de-ruta?fecha=2026-10-15", "GET", undefined, "driver");
    assert.deepEqual(own.body.historial, []);
    const current = (await request("/v2/traslados/hoja-de-ruta?fecha=2026-10-16")).body;
    assert.equal(current.historicos_pendientes, 1);
    assert.deepEqual(current.historial, []);
  });
  await t.test("históricos no admiten cobros, cambios de estado, cancelación ni reclasificación", async () => {
    const row = (await pg.query("SELECT * FROM traslado_historicos WHERE turno_id=$1", [fixtures[0].id])).rows[0];
    const tramo = (await pg.query("SELECT * FROM traslados WHERE solicitud_id=$1", [row.solicitud_id])).rows[0];
    const detail = await request(`/v2/traslado-solicitudes/${row.solicitud_id}`);
    assert.equal(detail.body.historico.bonificado, null);
    assert.equal((await request(`/v2/traslado-solicitudes/${row.solicitud_id}`, "DELETE")).status, 409);
    assert.equal((await request(`/v2/traslado-solicitudes/${row.solicitud_id}/cobro`, "POST", { fecha: cutoff, cobrado_por: "local", chofer_id: null, payment_method_id: uid() })).status, 409);
    assert.equal((await request(`/v2/traslados/${tramo.id}/estado`, "PATCH", { estado_anterior: "pendiente", estado: "en_camino" })).status, 409);
    assert.equal((await request(`/agenda/${row.turno_id}`, "PUT", { traslado_amount: 9999 })).status, 409);
    assert.equal((await request(`/agenda/${row.turno_id}`, "PUT", { status: "reserved" })).status, 409);
    assert.equal((await request(`/agenda/${row.turno_id}`, "PUT", { notes: "Nota del grooming" })).status, 200);
    assert.equal((await request(`/v2/traslado-solicitudes/${row.solicitud_id}`)).body.historico.monto, row.monto);
  });
  await t.test("un fallo de FK revierte todas las escrituras y permite reintentar", async () => {
    const added = await seed("2026-10-10", "finished", 5555, null);
    const newPreview = (await review()).body;
    const newInput = { hasta: cutoff, revision: newPreview.revision, cantidad: 1, confirmar: true };
    const query = pool.query;
    pool.query = async (sql, params) => {
      const result = await query(sql, params);
      if (sql.includes("SELECT u.role, u.tenant_id")) result.rows[0].tenant_id = A;
      return result;
    };
    // Un usuario de otro local no puede ser el responsable de la importación,
    // incluso si un error futuro en middleware le diera contexto equivocado.
    const response = await request(`${basePath}/importar`, "POST", newInput, "other");
    pool.query = query;
    assert.equal(response.status, 409);
    assert.equal((await pg.query("SELECT count(*)::int AS n FROM traslado_solicitudes WHERE turno_id=$1", [added.id])).rows[0].n, 0);
    assert.equal((await request(`${basePath}/importar`, "POST", newInput)).status, 200);
  });
});
