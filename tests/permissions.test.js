// Roles y permisos por módulo contra PostgreSQL embebido: permisos por defecto,
// configuración por local, control en cada endpoint, rutas que eran solo del
// admin, cuentas de chofer y lo que no se delega nunca (usuarios y permisos).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import jwt from "jsonwebtoken";
import { DEFAULT_PERMISSIONS, MODULE_IDS, ruleFor } from "../src/permissions.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://localhost:5432/unused";
process.env.JWT_SECRET ||= "test-secret";
const { app } = await import("../src/index.js");
const { pool } = await import("../src/db.js");

const uid = () => crypto.randomUUID();

test("cada ruta que era solo del admin tiene su módulo", () => {
  const delegated = [
    ["POST", "/v2/employees"], ["PUT", "/v2/employees/x"], ["DELETE", "/v2/employees/x"],
    ["GET", "/v2/booking/settings"], ["PUT", "/v2/booking/settings"], ["PUT", "/v2/booking/hours"],
    ["POST", "/v2/booking/closed-days"], ["DELETE", "/v2/booking/closed-days/x"],
    ["POST", "/v2/payment-methods"], ["PUT", "/v2/payment-methods/x"], ["DELETE", "/v2/payment-methods/x"],
    ["PUT", "/v2/services/x"], ["DELETE", "/v2/services/x"],
    ["POST", "/v2/suppliers"], ["PUT", "/v2/suppliers/x"], ["DELETE", "/v2/suppliers/x"], ["POST", "/v2/suppliers/x/movements"],
    ["POST", "/v2/expense-categories"], ["PUT", "/v2/expense-categories/x"], ["DELETE", "/v2/expense-categories/x"],
    ["GET", "/v2/team"], ["POST", "/v2/team/template"],
  ];
  for (const [method, path] of delegated) {
    const rule = ruleFor(method, path);
    assert.ok(Array.isArray(rule?.modules) && rule.modules.length, `${method} ${path} quedó sin módulo`);
    assert.ok(rule.modules.every((m) => MODULE_IDS.includes(m)));
  }
  // Lo de referencia queda abierto; lo de admin, cerrado.
  assert.equal(ruleFor("GET", "/v2/employees"), null);
  assert.equal(ruleFor("GET", "/v2/suppliers").modules, null);
  assert.equal(ruleFor("GET", "/v2/users").modules, "admin");
  assert.equal(ruleFor("PUT", "/v2/permissions/staff").modules, "admin");
  // Finalizar un turno crea el servicio: la Agenda puede, pero no editarlo.
  assert.ok(ruleFor("POST", "/v2/services").modules.includes("agenda"));
  assert.ok(!ruleFor("PUT", "/v2/services/x").modules.includes("agenda"));
  for (const modules of Object.values(DEFAULT_PERMISSIONS)) assert.ok(modules.every((m) => MODULE_IDS.includes(m)));
});

test("permisos por rol y por local", async (t) => {
  const db = new PGlite({ parsers: { 1082: (value) => value } });
  await db.exec(`
    CREATE TABLE tenants(id uuid PRIMARY KEY,status text DEFAULT 'active',suspended_reason text);
    CREATE TABLE users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid REFERENCES tenants(id),role text,email text UNIQUE,password_hash text,chofer_id uuid,created_at timestamptz DEFAULT now());
    CREATE TABLE employees(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,name text,role text,phone text,email text,status text DEFAULT 'active',notes text,commission_rate numeric DEFAULT 0.40,is_driver boolean DEFAULT false,created_at timestamptz DEFAULT now());
    CREATE TABLE suppliers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,name text,category text,phone text,payment_method_id uuid,notes text,created_at timestamptz DEFAULT now());
    CREATE TABLE comunicaciones_enviadas(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,pet_id uuid,type text,created_at timestamptz DEFAULT now());
  `);
  const migration = await readFile(new URL("../db/migrations/033_roles_permisos.sql", import.meta.url), "utf8");
  await db.exec(migration);
  await db.exec(migration); // repetible

  const A = uid(), B = uid(), driverEmployee = uid();
  await db.query("INSERT INTO tenants(id) VALUES($1),($2)", [A, B]);
  await db.query("INSERT INTO employees(id,tenant_id,name,role,is_driver) VALUES($1,$2,'Jorge','Chofer',true)", [driverEmployee, A]);
  const tokens = {};
  for (const [key, role, tenant, chofer] of [
    ["admin", "admin", A, null], ["staff", "staff", A, null], ["recepcion", "recepcion", A, null],
    ["peluquero", "peluquero", A, null], ["administracion", "administracion", A, null], ["legacy", "user", A, null],
    ["driver", "staff", A, driverEmployee], ["peluqueroB", "peluquero", B, null],
  ]) {
    const id = uid();
    await db.query("INSERT INTO users(id,tenant_id,role,email,chofer_id) VALUES($1,$2,$3,$4,$5)", [id, tenant, role, `${key}@test.com`, chofer]);
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
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const blocked = async (path, method, key, body) => (await request(path, method, body, key)).status === 403;

  // Lo propio: por defecto, y el admin todo.
  const me = (await request("/me/permissions", "GET", undefined, "staff")).body;
  assert.deepEqual(me.modules, DEFAULT_PERMISSIONS.staff);
  assert.equal(me.role_label, "Staff");
  assert.deepEqual((await request("/me/permissions")).body.modules, MODULE_IDS);
  assert.deepEqual((await request("/me/permissions", "GET", undefined, "legacy")).body.modules, DEFAULT_PERMISSIONS.staff);
  assert.deepEqual((await request("/me/permissions", "GET", undefined, "driver")).body, {
    role: "staff", role_label: "Staff", is_admin: false, driver: true, modules: [],
  });

  // El backend frena lo que el rol no tiene y deja pasar lo que sí.
  assert.equal(await blocked("/v2/daily-incomes/system-totals", "GET", "peluquero"), true);
  assert.equal(await blocked("/reports/summary", "GET", "staff"), true);
  assert.equal(await blocked("/v2/fixed-expenses", "GET", "staff"), true);
  assert.equal(await blocked("/v2/comunicaciones", "GET", "peluquero"), true);
  assert.equal(await blocked("/v2/comunicaciones", "GET", "recepcion"), false);
  assert.equal(await blocked("/v2/employees", "GET", "peluquero"), false); // lista de referencia
  assert.equal(await blocked("/v2/suppliers", "GET", "peluquero"), false);
  const denied = await request("/v2/suppliers/x", "GET", undefined, "peluquero");
  assert.equal(denied.status, 403);
  assert.match(denied.body.message, /Proveedores/);

  // Rutas que eran solo del admin: con el módulo, pasan.
  assert.equal(await blocked("/v2/employees", "POST", "staff", { name: "X", role: "Groomer", status: "active" }), true);
  const supplier = await request("/v2/suppliers", "POST", { name: "Distribuidora" }, "administracion");
  assert.equal(supplier.status, 201);
  assert.equal(await blocked("/v2/suppliers", "POST", "staff", { name: "Y" }), true);

  // Usuarios y permisos: nunca se delegan.
  assert.equal(await blocked("/v2/users", "GET", "administracion"), true);
  assert.equal(await blocked("/v2/permissions", "GET", "administracion"), true);
  assert.equal(await blocked("/v2/permissions/staff", "PUT", "staff", { modules: MODULE_IDS }), true);

  // El admin configura un rol: vale desde el próximo pedido y solo en su local.
  const matrix = (await request("/v2/permissions")).body;
  assert.deepEqual(matrix.permissions.peluquero, DEFAULT_PERMISSIONS.peluquero);
  assert.equal(matrix.roles.length, 4);
  assert.equal((await request("/v2/permissions/admin", "PUT", { modules: [] })).status, 400);
  assert.equal((await request("/v2/permissions/peluquero", "PUT", { modules: ["robar"] })).status, 400);
  const saved = await request("/v2/permissions/peluquero", "PUT", { modules: ["caja", "agenda", "caja", "mascotas"] });
  assert.deepEqual(saved.body.modules, ["agenda", "mascotas", "caja"]); // sin repetidos, en orden
  assert.equal(await blocked("/v2/daily-incomes/system-totals", "GET", "peluquero"), false);
  assert.deepEqual((await request("/me/permissions", "GET", undefined, "peluquero")).body.modules, ["agenda", "mascotas", "caja"]);
  assert.deepEqual((await request("/me/permissions", "GET", undefined, "peluqueroB")).body.modules, DEFAULT_PERMISSIONS.peluquero);
  // Sacar todo también es una elección.
  await request("/v2/permissions/peluquero", "PUT", { modules: [] });
  assert.deepEqual((await request("/me/permissions", "GET", undefined, "peluquero")).body.modules, []);
  assert.equal(await blocked("/v2/comunicaciones", "POST", "peluquero", {}), true);

  // Al chofer lo limita su propia regla, no los módulos de su rol.
  await request("/v2/permissions/staff", "PUT", { modules: [] });
  assert.equal((await request("/v2/comunicaciones", "GET", undefined, "driver")).body.message, "Tu cuenta solo tiene acceso a tus traslados.");

  // Asignar los roles nuevos a un usuario.
  const created = await request("/v2/users", "POST", { email: "nueva@test.com", password: "12345678", role: "recepcion" });
  assert.equal(created.status, 201);
  assert.equal(created.body.role, "recepcion");
  assert.equal((await request("/v2/users", "POST", { email: "x@test.com", password: "12345678", role: "super_admin" })).status, 400);
});
