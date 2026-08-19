// Tests de integración de gastos fijos contra un Postgres real y los endpoints
// reales de la app.
//
// La lógica que importa vive en SQL: generate_series, date_trunc, LEAST para
// clampear vencimientos, y el filtro de vigencia en la copia. Mockear el pool
// testearía el mock. Y replicar las consultas dentro del test tampoco sirve:
// dejaría de avisar cuando alguien cambia la consulta de verdad. Por eso esto
// levanta la app y le pega por HTTP.
//
// Correr con una base VACÍA y descartable:
//   TEST_DATABASE_URL=postgresql://... node --test tests/fixed-expenses-months.test.js
//
// Sin esa variable la suite se saltea, así que `npm test` sigue andando sin
// Postgres. El schema se recrea entero en cada corrida: NO apuntar a producción.
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const TEST_URL = process.env.TEST_DATABASE_URL;

if (!TEST_URL) {
  test(
    "gastos fijos por mes (integración)",
    { skip: "definí TEST_DATABASE_URL con una base vacía y descartable" },
    () => {}
  );
} else {
  // Esta suite hace DROP SCHEMA public CASCADE. Apuntarla a una base que no
  // sea local borraría todo, así que se niega a correr fuera de localhost.
  // No hay bandera para saltear la verificación: es a propósito.
  const host = new URL(TEST_URL).hostname;
  const esLocal = ["localhost", "127.0.0.1", "::1", ""].includes(host);
  if (!esLocal) {
    throw new Error(
      `TEST_DATABASE_URL apunta a "${host}". Esta suite borra el schema entero ` +
      `y solo corre contra localhost. Usá una base local y descartable.`
    );
  }

  const TENANT = "a8351018-89bd-4c57-9289-f7862d82be32";
  const SECRET = "secreto-de-test";

  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = TEST_URL;
  process.env.JWT_SECRET = SECRET;
  process.env.DATABASE_SSL = "false";

  const jwt = (await import("jsonwebtoken")).default;
  const { app } = await import("../src/index.js");
  const { pool } = await import("../src/db.js");

  const token = jwt.sign(
    { sub: "11111111-1111-1111-1111-111111111111", role: "admin",
      email: "test@test.local", tenant_id: TENANT },
    SECRET,
    { expiresIn: "1h" }
  );

  let baseUrl;
  let server;
  let categoriaId;
  let metodoId;

  const api = async (path, { method = "GET", body } = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const sql = async (text, params = []) => (await pool.query(text, params)).rows;

  test.before(async () => {
    const dbDir = path.join(import.meta.dirname, "..", "db");
    const leer = (p) => fs.readFileSync(path.join(dbDir, p), "utf8");

    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
    await pool.query(leer("create_schema.sql"));

    // Mínimo multi-tenant para que pasen las FK y el middleware de tenant.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        status text NOT NULL DEFAULT 'active',
        suspended_reason text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await pool.query(
      `INSERT INTO tenants (id, name) VALUES ($1, 'Test') ON CONFLICT DO NOTHING`,
      [TENANT]
    );
    for (const t of ["fixed_expenses", "expense_categories", "payment_methods",
                     "suppliers", "employees", "daily_expenses", "services"]) {
      await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id)`);
    }

    await pool.query(leer("migrations/018_fixed_expenses_accrual.sql"));
    await pool.query(leer("migrations/019_fixed_expenses_por_mes.sql"));

    [{ id: categoriaId }] = await sql(
      `INSERT INTO expense_categories (name, tenant_id) VALUES ('Servicios', $1) RETURNING id`,
      [TENANT]
    );
    [{ id: metodoId }] = await sql(
      `INSERT INTO payment_methods (name, tenant_id) VALUES ('Transferencia', $1) RETURNING id`,
      [TENANT]
    );

    server = app.listen(0);
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  test.after(async () => {
    if (server) {
      server.close();
      await once(server, "close");
    }
    await pool.end();
  });

  // Deja la base sin gastos fijos ni meses armados.
  async function limpiar() {
    await pool.query(`DELETE FROM fixed_expense_charges WHERE tenant_id = $1`, [TENANT]);
    await pool.query(`DELETE FROM fixed_expense_periods WHERE tenant_id = $1`, [TENANT]);
    await pool.query(`DELETE FROM fixed_expenses WHERE tenant_id = $1`, [TENANT]);
  }

  const agregar = (period, campos) =>
    api(`/v2/fixed-expenses/months/${period}/items`, {
      method: "POST",
      body: { category_id: categoriaId, payment_method_id: metodoId, ...campos }
    });

  const nombres = async (period) =>
    (await api(`/v2/fixed-expenses/months/${period}`)).body.items.map((i) => i.name);

  // ── Estado de un mes ──────────────────────────────────────────────────────
  test("un mes sin armar no es un mes de cero", async () => {
    await limpiar();
    const { body } = await api("/v2/fixed-expenses/months/2026-09");
    assert.equal(body.armed, false);
    assert.equal(body.total, 0);
    assert.deepEqual(body.items, []);
    assert.equal(body.previous_period, "2026-08");
  });

  test("el devengado avisa qué meses del rango están sin armar", async () => {
    await limpiar();
    const { body } = await api("/v2/fixed-expenses/accrual?from=2026-09-01&to=2026-10-31");
    assert.deepEqual(body.unarmed_periods, ["2026-09-01", "2026-10-01"]);
    assert.equal(body.accrued_total, 0);
  });

  // ── Vencimientos ──────────────────────────────────────────────────────────
  test("el vencimiento se clampea al último día del mes", async () => {
    await limpiar();
    for (const [period, esperado] of [
      ["2026-01", "2026-01-31"],
      ["2026-04", "2026-04-30"],
      ["2026-02", "2026-02-28"],
      ["2028-02", "2028-02-29"] // bisiesto
    ]) {
      const { status, body } = await agregar(period, {
        name: "Monotributo", amount: 45000, due_day: 31
      });
      assert.equal(status, 201);
      assert.equal(
        body.due_date.toISOString?.().slice(0, 10) ?? String(body.due_date).slice(0, 10),
        esperado,
        `vencimiento 31 en ${period} debería caer ${esperado}`
      );
    }
  });

  test("la intención del día sobrevive al pasar por un mes corto", async () => {
    await limpiar();
    await agregar("2026-08", { name: "Monotributo", amount: 45000, due_day: 31 });
    // agosto(31) -> septiembre(30) -> octubre(31)
    await api("/v2/fixed-expenses/months/2026-09/copy", { method: "POST", body: {} });
    await api("/v2/fixed-expenses/months/2026-10/copy", { method: "POST", body: {} });

    const [sep] = (await api("/v2/fixed-expenses/months/2026-09")).body.items;
    const [oct] = (await api("/v2/fixed-expenses/months/2026-10")).body.items;
    assert.equal(sep.due_date, "2026-09-30");
    assert.equal(sep.due_day, 31, "septiembre debe recordar que se pidió el 31");
    assert.equal(
      oct.due_date, "2026-10-31",
      "octubre tiene 31 días: el vencimiento vuelve al 31, no queda pegado en 30"
    );
  });

  // ── Copia y aislamiento ───────────────────────────────────────────────────
  test("copiar arma el mes y no se puede copiar dos veces", async () => {
    await limpiar();
    await agregar("2026-08", { name: "Alquiler", amount: 180000, due_day: 1 });

    const primera = await api("/v2/fixed-expenses/months/2026-09/copy", { method: "POST", body: {} });
    assert.equal(primera.status, 201);
    assert.equal(primera.body.armed, true);
    assert.equal(primera.body.source, "copy");
    assert.equal(primera.body.total, 180000);

    const segunda = await api("/v2/fixed-expenses/months/2026-09/copy", { method: "POST", body: {} });
    assert.equal(segunda.status, 409, "un segundo copiado duplicaría la lista");
  });

  test("editar un mes no toca los demás", async () => {
    await limpiar();
    await agregar("2026-08", { name: "Alquiler", amount: 180000, due_day: 1 });
    await api("/v2/fixed-expenses/months/2026-09/copy", { method: "POST", body: {} });

    const [sep] = (await api("/v2/fixed-expenses/months/2026-09")).body.items;
    await api(`/v2/fixed-expenses/charges/${sep.id}`, {
      method: "PUT", body: { name: "Alquiler nuevo", amount: 250000 }
    });

    const agosto = (await api("/v2/fixed-expenses/months/2026-08")).body;
    const septiembre = (await api("/v2/fixed-expenses/months/2026-09")).body;
    assert.equal(agosto.items[0].name, "Alquiler");
    assert.equal(agosto.total, 180000, "agosto no debe moverse");
    assert.equal(septiembre.items[0].name, "Alquiler nuevo");
    assert.equal(septiembre.total, 250000);
  });

  test("la copia arrastra lo editado en el mes anterior", async () => {
    await limpiar();
    await agregar("2026-08", { name: "Internet", amount: 9500, due_day: 10 });
    const [ago] = (await api("/v2/fixed-expenses/months/2026-08")).body.items;
    await api(`/v2/fixed-expenses/charges/${ago.id}`, {
      method: "PUT", body: { name: "Fibra 500MB", amount: 15000 }
    });
    await api("/v2/fixed-expenses/months/2026-09/copy", { method: "POST", body: {} });

    const [sep] = (await api("/v2/fixed-expenses/months/2026-09")).body.items;
    assert.equal(sep.name, "Fibra 500MB");
    assert.equal(sep.amount, 15000);
  });

  test("quitar un ítem de un mes es definitivo y no toca los otros", async () => {
    await limpiar();
    await agregar("2026-08", { name: "Alquiler", amount: 180000, due_day: 1 });
    await agregar("2026-08", { name: "Seguro", amount: 12000, due_day: 15 });
    await api("/v2/fixed-expenses/months/2026-09/copy", { method: "POST", body: {} });

    const seguro = (await api("/v2/fixed-expenses/months/2026-09")).body.items
      .find((i) => i.name === "Seguro");
    assert.equal((await api(`/v2/fixed-expenses/charges/${seguro.id}`, { method: "DELETE" })).status, 200);

    // Consultar el devengado no debe regenerarlo.
    await api("/v2/fixed-expenses/accrual?from=2026-09-01&to=2026-09-30");
    assert.deepEqual(await nombres("2026-09"), ["Alquiler"], "no debe reaparecer");
    assert.deepEqual((await nombres("2026-08")).sort(), ["Alquiler", "Seguro"]);
  });

  // ── Vigencia ──────────────────────────────────────────────────────────────
  test("dar de baja corta la copia y conserva la historia", async () => {
    await limpiar();
    const { body: plantilla } = await api("/v2/fixed-expenses", {
      method: "POST",
      body: { name: "PeluCan", category_id: categoriaId, amount: 29000,
              due_day: 5, payment_method_id: metodoId, status: "active" }
    });
    await agregar("2026-08", {
      name: "PeluCan", amount: 29000, due_day: 5, fixed_expense_id: plantilla.id
    });
    await agregar("2026-08", { name: "Alquiler", amount: 180000, due_day: 1 });

    await api(`/v2/fixed-expenses/${plantilla.id}`, {
      method: "PUT", body: { status: "inactive" }
    });

    await api("/v2/fixed-expenses/months/2026-09/copy", { method: "POST", body: {} });
    await api("/v2/fixed-expenses/months/2026-10/copy", { method: "POST", body: {} });

    assert.deepEqual((await nombres("2026-08")).sort(), ["Alquiler", "PeluCan"],
      "agosto conserva el gasto dado de baja");
    assert.deepEqual(await nombres("2026-09"), ["Alquiler"],
      "septiembre ya no lo copia");
    assert.deepEqual(await nombres("2026-10"), ["Alquiler"],
      "la baja sigue vigente un mes después");
  });

  test("un ítem suelto, sin plantilla, se sigue copiando", async () => {
    await limpiar();
    await agregar("2026-08", { name: "Alarma", amount: 18000, due_day: 20 });
    await api("/v2/fixed-expenses/months/2026-09/copy", { method: "POST", body: {} });
    assert.deepEqual(await nombres("2026-09"), ["Alarma"]);
  });

  // ── Devengado ─────────────────────────────────────────────────────────────
  test("el devengado se prorratea por rango en vez de imputar el mes entero", async () => {
    await limpiar();
    await agregar("2026-08", { name: "Alquiler", amount: 310000, due_day: 1 });

    const mes = (await api("/v2/fixed-expenses/accrual?from=2026-08-01&to=2026-08-31")).body;
    const dia = (await api("/v2/fixed-expenses/accrual?from=2026-08-18&to=2026-08-18")).body;

    assert.equal(mes.accrued_total, 310000);
    assert.equal(dia.accrued_total, 10000, "310000 / 31 días");
    assert.equal(dia.monthly_total, 310000, "el run-rate mensual no se prorratea");
  });

  test("la suma de la serie diaria da exactamente el total del período", async () => {
    await limpiar();
    await agregar("2026-08", { name: "Alquiler", amount: 180000, due_day: 1 });
    await agregar("2026-08", { name: "Internet", amount: 9500, due_day: 10 });

    const { body } = await api("/v2/fixed-expenses/accrual?from=2026-08-01&to=2026-08-31");
    const centavos = (v) => Math.round(v * 100);
    const suma = body.by_day.reduce((t, d) => t + centavos(d.amount), 0);
    assert.equal(suma, centavos(body.accrued_total));
  });

  // ── Integridad ────────────────────────────────────────────────────────────
  // Un cliente viejo en caché (PWA) sigue mandando from/to. Tiene que seguir
  // funcionando: rechazarlo le rompía el dashboard entero.
  test("las plantillas toleran from/to de clientes viejos", async () => {
    await limpiar();
    await api("/v2/fixed-expenses", {
      method: "POST",
      body: { name: "Alquiler", category_id: categoriaId, amount: 180000,
              due_day: 1, payment_method_id: metodoId, status: "active" }
    });
    const { status, body } = await api("/v2/fixed-expenses?from=2026-08-01&to=2026-08-31");
    assert.equal(status, 200);
    assert.equal(body.length, 1, "los parámetros se ignoran, no filtran ni rompen");
  });

  test("no se puede borrar una plantilla con meses devengados", async () => {
    await limpiar();
    const { body: plantilla } = await api("/v2/fixed-expenses", {
      method: "POST",
      body: { name: "Con historia", category_id: categoriaId, amount: 1000,
              due_day: 1, payment_method_id: metodoId, status: "active" }
    });
    await agregar("2026-08", {
      name: "Con historia", amount: 1000, due_day: 1, fixed_expense_id: plantilla.id
    });

    const { status } = await api(`/v2/fixed-expenses/${plantilla.id}`, { method: "DELETE" });
    assert.equal(status, 409, "borrarla huerfanaría meses ya devengados");
  });

  test("corregir el monto de un cargo pagado no lo despaga", async () => {
    await limpiar();
    await agregar("2026-08", { name: "Alquiler", amount: 180000, due_day: 1 });
    const [cargo] = (await api("/v2/fixed-expenses/months/2026-08")).body.items;

    await api(`/v2/fixed-expenses/charges/${cargo.id}`, {
      method: "PUT", body: { paid_at: "2026-08-03" }
    });
    const { body } = await api(`/v2/fixed-expenses/charges/${cargo.id}`, {
      method: "PUT", body: { amount: 195000 }
    });

    assert.equal(String(body.paid_at).slice(0, 10), "2026-08-03", "debe seguir pagado");
    assert.equal(Number(body.amount), 195000);
  });

  test("un PUT sin campos no hace nada silenciosamente", async () => {
    await limpiar();
    await agregar("2026-08", { name: "Alquiler", amount: 180000, due_day: 1 });
    const [cargo] = (await api("/v2/fixed-expenses/months/2026-08")).body.items;
    const { status } = await api(`/v2/fixed-expenses/charges/${cargo.id}`, {
      method: "PUT", body: {}
    });
    assert.equal(status, 400);
  });
}
