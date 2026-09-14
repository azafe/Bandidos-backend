// Cubre el guard de rol agregado a Empleados, Proveedores, Servicios,
// Métodos de Pago y Categorías de Gastos: gestionar (crear/editar/borrar)
// esos recursos es cosa de admin, pero leerlos sigue abierto a cualquier
// rol -DailyExpensesPage, DailyIncomesPage y PetShopPage (todas accesibles
// para staff) necesitan el GET de payment-methods/expense-categories para
// sus combos, y staff necesita poder crear un Servicio (ver
// createServiceFromTurno en AgendaPage.jsx, que crea un servicio real al
// finalizar un turno).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://localhost:5432/postgres";
process.env.JWT_SECRET ||= "test-secret";

const { app } = await import("../src/index.js");
const { pool } = await import("../src/db.js");
const jwt = (await import("jsonwebtoken")).default;

const TENANT_ID = crypto.randomUUID();
const EXISTING_ID = crypto.randomUUID();

const norm = (sql) => sql.replace(/\s+/g, " ").trim().toLowerCase();

const tokenFor = (role) =>
  jwt.sign(
    { sub: crypto.randomUUID(), role, email: `${role}@test.com`, tenant_id: TENANT_ID },
    process.env.JWT_SECRET
  );

function createFakeDb() {
  const query = async (sql) => {
    const q = norm(sql);

    if (q.startsWith("select status, suspended_reason from tenants")) {
      return { rowCount: 1, rows: [{ status: "active", suspended_reason: null }] };
    }
    // Cualquier SELECT de listado/detalle: alcanza con no explotar.
    if (q.startsWith("select")) {
      return { rowCount: 1, rows: [{ id: EXISTING_ID }] };
    }
    // Cualquier INSERT/UPDATE/DELETE que sí llegue a pegarle a la base
    // (es decir, pasó el requireRole): devolver una fila cualquiera.
    if (q.startsWith("insert") || q.startsWith("update") || q.startsWith("delete")) {
      return { rowCount: 1, rows: [{ id: EXISTING_ID }] };
    }

    throw new Error(`Unexpected SQL in staff-role-guard test: ${sql}`);
  };

  return { query };
}

test("guard de rol admin en Empleados/Proveedores/Servicios", async (t) => {
  const originalQuery = pool.query.bind(pool);
  const db = createFakeDb();
  pool.query = (sql, params) => db.query(sql, params);

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

  const request = async (method, path, { role, body } = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(role ? { authorization: `Bearer ${tokenFor(role)}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return res.status;
  };

  const validEmployee = { name: "Ana", role: "Groomer", status: "active" };
  const validSupplier = { name: "Proveedor SRL" };
  const validMovement = { date: "2026-09-01", tipo: "cargo", monto: 1000 };
  const validPaymentMethod = { name: "Transferencia" };
  const validExpenseCategory = { name: "Insumos" };
  const validService = {
    date: "2026-09-01",
    pet_id: crypto.randomUUID(),
    customer_id: crypto.randomUUID(),
    service_type_id: crypto.randomUUID(),
    price: 5000,
    payment_method_id: crypto.randomUUID()
  };

  const blockedForStaff = [
    ["POST", "/v2/employees", validEmployee],
    ["PUT", `/v2/employees/${EXISTING_ID}`, { name: "Otra" }],
    ["DELETE", `/v2/employees/${EXISTING_ID}`, undefined],
    ["POST", "/v2/suppliers", validSupplier],
    ["PUT", `/v2/suppliers/${EXISTING_ID}`, { name: "Otro" }],
    ["DELETE", `/v2/suppliers/${EXISTING_ID}`, undefined],
    ["POST", `/v2/suppliers/${EXISTING_ID}/movements`, validMovement],
    ["PUT", `/v2/services/${EXISTING_ID}`, { price: 6000 }],
    ["DELETE", `/v2/services/${EXISTING_ID}`, undefined],
    ["POST", "/v2/payment-methods", validPaymentMethod],
    ["PUT", `/v2/payment-methods/${EXISTING_ID}`, { name: "Otro" }],
    ["DELETE", `/v2/payment-methods/${EXISTING_ID}`, undefined],
    ["POST", "/v2/expense-categories", validExpenseCategory],
    ["PUT", `/v2/expense-categories/${EXISTING_ID}`, { name: "Otra" }],
    ["DELETE", `/v2/expense-categories/${EXISTING_ID}`, undefined]
  ];

  for (const [method, path] of blockedForStaff) {
    await t.test(`staff no puede ${method} ${path}`, async () => {
      const status = await request(method, path, { role: "staff", body: {} });
      assert.equal(status, 403);
    });
  }

  const allowedForStaff = [
    ["GET", "/v2/employees", undefined],
    ["GET", "/v2/suppliers", undefined],
    ["GET", "/v2/services", undefined],
    ["POST", "/v2/services", validService],
    ["GET", "/v2/payment-methods", undefined],
    ["GET", "/v2/expense-categories", undefined]
  ];

  for (const [method, path, body] of allowedForStaff) {
    await t.test(`staff sí puede ${method} ${path}`, async () => {
      const status = await request(method, path, { role: "staff", body });
      assert.notEqual(status, 403);
    });
  }

  const adminCanManage = [
    ["POST", "/v2/employees", validEmployee],
    ["POST", "/v2/suppliers", validSupplier],
    ["PUT", `/v2/services/${EXISTING_ID}`, { price: 6000 }],
    ["POST", "/v2/payment-methods", validPaymentMethod],
    ["POST", "/v2/expense-categories", validExpenseCategory]
  ];

  for (const [method, path, body] of adminCanManage) {
    await t.test(`admin sí puede ${method} ${path}`, async () => {
      const status = await request(method, path, { role: "admin", body });
      assert.notEqual(status, 403);
    });
  }
});
