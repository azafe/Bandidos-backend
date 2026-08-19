// Inspección SOLO LECTURA del schema de producción.
//
// Sirve para saber qué migraciones están realmente aplicadas antes de correr
// la 018 y la 019, porque el repo no tiene runner ni tabla de migraciones.
//
// No escribe nada: la sesión se pone en default_transaction_read_only.
// Borrar este archivo cuando ya no haga falta.
//
//   node inspeccionar-schema.mjs

import fs from "node:fs";
import pg from "pg";
import { buildPoolConfig } from "./src/dbConfig.js";

// Carga .env sin imprimirlo nunca.
for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i < 0) continue;
  process.env[t.slice(0, i)] ??= t.slice(i + 1);
}

const pool = new pg.Pool({
  ...buildPoolConfig(process.env.DATABASE_URL),
  max: 1
});
const client = await pool.connect();

// Cinturón de seguridad: la sesión no puede escribir aunque se quisiera.
await client.query("SET default_transaction_read_only = on");
await client.query("SET statement_timeout = '20s'");

const q = async (sql, params = []) => (await client.query(sql, params)).rows;
const has = async (table, column) =>
  (await q(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [table, column]
  )).length > 0;

console.log("Conectado en modo solo lectura.\n");

// ── Tablas ──────────────────────────────────────────────────────────────────
const tablas = (
  await q(`SELECT table_name FROM information_schema.tables
            WHERE table_schema='public' AND table_type='BASE TABLE'
            ORDER BY table_name`)
).map((r) => r.table_name);

console.log(`── Tablas (${tablas.length}) ──`);
console.log("  " + tablas.join(", ") + "\n");

// ── Qué migraciones dejaron rastro ──────────────────────────────────────────
// Cada migración se detecta por el artefacto que crea.
const rastros = [
  ["003 tenants",               async () => tablas.includes("tenants")],
  ["004 users.tenant_id",       () => has("users", "tenant_id")],
  ["005 tenant_id en datos",    () => has("fixed_expenses", "tenant_id")],
  ["006 enabled_modules",       () => has("tenants", "enabled_modules")],
  ["007 suspended_reason",      () => has("tenants", "suspended_reason")],
  ["010 supplier_movements",    async () => tablas.includes("supplier_movements")],
  ["011 comunicaciones",        async () => tablas.includes("comunicaciones_enviadas")],
  ["012 traslado agenda",       () => has("agenda_turnos", "traslado")],
  ["013 push_subscriptions",    async () => tablas.includes("push_subscriptions")],
  ["014 daily_incomes",         async () => tablas.includes("daily_incomes")],
  ["016 photo_url",             () => has("pets", "photo_url")],
  ["017 agenda_day_notes",      async () => tablas.includes("agenda_day_notes")],
  ["018 devengamiento",         async () => tablas.includes("fixed_expense_charges")],
  ["019 mes editable",          async () => tablas.includes("fixed_expense_periods")]
];

console.log("── Migraciones aplicadas (por su rastro en el schema) ──");
for (const [nombre, check] of rastros) {
  console.log(`  ${(await check()) ? "APLICADA " : "falta    "} ${nombre}`);
}

// ── Columnas que agregan mis migraciones ────────────────────────────────────
console.log("\n── Columnas que agregan la 018 / 019 (deberían faltar todas) ──");
for (const [t, c] of [
  ["fixed_expenses", "start_date"],
  ["fixed_expenses", "end_date"],
  ["fixed_expenses", "updated_at"],
  ["employees", "commission_rate"]
]) {
  console.log(`  ${(await has(t, c)) ? "YA EXISTE" : "falta    "} ${t}.${c}`);
}

// ── Volumen y antigüedad: define el alcance del backfill ────────────────────
console.log("\n── Datos reales de gastos fijos ──");
const resumen = await q(`
  SELECT COUNT(*)::int                                    AS total,
         COUNT(*) FILTER (WHERE status='active')::int     AS activos,
         MIN(created_at)::date                            AS mas_antiguo,
         COALESCE(SUM(amount) FILTER (WHERE status='active'),0) AS total_mensual
    FROM fixed_expenses`);
const r = resumen[0];
console.log(`  gastos fijos      : ${r.total} (${r.activos} activos)`);
console.log(`  más antiguo       : ${r.mas_antiguo}`);
console.log(`  total mensual     : $${Number(r.total_mensual).toLocaleString("es-AR")}`);

if (r.mas_antiguo) {
  const meses = await q(
    `SELECT (EXTRACT(YEAR FROM age(CURRENT_DATE, MIN(created_at)))*12
           + EXTRACT(MONTH FROM age(CURRENT_DATE, MIN(created_at))))::int AS meses
       FROM fixed_expenses`
  );
  const m = meses[0].meses + 1;
  console.log(`  meses a backfillear: ~${m}`);
  console.log(`  cargos a generar   : ~${m * r.total}  <-- todos con el monto de HOY`);
}

console.log("\n── Tenants ──");
for (const t of await q(
  `SELECT name, status, (SELECT COUNT(*)::int FROM fixed_expenses f WHERE f.tenant_id=t.id) AS gastos
     FROM tenants t ORDER BY name`
)) {
  console.log(`  ${t.name} (${t.status}): ${t.gastos} gastos fijos`);
}

await client.release();
await pool.end();
console.log("\nListo. No se escribió nada.");
