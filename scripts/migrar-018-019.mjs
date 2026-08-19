// Aplica las migraciones 018 y 019, en ese orden, verificando antes y después.
//
//   node scripts/migrar-018-019.mjs           -> simulacro, no escribe nada
//   node scripts/migrar-018-019.mjs --aplicar -> aplica de verdad
//
// Cada migración corre dentro de su propia transacción (BEGIN/COMMIT están en
// los .sql), así que un error deja la base como estaba. Aun así: hacer backup
// antes. El backfill de la 018 genera cargos con los montos ACTUALES, y eso no
// se deshace solo.

import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { buildPoolConfig } from "../src/dbConfig.js";

const APLICAR = process.argv.includes("--aplicar");

// Carga .env sin imprimirlo nunca.
const envPath = path.join(import.meta.dirname, "..", ".env");
for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
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
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

const existeTabla = async (nombre) =>
  (await q(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name=$1`, [nombre]
  )).length > 0;

const existeColumna = async (tabla, columna) =>
  (await q(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [tabla, columna]
  )).length > 0;

// Las fechas vienen como Date de pg; se imprimen como YYYY-MM-DD.
const fecha = (v) => (v ? new Date(v).toISOString().slice(0, 10) : "-");

const migracionesDir = path.join(import.meta.dirname, "..", "db", "migrations");
const leer = (f) => fs.readFileSync(path.join(migracionesDir, f), "utf8");

console.log(APLICAR ? "MODO APLICAR — se va a escribir\n" : "SIMULACRO — no se escribe nada\n");

// ── Estado previo ───────────────────────────────────────────────────────────
const yaHay018 = await existeTabla("fixed_expense_charges");
const yaHay019 = await existeTabla("fixed_expense_periods");

console.log("── Estado previo ──");
console.log(`  018 (fixed_expense_charges) : ${yaHay018 ? "YA APLICADA" : "pendiente"}`);
console.log(`  019 (fixed_expense_periods) : ${yaHay019 ? "YA APLICADA" : "pendiente"}`);

const [{ total, activos, mas_antiguo }] = await q(`
  SELECT COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status='active')::int AS activos,
         MIN(created_at)::date AS mas_antiguo
    FROM fixed_expenses`);
console.log(`  gastos fijos: ${total} (${activos} activos), el más antiguo del ${fecha(mas_antiguo)}`);

if (yaHay018 && yaHay019) {
  console.log("\nNada que hacer: las dos ya están aplicadas.");
  await pool.end();
  process.exit(0);
}

if (!APLICAR) {
  console.log("\n── Qué haría ──");
  if (!yaHay018) console.log("  1. correr 018_fixed_expenses_accrual.sql");
  if (!yaHay019) console.log("  2. correr 019_fixed_expenses_por_mes.sql");
  console.log("\nVolvé a correrlo con --aplicar para hacerlo de verdad.");
  await pool.end();
  process.exit(0);
}

// ── Aplicar ─────────────────────────────────────────────────────────────────
console.log("\n── Aplicando ──");
for (const archivo of ["018_fixed_expenses_accrual.sql", "019_fixed_expenses_por_mes.sql"]) {
  process.stdout.write(`  ${archivo} ... `);
  try {
    await pool.query(leer(archivo));
    console.log("OK");
  } catch (err) {
    console.log("FALLÓ");
    console.error(`\n  ${err.message}`);
    console.error("\n  La transacción se revirtió sola. La base quedó como estaba.");
    await pool.end();
    process.exit(1);
  }
}

// ── Verificación posterior ──────────────────────────────────────────────────
console.log("\n── Verificación ──");
for (const [t, c] of [
  ["fixed_expenses", "start_date"],
  ["fixed_expenses", "end_date"],
  ["fixed_expenses", "updated_at"],
  ["employees", "commission_rate"],
  ["fixed_expense_charges", "due_day"],
  ["fixed_expense_charges", "name"]
]) {
  console.log(`  ${(await existeColumna(t, c)) ? "ok   " : "FALTA"} ${t}.${c}`);
}

const cargos = await q(`
  SELECT COUNT(*)::int AS n,
         MIN(period)::date AS desde,
         MAX(period)::date AS hasta
    FROM fixed_expense_charges`);
const periodos = await q(`
  SELECT source, COUNT(*)::int AS n FROM fixed_expense_periods
   GROUP BY source ORDER BY source`);

console.log(`\n  cargos generados: ${cargos[0].n}`);
console.log(`  períodos         : ${fecha(cargos[0].desde)} a ${fecha(cargos[0].hasta)}`);
for (const p of periodos) console.log(`    ${p.source}: ${p.n} meses`);

console.log("\nListo. Los meses marcados 'backfill' llevan los montos ACTUALES");
console.log("aplicados hacia atrás: son estimaciones, y la pantalla lo avisa.");

await pool.end();
