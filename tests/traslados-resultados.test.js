import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import jwt from "jsonwebtoken";
import { createTrasladosDb } from "./helpers/trasladosDb.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://localhost:5432/unused";
process.env.JWT_SECRET ||= "test-secret";
const { app } = await import("../src/index.js");
const { pool } = await import("../src/db.js");
const uid = () => crypto.randomUUID();
const base = "/v2/traslados/resultados";
const range = { from: "2026-10-01", to: "2026-10-31" };
const date = "2026-10-17";

test("resultados de Bandimóviles: cuentas, revisión y permisos sobre PostgreSQL", async (t) => {
  const db = await createTrasladosDb({ realAuth: true });
  const old = { query: pool.query, connect: pool.connect };
  pool.query = db.query; pool.connect = db.connect;
  const A = uid(), B = uid(), driver = uid(), vehicle = uid(), vehicle2 = uid(), foreignVehicle = uid(), cat = uid(), foreignCat = uid(), pm = uid();
  await db.query("INSERT INTO tenants(id) VALUES($1),($2)", [A, B]);
  await db.query("INSERT INTO employees(id,tenant_id,name,role,is_driver) VALUES($1,$2,'Jorge','Socio',true)", [driver, A]);
  await db.query("INSERT INTO vehiculos(id,tenant_id,nombre,patente) VALUES($1,$2,'Móvil 1','AA'),($3,$2,'Móvil 2','BB'),($4,$5,'Ajeno','CC')", [vehicle, A, vehicle2, foreignVehicle, B]);
  await db.query("INSERT INTO expense_categories(id,tenant_id,name) VALUES($1,$2,'Traslados'),($3,$4,'Ajena')", [cat, A, foreignCat, B]);
  await db.query("INSERT INTO payment_methods(id,tenant_id,name) VALUES($1,$2,'Efectivo')", [pm, A]);
  const tokens = {}, users = {};
  for (const [key, role, tenant, chofer] of [["admin", "admin", A, null], ["staff", "staff", A, null], ["driver", "staff", A, driver], ["other", "admin", B, null]]) {
    const id = uid(); users[key] = id;
    await db.query("INSERT INTO users(id,tenant_id,role,chofer_id) VALUES($1,$2,$3,$4)", [id, tenant, role, chofer]);
    tokens[key] = jwt.sign({ sub: id, role, tenant_id: tenant }, process.env.JWT_SECRET);
  }
  const server = app.listen(0); await once(server, "listening");
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); Object.assign(pool, old); await db.close(); });
  const request = async (path = "", method = "GET", body, key = "admin") => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${base}${path}`, { method,
      headers: { "Content-Type": "application/json", ...(tokens[key] ? { Authorization: `Bearer ${tokens[key]}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const report = (key = "admin", q = range) => request(`?${new URLSearchParams(q)}`, "GET", undefined, key);
  const confirm = async () => { const r = await report(); return request("/revision-gastos", "POST", { ...range, revision: r.body.gastos.revision, confirmar: true }); };
  async function seed({ price = 8000, cfg = null, vehicles = [vehicle, vehicle], fechas = [date, date], states = ["entregado", "entregado"], receipt = date, bonificado = false } = {}) {
    const turno = uid(), solicitud = uid();
    await db.query("INSERT INTO agenda_turnos(id,tenant_id,date,time,pet_name,status,traslado,traslado_amount) VALUES($1,$2,$3,'10:00','Luna','finished',true,$4)", [turno, A, date, price]);
    await db.query("INSERT INTO traslado_solicitudes(id,tenant_id,turno_id,precio_total,bonificado,configuracion_id) VALUES($1,$2,$3,$4,$5,$6)", [solicitud, A, turno, price, bonificado, cfg]);
    for (let i = 0; i < vehicles.length; i++) await db.query("INSERT INTO traslados(tenant_id,solicitud_id,tipo,chofer_id,vehiculo_id,fecha_programada,estado) VALUES($1,$2,$3,$4,$5,$6,$7)", [A, solicitud, i ? "entrega" : "busqueda", driver, vehicles[i], fechas[i], states[i]]);
    if (receipt && price > 0) await db.query("INSERT INTO traslado_cobros(tenant_id,solicitud_id,monto,fecha,cobrado_por,chofer_id,payment_method_id,registrado_por) VALUES($1,$2,$3,$4,'chofer',$5,$6,$7)", [A, solicitud, price, receipt, driver, pm, users.admin]);
    return solicitud;
  }
  let percent, none, journal, operation, expense, external;
  await t.test("migración repetible, vacíos pendientes y acceso financiero solo administrador", async () => {
    const r = await report(); assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.total.ingresos, 0); assert.equal(r.body.total.resultado, null);
    assert.ok(r.body.total.pendientes.includes("categorias_sin_elegir"));
    for (const key of ["staff", "driver", "missing"]) {
      const status = key === "missing" ? 401 : 403;
      for (const [path, method, body] of [[`?${new URLSearchParams(range)}`, "GET"], ["/categorias", "PUT", { ids: [] }], ["/revision-gastos", "POST", {}], ["/costos-externos", "POST", {}], [`/costos-externos/${uid()}`, "PUT", {}], ["/jornadas", "POST", {}], [`/jornadas/${uid()}`, "PUT", {}], [`/repartos/${uid()}`, "PUT", {}], [`/gastos/diario/${uid()}`, "PUT", {}], [`/condiciones/${uid()}`, "PUT", {}]]) {
        assert.equal((await request(path, method, body, key)).status, status, `${key} ${path}`);
      }
    }
    assert.equal((await request("?from=2026-02-30&to=2026-02-30")).status, 400);
    assert.equal((await request("?from=2026-10-31&to=2026-11-01")).status, 400);
    assert.equal((await request("/categorias", "PUT", { ids: [foreignCat] })).status, 400);
    assert.equal((await request("/categorias", "PUT", { ids: [cat] })).status, 200);
    assert.equal((await confirm()).status, 200);
    assert.equal((await report()).body.total.resultado, 0);
    assert.deepEqual((await report("other")).body.costos, []);
  });
  await t.test("precio único, porcentaje pactado y referencia sin sumar ambos costos de chofer", async () => {
    for (const [name, model, amount, reference] of [["percent", "porcentaje", 25, 2000], ["none", "ninguno", 0, 3000], ["journal", "jornal", 5000, 4000]]) {
      const saved = await db.query("INSERT INTO traslado_configuracion(tenant_id,version,modelo_pago,valor_pago,costo_referencia,unidad_referencia) SELECT $1,COALESCE(MAX(version),0)+1,$2,$3,$4,'traslado' FROM traslado_configuracion WHERE tenant_id=$1 RETURNING id", [A, model, amount, reference]);
      if (name === "percent") percent = saved.rows[0].id;
      if (name === "none") none = saved.rows[0].id;
      if (name === "journal") journal = saved.rows[0].id;
    }
    operation = await seed({ cfg: percent });
    const r = (await report()).body;
    assert.equal(r.total.ingresos, 8000); assert.equal(r.total.realizados, 1);
    assert.equal(r.total.pago_choferes, 2000); assert.equal(r.total.resultado, 6000);
    assert.equal(r.total.resultado_referencia, 6000); assert.equal(r.total.costo_por_traslado, 2000);
    assert.equal(r.total.ingreso_promedio_cobrado, 8000);
    assert.equal(r.vehiculos.find((v) => v.vehiculo_id === vehicle).ingresos, 8000);
    assert.equal(r.total.por_dia_semana[6], 1);
  });
  await t.test("gastos locales vinculados una vez, externos fuera de caja y revisión invalidada", async () => {
    expense = uid();
    await db.query("INSERT INTO daily_expenses(id,tenant_id,date,category_id,description,amount) VALUES($1,$2,$3,$4,'Nafta',1000)", [expense, A, date, cat]);
    assert.equal((await report()).body.total.resultado, null);
    assert.equal((await request(`/gastos/diario/${expense}`, "PUT", { vehiculo_id: foreignVehicle, revision: null })).status, 400);
    const linked = await request(`/gastos/diario/${expense}`, "PUT", { vehiculo_id: vehicle, revision: null }); assert.equal(linked.status, 200);
    assert.equal((await request(`/gastos/diario/${expense}`, "PUT", { vehiculo_id: vehicle2, revision: null })).status, 409);
    const body = { id: uid(), fecha: date, concepto: "Lavado", monto: 500, pagado_por: "Jorge (socio)", vehiculo_id: vehicle };
    external = (await request("/costos-externos", "POST", body)).body;
    assert.ok(external.revision);
    assert.equal((await request("/costos-externos", "POST", body)).status, 201);
    assert.equal((await request("/costos-externos", "POST", { ...body, monto: 501 })).status, 409);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM daily_expenses")).rows[0].n, 1);
    assert.equal((await confirm()).status, 200);
    const r = (await report()).body;
    assert.equal(r.total.gastos, 1500); assert.equal(r.total.resultado, 4500);
    assert.equal(r.costos.length, 2);
    assert.equal((await request(`/gastos/diario/${expense}`, "PUT", { vehiculo_id: vehicle, revision: linked.body.revision }, "other")).status, 404);
    const edit = { fecha: date, concepto: "Lavado", monto: 600, pagado_por: "Jorge", vehiculo_id: vehicle, revision: external.revision, anulado: false };
    assert.equal((await request(`/costos-externos/${external.id}`, "PUT", edit, "other")).status, 400);
    assert.equal((await request(`/costos-externos/${external.id}`, "PUT", edit)).status, 200);
    assert.equal((await request(`/costos-externos/${external.id}`, "PUT", edit)).status, 409);
    assert.equal((await report()).body.gastos.confirmado, false);
  });
  await t.test("fijos por mes con prorrateo y sin usar pago o plantilla actual", async () => {
    const fixed = uid();
    await db.query("INSERT INTO fixed_expense_periods(tenant_id,period,source) VALUES($1,'2026-10-01','manual')", [A]);
    await db.query("INSERT INTO fixed_expense_charges(id,tenant_id,period,name,category_id,amount) VALUES($1,$2,'2026-10-01','Seguro',$3,3100)", [fixed, A, cat]);
    assert.equal((await request(`/gastos/fijo/${fixed}`, "PUT", { vehiculo_id: vehicle, revision: null })).status, 200);
    assert.equal((await confirm()).status, 200);
    assert.equal((await report()).body.total.gastos, 4700);
    const partial = (await report("admin", { from: "2026-10-01", to: "2026-10-15" })).body;
    assert.equal(partial.total.gastos, 1500); assert.equal(partial.gastos.confirmado, true);
    await db.query("UPDATE fixed_expense_charges SET amount=100.01 WHERE id=$1", [fixed]);
    const halves = await Promise.all([
      report("admin", { from: "2026-10-01", to: "2026-10-15" }),
      report("admin", { from: "2026-10-16", to: "2026-10-31" }),
    ]);
    assert.equal(Math.round(halves.reduce((sum, r) => sum + r.body.costos.find((c) => c.tipo === "fijo").monto_periodo, 0) * 100), 10001);
    await db.query("UPDATE fixed_expense_charges SET amount=3100 WHERE id=$1", [fixed]);
    await db.query("UPDATE daily_expenses SET amount=1100 WHERE id=$1", [expense]);
    assert.equal((await report()).body.gastos.confirmado, false);
  });
  await t.test("viaje entre dos móviles: no duplica cobro y exige reparto explícito", async () => {
    const mixed = await seed({ cfg: none, price: 100.01, vehicles: [vehicle, vehicle2] });
    let r = (await report()).body;
    assert.equal(r.vehiculos.find((v) => v.nombre === "Sin distribuir").ingresos, 100.01);
    assert.equal(r.vehiculos.find((v) => v.vehiculo_id === vehicle).resultado, null);
    assert.equal((await request(`/repartos/${mixed}`, "PUT", { revision: null, items: [{ vehiculo_id: vehicle, porcentaje: 40 }, { vehiculo_id: vehicle2, porcentaje: 40 }] })).status, 400);
    assert.equal((await request(`/repartos/${mixed}`, "PUT", { revision: null, items: [{ vehiculo_id: foreignVehicle, porcentaje: 100 }] })).status, 400);
    const input = { revision: null, items: [{ vehiculo_id: vehicle, porcentaje: 50 }, { vehiculo_id: vehicle2, porcentaje: 50 }] };
    assert.equal((await request(`/repartos/${mixed}`, "PUT", input, "other")).status, 404);
    assert.equal((await request(`/repartos/${mixed}`, "PUT", input)).status, 200);
    assert.equal((await request(`/repartos/${mixed}`, "PUT", input)).status, 409);
    r = (await report()).body;
    assert.equal(r.total.ingresos, 8100.01);
    assert.equal(Math.round(r.vehiculos.reduce((sum, v) => sum + v.ingresos, 0) * 100), 810001);
    assert.equal(r.total.realizados, 2);
    const op = r.operaciones.find((o) => o.id === mixed);
    assert.equal(op.sin_distribuir, false);
    assert.equal((await request(`/repartos/${mixed}`, "PUT", { revision: op.revision, items: [] })).status, 200);
  });
  await t.test("jornal por chofer y día, no uno por tramo ni por perro", async () => {
    await seed({ cfg: journal }); await seed({ cfg: journal });
    let r = (await report()).body;
    assert.equal(r.jornadas_pendientes.length, 1);
    assert.equal(r.total.resultado, null);
    const body = { id: uid(), fecha: date, chofer_id: driver, vehiculo_id: vehicle, monto: 5000 };
    assert.equal((await request("/jornadas", "POST", body, "other")).status, 400);
    const saved = await request("/jornadas", "POST", body); assert.equal(saved.status, 201);
    assert.equal((await request("/jornadas", "POST", body)).status, 201);
    assert.equal((await request("/jornadas", "POST", { ...body, id: uid() })).status, 409);
    r = (await report()).body;
    assert.equal(r.jornadas_pendientes.length, 0); assert.equal(r.total.pago_choferes, 7000);
    const edit = { fecha: date, chofer_id: driver, vehiculo_id: vehicle, monto: 5000, revision: saved.body.revision, anulado: true };
    assert.equal((await request(`/jornadas/${saved.body.id}`, "PUT", edit)).status, 200);
    assert.equal((await report()).body.jornadas_pendientes.length, 1);
    assert.equal((await request(`/jornadas/${saved.body.id}`, "PUT", edit)).status, 409);
  });
  await t.test("bonificados y presupuestos no generan ingresos; históricos conservan incertidumbre", async () => {
    await seed({ price: 0, cfg: none, bonificado: true, receipt: null });
    await seed({ cfg: null, receipt: null, states: ["pendiente", "pendiente"] });
    await db.query("INSERT INTO agenda_turnos(tenant_id,date,time,status,traslado,traslado_amount) VALUES($1,$2,'10:00','finished',true,9000)", [A, date]);
    const r = (await report()).body;
    assert.equal(r.total.ingresos, 24100.01); assert.equal(r.total.bonificados, 1);
    assert.equal(r.historicos.cantidad, 1); assert.equal(r.historicos.importe_registrado, 9000);
    assert.ok(r.total.pendientes.includes("historicos_sin_costos"));
    assert.equal(r.total.resultado, null);
    assert.equal((await db.query("SELECT precio_total FROM traslado_solicitudes WHERE id=$1", [operation])).rows[0].precio_total, "8000.00");
    assert.equal((await report("other")).body.total.ingresos, 0);
  });
  await t.test("completar condiciones desconocidas exige revisión individual y no reescribe lo pactado", async () => {
    const q = { from: "2026-11-01", to: "2026-11-30" };
    const s = await seed({ fechas: [q.from, q.from], receipt: q.from });
    let r = (await report("admin", q)).body;
    assert.equal(r.total.pago_choferes, null); assert.equal(r.total.costo_referencia, null);
    const body = { configuracion_id: percent, confirmar: true };
    assert.equal((await request(`/condiciones/${s}`, "PUT", body, "other")).status, 404);
    assert.equal((await request(`/condiciones/${s}`, "PUT", { ...body, confirmar: false })).status, 400);
    assert.equal((await request(`/condiciones/${s}`, "PUT", { ...body, configuracion_id: uid() })).status, 400);
    const concurrent = await Promise.all([request(`/condiciones/${s}`, "PUT", body), request(`/condiciones/${s}`, "PUT", body)]);
    assert.ok(concurrent.every((v) => v.status === 200));
    assert.equal((await request(`/condiciones/${s}`, "PUT", { ...body, configuracion_id: none })).status, 409);
    assert.equal((await request(`/condiciones/${operation}`, "PUT", body)).status, 409);
    assert.equal((await db.query("SELECT configuracion_id FROM traslado_solicitudes WHERE id=$1", [s])).rows[0].configuracion_id, null);
    await db.query("INSERT INTO traslado_configuracion(tenant_id,version,modelo_pago,valor_pago) VALUES($1,99,'porcentaje',100)", [A]);
    r = (await report("admin", q)).body;
    assert.equal(r.total.pago_choferes, 2000); assert.equal(r.total.costo_referencia, 2000);
    assert.equal(r.operaciones[0].condiciones_pendientes, false);
    assert.equal((await request("/revision-gastos", "POST", { ...q, revision: r.gastos.revision, confirmar: true })).status, 200);
    assert.equal((await report("admin", q)).body.total.resultado, 6000);
  });
  await t.test("referencia diaria por chofer, independiente de cantidad de mascotas y con conflictos visibles", async () => {
    const q = { from: "2026-11-01", to: "2026-11-30" };
    const cfg = uid(), otherCfg = uid();
    await db.query("INSERT INTO traslado_configuracion(id,tenant_id,version,modelo_pago,valor_pago,costo_referencia,unidad_referencia) VALUES($1,$2,100,'ninguno',0,10000,'dia'),($3,$2,101,'ninguno',0,11000,'dia')", [cfg, A, otherCfg]);
    await seed({ cfg, fechas: ["2026-11-02", "2026-11-02"], receipt: "2026-11-02" });
    await seed({ cfg, fechas: ["2026-11-02", "2026-11-02"], receipt: "2026-11-02" });
    assert.equal((await report("admin", q)).body.total.costo_referencia, 12000);
    await seed({ cfg: otherCfg, fechas: ["2026-11-02", "2026-11-02"], receipt: "2026-11-02" });
    const r = (await report("admin", q)).body;
    assert.equal(r.total.costo_referencia, null); assert.equal(r.total.resultado_referencia, null);
    assert.ok(r.total.pendientes.includes("referencias_diarias_incompatibles"));
    assert.equal(r.total.resultado, 30000);
  });
  await t.test("un viaje a medio terminar no aparenta costo cero aunque todavía no haya cobro", async () => {
    await seed({ fechas: ["2026-12-01", "2026-12-01"], states: ["entregado", "pendiente"], receipt: null });
    const r = (await report("admin", { from: "2026-12-01", to: "2026-12-31" })).body;
    assert.equal(r.total.realizados, 0); assert.equal(r.total.ingresos, 0); assert.equal(r.total.pago_choferes, null);
    assert.ok(r.total.pendientes.includes("operaciones_en_curso"));
    assert.equal(r.total.resultado, null);
  });
});
