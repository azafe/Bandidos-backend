import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import jwt from "jsonwebtoken";
import { createTrasladosDb } from "./helpers/trasladosDb.js";
import { tenantPushAudience } from "../src/pushAudience.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://localhost:5432/unused";
process.env.JWT_SECRET ||= "test-secret";
const { app } = await import("../src/index.js");
const { pool } = await import("../src/db.js");
const uid = () => crypto.randomUUID();
const day = "2026-10-16";

test("operación diaria y acceso exclusivo por chofer en PostgreSQL", async (t) => {
  const pg = await createTrasladosDb({ realAuth: true });
  const original = { query: pool.query, connect: pool.connect };
  pool.query = pg.query; pool.connect = pg.connect;
  const A = uid(), B = uid();
  await pg.query("INSERT INTO tenants(id) VALUES($1),($2)", [A, B]);
  const users = {};
  for (const [key, role, tenant] of [["admin", "admin", A], ["staff", "staff", A], ["other", "admin", B]]) {
    const id = uid();
    await pg.query("INSERT INTO users(id,tenant_id,role,email) VALUES($1,$2,$3,$4)", [id, tenant, role, `${key}@test.com`]);
    users[key] = { id, token: jwt.sign({ sub: id, role, tenant_id: tenant }, process.env.JWT_SECRET) };
  }
  const drivers = [];
  for (const [tenant, name] of [[A, "Jorge"], [A, "César"], [A, "Relevo"], [B, "Ajeno"]]) {
    const id = uid(); drivers.push(id);
    await pg.query("INSERT INTO employees(id,tenant_id,name,role,is_driver,status) VALUES($1,$2,$3,'Socio',true,'active')", [id, tenant, name]);
  }
  const vehicle = uid(), vehicleB = uid(), customer = uid(), pet = uid();
  await pg.query("INSERT INTO vehiculos(id,tenant_id,nombre,patente) VALUES($1,$2,'Móvil','AB123CD'),($3,$4,'Ajeno','AA111BB')", [vehicle, A, vehicleB, B]);
  await pg.query("INSERT INTO customers(id,tenant_id,name,phone) VALUES($1,$2,'Ana','11 1234-5678')", [customer, A]);
  await pg.query("INSERT INTO pets(id,tenant_id,name,customer_id,owner_phone) VALUES($1,$2,'Luna',$3,'11 9999-9999')", [pet, A, customer]);
  const server = app.listen(0); await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    Object.assign(pool, original); await pg.close();
  });
  const request = async (path, method = "GET", body, key = "admin") => {
    const token = users[key]?.token;
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const manifest = (key = "admin", query = "") => request(`/v2/traslados/hoja-de-ruta?fecha=${day}${query}`, "GET", undefined, key);
  const create = async (driver, name, key = "admin", car = vehicle) => {
    const response = await request("/agenda", "POST", {
      date: day, time: "10:00", pet_name: name, owner_name: "Ana", ...(key === "admin" ? { pet_id: pet } : {}),
      traslado: true, traslado_solicitud: { precio_total: 8000, bonificado: false, tramos: [
        { tipo: "busqueda", chofer_id: driver, vehiculo_id: car, direccion: "San Martín 100", hora_programada: "09:00" },
        { tipo: "entrega", chofer_id: driver, vehiculo_id: car, direccion: "Belgrano 200" },
      ] },
    }, key);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const operations = await request(`/v2/traslado-solicitudes?turno_id=${response.body.id}`, "GET", undefined, key);
    return { turno: response.body, solicitud: operations.body[0] };
  };
  let own, second, foreign;
  await t.test("creación atómica de cuentas vinculadas y validación por local", async () => {
    for (const [key, driver] of [["d1", drivers[0]], ["d2", drivers[1]]]) {
      const made = await request("/v2/users", "POST", { email: `${key}@test.com`, password: "Prueba12345", role: "staff", chofer_id: driver });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      assert.equal(made.body.chofer_id, driver);
      const login = await request("/auth/login", "POST", { email: `${key}@test.com`, password: "Prueba12345" }, "none");
      assert.equal(login.status, 200);
      assert.equal(login.body.user.chofer_id, driver);
      users[key] = { id: made.body.id, token: login.body.token };
    }
    for (const extra of [{ chofer_id: drivers[3] }, { chofer_id: drivers[0] }, { role: "admin", chofer_id: drivers[2] }]) {
      const bad = await request("/v2/users", "POST", { email: "invalid@test.com", password: "Prueba12345", role: "staff", ...extra });
      assert.ok([400, 409].includes(bad.status), JSON.stringify(bad));
    }
    assert.equal((await pg.query("SELECT count(*) AS n FROM users WHERE email='invalid@test.com'")).rows[0].n, 0);
    own = await create(drivers[0], "Luna");
    second = await create(drivers[1], "Toby");
    foreign = await create(drivers[3], "Ajeno", "other", vehicleB);
  });

  await t.test("hoja de ruta: aislamiento, filtros, contacto y ausencia de datos económicos", async () => {
    assert.equal((await manifest()).body.items.length, 4);
    const result = await manifest("d1");
    assert.equal(result.status, 200);
    assert.equal(result.body.items.length, 2);
    for (const row of result.body.items) {
      assert.equal(row.chofer_id, drivers[0]);
      assert.equal(row.owner_phone, "11 1234-5678");
      for (const key of ["precio_total", "monto", "cobro", "solicitud_id", "turno_id", "tenant_id"]) assert.ok(!Object.hasOwn(row, key));
    }
    assert.equal((await manifest("d2")).body.items.length, 2);
    assert.equal((await manifest("other")).body.items.length, 2);
    assert.equal((await manifest("admin", `&chofer_id=${drivers[1]}`)).body.items.length, 2);
    assert.equal((await manifest("admin", `&vehiculo_id=${vehicleB}`)).body.items.length, 0);
    assert.equal((await manifest("d1", `&chofer_id=${drivers[1]}`)).status, 403);
    assert.equal((await manifest("d1", `&chofer_id=${drivers[3]}`)).status, 403);
    assert.equal((await request("/v2/traslados/hoja-de-ruta?fecha=mal")).status, 400);
    assert.equal((await manifest("none")).status, 401);
  });

  await t.test("el chofer no accede a rutas generales, cobros ni otros detalles", async () => {
    for (const path of ["/agenda", "/v2/users", "/v2/employees", "/v2/pets", "/reports/summary", "/v2/traslados", "/v2/vehiculos", "/v2/traslados/configuracion", `/v2/traslados/${own.solicitud.tramos[0].id}`, `/v2/traslado-solicitudes/${own.solicitud.id}`]) {
      assert.equal((await request(path, "GET", undefined, "d1")).status, 403, path);
    }
    for (const [path, method] of [[`/v2/traslado-solicitudes/${own.solicitud.id}/cobro`, "POST"], ["/v2/traslados/orden-ruta", "PUT"], ["/push/subscribe", "POST"], ["/v2/assistant/messages", "POST"], [`/v2/users/${users.d1.id}/chofer`, "PUT"]]) {
      assert.equal((await request(path, method, {}, "d1")).status, 403, path);
    }
    const me = await request("/me", "GET", undefined, "d1");
    assert.equal(me.status, 200);
    assert.equal(me.body.chofer_id, drivers[0]);
    assert.equal(me.body.chofer_activo, true);
  });

  await t.test("estados: solo el tramo propio, transiciones válidas y reintento idempotente", async () => {
    const tramo = own.solicitud.tramos.find((t) => t.tipo === "busqueda");
    const path = `/v2/traslados/${tramo.id}/estado`;
    const body = { estado_anterior: "pendiente", estado: "en_camino" };
    for (const other of [second.solicitud.tramos[0], foreign.solicitud.tramos[0]]) {
      assert.equal((await request(`/v2/traslados/${other.id}/estado`, "PATCH", body, "d1")).status, 404);
    }
    assert.equal((await request(path, "PATCH", { ...body, estado: "entregado" }, "d1")).status, 409);
    assert.equal((await request(path, "PATCH", { ...body, chofer_id: drivers[1] }, "d1")).status, 400);
    const attempts = await Promise.all([request(path, "PATCH", body, "d1"), request(path, "PATCH", body, "d1")]);
    assert.ok(attempts.every((a) => a.status === 200), JSON.stringify(attempts));
    assert.deepEqual(Object.keys(attempts[0].body).sort(), ["estado", "id", "updated_at"]);
    assert.equal((await request(path, "PATCH", { estado_anterior: "pendiente", estado: "retirado" }, "d1")).status, 409);
    for (const [before, after] of [["en_camino", "retirado"], ["retirado", "entregado"]]) {
      assert.equal((await request(path, "PATCH", { estado_anterior: before, estado: after }, "d1")).status, 200);
    }
    const operation = (await request(`/v2/traslado-solicitudes/${own.solicitud.id}`)).body;
    assert.equal(operation.tramos.find((t) => t.tipo === "entrega").estado, "pendiente");
    assert.equal(operation.cobro, null);
    assert.equal(Number(operation.precio_total), 8000);
    assert.equal((await request(path, "PATCH", body, "none")).status, 401);
  });

  await t.test("orden completo y atómico por día, chofer y móvil; conflictos y permisos", async () => {
    const rows = (await manifest("admin", `&chofer_id=${drivers[1]}`)).body.items;
    const input = { fecha: day, chofer_id: drivers[1], vehiculo_id: vehicle, tramos: rows.map(({ id, revision }) => ({ id, revision })).reverse() };
    const path = "/v2/traslados/orden-ruta";
    assert.equal((await request(path, "PUT", input, "staff")).status, 403);
    assert.equal((await request(path, "PUT", input, "d2")).status, 403);
    assert.equal((await request(path, "PUT", input, "none")).status, 401);
    assert.equal((await request(path, "PUT", { ...input, tramos: [input.tramos[0], input.tramos[0]] })).status, 400);
    assert.equal((await request(path, "PUT", { ...input, tramos: input.tramos.slice(1) })).status, 409);
    assert.equal((await request(path, "PUT", input, "other")).status, 409);
    assert.equal((await request(path, "PUT", input)).status, 200);
    const ordered = (await manifest("d2")).body.items;
    assert.deepEqual(ordered.map((t) => t.id), input.tramos.map((t) => t.id));
    assert.deepEqual(ordered.map((t) => t.orden_ruta), [1, 2]);
    assert.equal((await request(path, "PUT", input)).status, 409, "una vista vieja no pisa un orden nuevo");
    const update = { fecha: day, chofer_id: drivers[1], vehiculo_id: vehicle, tramos: ordered.map(({ id, revision }) => ({ id, revision })).reverse() };
    const races = await Promise.all([request(path, "PUT", update), request(path, "PUT", update)]);
    assert.deepEqual(races.map((r) => r.status).sort(), [200, 409]);
  });

  await t.test("cambio de chofer/fecha limpia el orden y conserva asignaciones hermanas", async () => {
    const result = await request(`/v2/traslado-solicitudes/${second.solicitud.id}`);
    const changed = result.body.tramos.find((t) => t.tipo === "busqueda");
    const input = { precio_total: 8000, bonificado: false, tramos: result.body.tramos.map((t) => ({ tipo: t.tipo, chofer_id: t.id === changed.id ? drivers[0] : t.chofer_id, vehiculo_id: t.vehiculo_id, direccion: t.direccion, fecha_programada: t.fecha_programada, hora_programada: t.hora_programada?.slice(0, 5) || null, estado: t.estado })) };
    assert.equal((await request(`/v2/traslado-solicitudes/${second.solicitud.id}`, "PUT", input)).status, 200);
    assert.equal((await manifest("d2")).body.items.length, 1);
    const reassigned = (await manifest("d1")).body.items.find((t) => t.id === changed.id);
    assert.equal(reassigned.orden_ruta, null);
    assert.equal((await request(`/v2/traslados/${changed.id}/estado`, "PATCH", { estado_anterior: "pendiente", estado: "en_camino" }, "d2")).status, 404);
  });

  await t.test("vinculación y desactivación se aplican con el mismo token vigente", async () => {
    const path = `/v2/users/${users.d1.id}/chofer`;
    assert.equal((await request(path, "PUT", { chofer_id: drivers[3] })).status, 400);
    assert.equal((await request(path, "PUT", { chofer_id: drivers[2] }, "other")).status, 404);
    assert.equal((await request(`/v2/users/${users.admin.id}/chofer`, "PUT", { chofer_id: drivers[2] })).status, 400);
    assert.equal((await request(path, "PUT", { chofer_id: drivers[2] })).status, 200);
    assert.equal((await manifest("d1")).body.items.length, 0);
    assert.equal((await request(path, "PUT", { chofer_id: drivers[0] })).status, 200);
    await pg.query("UPDATE employees SET status='inactive' WHERE id=$1", [drivers[0]]);
    assert.equal((await manifest("d1")).status, 403);
    const me = await request("/me", "GET", undefined, "d1");
    assert.equal(me.body.chofer_activo, false);
    assert.equal(me.body.chofer_id, drivers[0]);
    assert.equal((await request("/agenda", "GET", undefined, "d1")).status, 403);
    await pg.query("UPDATE employees SET status='active' WHERE id=$1", [drivers[0]]);
    assert.equal((await manifest("d1")).status, 200);
    await assert.rejects(pg.query("UPDATE users SET chofer_id=$2 WHERE id=$1", [users.d1.id, drivers[3]]), (err) => err.code === "23503");
  });

  await t.test("los históricos no se importan; contactos ajenos no se filtran por un vínculo inválido", async () => {
    await pg.query("INSERT INTO agenda_turnos(tenant_id,date,time,pet_name,traslado) VALUES($1,$2,'12:00','Legado',true)", [A, day]);
    assert.equal((await manifest()).body.historicos_pendientes, 1);
    assert.equal((await manifest("d1")).body.historicos_pendientes, 0);
    await pg.query("UPDATE pets SET tenant_id=$2 WHERE id=$1", [pet, B]);
    assert.ok((await manifest("d1")).body.items.every((t) => t.owner_phone === null));
    assert.equal((await pg.query("SELECT count(*) AS n FROM traslado_cobros")).rows[0].n, 0);
  });

  await t.test("los avisos generales no llegan a choferes ni a suscripciones sin responsable", async () => {
    for (const [device, tenant, user] of [["general", A, users.staff.id], ["driver", A, users.d1.id], ["legacy", A, null], ["other", B, users.other.id], ["cross", A, users.other.id]]) {
      await pg.query("INSERT INTO push_subscriptions(tenant_id,device_id,user_id) VALUES($1,$2,$3)", [tenant, device, user]);
    }
    assert.deepEqual((await tenantPushAudience(pg, A)).rows.map((s) => s.device_id), ["general"]);
    assert.deepEqual((await tenantPushAudience(pg, B)).rows.map((s) => s.device_id), ["other"]);
    await pg.query("UPDATE users SET chofer_id=$2 WHERE id=$1", [users.staff.id, drivers[2]]);
    assert.deepEqual((await tenantPushAudience(pg, A)).rows, []);
  });

  await t.test("un tramo incompleto o cancelado no sale; la ruta no inventa asignaciones", async () => {
    const made = await request("/agenda", "POST", {
      date: day, time: "14:00", pet_name: "Sin asignar", owner_name: "Ana", traslado: true,
      traslado_solicitud: { precio_total: null, bonificado: false, tramos: [{ tipo: "busqueda" }] },
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const row = (await manifest()).body.items.find((r) => r.pet_name === "Sin asignar");
    assert.equal(row.chofer_id, null);
    const body = { estado_anterior: "pendiente", estado: "en_camino" };
    assert.equal((await request(`/v2/traslados/${row.id}/estado`, "PATCH", body)).status, 400);
    assert.equal((await request(`/agenda/${made.body.id}`, "PUT", { status: "cancelled" })).status, 200);
    assert.equal((await request(`/v2/traslados/${row.id}/estado`, "PATCH", body)).status, 409);
    assert.ok(!(await manifest()).body.items.some((r) => r.id === row.id));
  });
});
