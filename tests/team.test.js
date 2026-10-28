// Equipo: organigrama y personal, contra PostgreSQL embebido. Ciclos, borrado
// con puestos debajo, asignaciones solo de personas activas del mismo local,
// organigrama sugerido por rol, fecha de baja y permisos.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import jwt from "jsonwebtoken";
import { createsCycle } from "../src/team.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://localhost:5432/unused";
process.env.JWT_SECRET ||= "test-secret";
const { app } = await import("../src/index.js");
const { pool } = await import("../src/db.js");

const uid = () => crypto.randomUUID();

test("createsCycle detecta ciclos largos", () => {
  const positions = [
    { id: "a", parent_id: null },
    { id: "b", parent_id: "a" },
    { id: "c", parent_id: "b" },
  ];
  assert.equal(createsCycle(positions, "a", "c"), true);
  assert.equal(createsCycle(positions, "c", "a"), false);
  assert.equal(createsCycle(positions, "b", null), false);
});

test("equipo: organigrama y personal", async (t) => {
  const db = new PGlite({ parsers: { 1082: (value) => value } });
  await db.exec(`
    CREATE TABLE tenants(id uuid PRIMARY KEY,status text DEFAULT 'active',suspended_reason text);
    CREATE TABLE employees(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),name text NOT NULL,role text NOT NULL,
      phone text,email text,status text NOT NULL CHECK (status IN ('active','inactive')),notes text,commission_rate numeric DEFAULT 0.40,
      is_driver boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE users(id uuid PRIMARY KEY,tenant_id uuid,role text,email text,chofer_id uuid);
  `);
  const migration = await readFile(new URL("../db/migrations/031_equipo_organigrama.sql", import.meta.url), "utf8");
  await db.exec(migration);
  await db.exec(migration); // repetible

  const A = uid(), B = uid();
  await db.query("INSERT INTO tenants(id) VALUES($1),($2)", [A, B]);
  const emp = {};
  for (const [key, tenant, role, status, driver] of [
    ["sofia", A, "Socio", "active", false],
    ["lu", A, "Groomer", "active", false],
    ["marta", A, "Recepción", "active", false],
    ["jorge", A, "Ayudante", "active", true],
    ["ex", A, "Groomer", "inactive", false],
    ["ajeno", B, "Groomer", "active", false],
  ]) {
    emp[key] = uid();
    await db.query("INSERT INTO employees(id,tenant_id,name,role,status,is_driver) VALUES($1,$2,$3,$4,$5,$6)", [emp[key], tenant, key, role, status, driver]);
  }
  const tokens = {};
  for (const [key, role, tenant] of [["admin", "admin", A], ["staff", "staff", A], ["other", "admin", B]]) {
    const id = uid();
    await db.query("INSERT INTO users(id,tenant_id,role) VALUES($1,$2,$3)", [id, tenant, role]);
    tokens[key] = jwt.sign({ sub: id, role, tenant_id: tenant }, process.env.JWT_SECRET);
  }

  const query = async (sql, params = []) => {
    const r = await db.query(sql, params);
    return { ...r, rowCount: r.affectedRows || r.rows.length };
  };
  let tail = Promise.resolve();
  const old = { query: pool.query, connect: pool.connect };
  pool.query = query;
  pool.connect = async () => {
    const previous = tail;
    let release;
    tail = new Promise((r) => { release = r; });
    await previous;
    return { query, release };
  };
  const server = app.listen(0);
  await once(server, "listening");
  t.after(async () => {
    await new Promise((r) => server.close(r));
    Object.assign(pool, old);
    await db.close();
  });
  const request = async (path, method = "GET", body, key = "admin") => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokens[key]}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };

  // Solo el admin.
  assert.equal((await request("/v2/team", "GET", undefined, "staff")).status, 403);

  // Organigrama sugerido, con cada uno ubicado por su rol.
  const template = await request("/v2/team/template", "POST");
  assert.equal(template.status, 201);
  const byName = new Map(template.body.positions.map((p) => [p.name, p]));
  assert.equal(template.body.positions.length, 6);
  assert.equal(byName.get("Peluquería").parent_id, byName.get("Recepción").id);
  const assigned = (positionName) =>
    template.body.assignments
      .filter((a) => a.position_id === byName.get(positionName).id)
      .map((a) => a.employee_id)
      .sort();
  assert.deepEqual(assigned("Dirección"), [emp.sofia]);
  assert.deepEqual(assigned("Peluquería"), [emp.lu, emp.jorge].sort());
  assert.deepEqual(assigned("Recepción"), [emp.marta]);
  assert.deepEqual(assigned("Bandimóviles"), [emp.jorge]); // chofer
  assert.ok(!template.body.assignments.some((a) => a.employee_id === emp.ex)); // inactivo no
  assert.ok(!template.body.employees.some((e) => e.id === emp.ajeno)); // otro local no
  assert.equal((await request("/v2/team/template", "POST")).status, 409);

  // Crear debajo de otro, al final de sus hermanos.
  const banio = await request("/v2/team/positions", "POST", { name: "Baño", area: "peluqueria", parent_id: byName.get("Peluquería").id });
  assert.equal(banio.status, 201);
  assert.equal(banio.body.sort_order, 0);
  const corte = await request("/v2/team/positions", "POST", { name: "Corte", parent_id: byName.get("Peluquería").id });
  assert.equal(corte.body.sort_order, 1);
  assert.equal(corte.body.area, "otro");
  assert.equal((await request("/v2/team/positions", "POST", { name: "  " })).status, 400);
  assert.equal((await request("/v2/team/positions", "POST", { name: "X", parent_id: uid() })).status, 400);

  // Ciclos.
  const direccion = byName.get("Dirección").id;
  assert.equal((await request(`/v2/team/positions/${direccion}`, "PATCH", { parent_id: banio.body.id })).status, 400);
  assert.equal((await request(`/v2/team/positions/${direccion}`, "PATCH", { parent_id: direccion })).status, 400);
  const moved = await request(`/v2/team/positions/${banio.body.id}`, "PATCH", { parent_id: direccion, name: "Baños", description: "" });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.name, "Baños");
  assert.equal(moved.body.description, null);

  // Asignar: solo activos del mismo local; reemplaza la lista.
  const pelu = byName.get("Peluquería").id;
  assert.equal((await request(`/v2/team/positions/${pelu}/employees`, "PUT", { employee_ids: [emp.ex] })).status, 400);
  assert.equal((await request(`/v2/team/positions/${pelu}/employees`, "PUT", { employee_ids: [emp.ajeno] })).status, 400);
  assert.equal((await request(`/v2/team/positions/${pelu}/employees`, "PUT", { employee_ids: [emp.lu, emp.lu] })).status, 200);
  let team = (await request("/v2/team")).body;
  assert.deepEqual(team.assignments.filter((a) => a.position_id === pelu).map((a) => a.employee_id), [emp.lu]);

  // Borrar: no con puestos debajo; sí una hoja, y la persona sigue en el equipo.
  assert.equal((await request(`/v2/team/positions/${pelu}`, "DELETE")).status, 409);
  assert.equal((await request(`/v2/team/positions/${corte.body.id}`, "DELETE")).status, 200);
  assert.equal((await request(`/v2/team/positions/${corte.body.id}`, "DELETE")).status, 404);

  // Otro local no ve ni toca el organigrama.
  assert.equal((await request("/v2/team", "GET", undefined, "other")).body.positions.length, 0);
  assert.equal((await request(`/v2/team/positions/${pelu}`, "PATCH", { name: "Hack" }, "other")).status, 404);
  assert.equal((await request(`/v2/team/positions/${pelu}`, "DELETE", undefined, "other")).status, 404);
  assert.equal((await request("/v2/team/positions", "POST", { name: "X", parent_id: pelu }, "other")).status, 400);

  // Legajo: DNI, ingreso y fecha de baja automática solo al cambiar de estado.
  const updated = await request(`/v2/employees/${emp.lu}`, "PUT", { dni: "30123456", hire_date: "2024-03-01", status: "active" });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.dni, "30123456");
  assert.equal(updated.body.hire_date, "2024-03-01");
  assert.equal(updated.body.end_date, null);
  const off = await request(`/v2/employees/${emp.lu}`, "PUT", { status: "inactive" });
  assert.match(off.body.end_date, /^\d{4}-\d{2}-\d{2}$/);
  await db.query("UPDATE employees SET end_date='2025-01-10' WHERE id=$1", [emp.lu]);
  const again = await request(`/v2/employees/${emp.lu}`, "PUT", { status: "inactive", notes: "Se mudó" });
  assert.equal(again.body.end_date, "2025-01-10");
  const back = await request(`/v2/employees/${emp.lu}`, "PUT", { status: "active" });
  assert.equal(back.body.end_date, null);
  const created = await request("/v2/employees", "POST", { name: "Nueva", role: "Groomer", status: "active", dni: "", hire_date: "2026-10-01" });
  assert.equal(created.status, 201);
  assert.equal(created.body.dni, null);
  assert.equal(created.body.hire_date, "2026-10-01");

  // Borrar un empleado lo saca del organigrama.
  team = (await request("/v2/team")).body;
  assert.ok(team.assignments.some((a) => a.employee_id === emp.marta));
  await db.query("DELETE FROM employees WHERE id=$1", [emp.marta]);
  team = (await request("/v2/team")).body;
  assert.ok(!team.assignments.some((a) => a.employee_id === emp.marta));
});
