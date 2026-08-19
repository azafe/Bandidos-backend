// Verificación SOLO LECTURA del resultado de las migraciones 018 y 019.
//
// Contrasta los cargos generados contra lo que se esperaba: un cargo por gasto
// y por mes de vigencia, sin huecos ni duplicados.
//
//   node scripts/verificar-migracion.mjs

import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { buildPoolConfig } from "../src/dbConfig.js";

const envPath = path.join(import.meta.dirname, "..", ".env");
for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i < 0) continue;
  process.env[t.slice(0, i)] ??= t.slice(i + 1);
}

const pool = new pg.Pool({ ...buildPoolConfig(process.env.DATABASE_URL), max: 1 });
const client = await pool.connect();
await client.query("SET default_transaction_read_only = on");
const q = async (sql, p = []) => (await client.query(sql, p)).rows;

const f = (v) => (v ? new Date(v).toISOString().slice(0, 10) : "-");
const money = (v) => "$" + Number(v).toLocaleString("es-AR", { maximumFractionDigits: 0 });

console.log("Conectado en solo lectura.\n");

// ── Por tenant ──────────────────────────────────────────────────────────────
console.log("── Cargos y períodos por tenant ──");
for (const r of await q(`
  SELECT t.name,
         COUNT(DISTINCT f.id)::int                      AS gastos,
         COUNT(c.id)::int                               AS cargos,
         COUNT(DISTINCT c.period)::int                  AS meses,
         MIN(c.period)::date                            AS desde,
         MAX(c.period)::date                            AS hasta
    FROM tenants t
    LEFT JOIN fixed_expenses f      ON f.tenant_id = t.id
    LEFT JOIN fixed_expense_charges c ON c.fixed_expense_id = f.id
   GROUP BY t.name ORDER BY t.name`)) {
  console.log(`  ${r.name}: ${r.gastos} gastos, ${r.cargos} cargos en ${r.meses} meses (${f(r.desde)} a ${f(r.hasta)})`);
}

// La cuenta correcta NO es meses x gastos: cada gasto devenga desde SU vigencia.
console.log("\n── ¿Cuadra la cuenta? ──");
const [chequeo] = await q(`
  WITH esperado AS (
    SELECT fe.id,
           (EXTRACT(YEAR  FROM age(date_trunc('month', COALESCE(fe.end_date, CURRENT_DATE)),
                                   date_trunc('month', fe.start_date))) * 12
          + EXTRACT(MONTH FROM age(date_trunc('month', COALESCE(fe.end_date, CURRENT_DATE)),
                                   date_trunc('month', fe.start_date))) + 1)::int AS meses
      FROM fixed_expenses fe
  )
  SELECT (SELECT SUM(meses)::int FROM esperado)                    AS esperados,
         (SELECT COUNT(*)::int FROM fixed_expense_charges)         AS reales`);
console.log(`  cargos esperados (suma de la vigencia de cada gasto): ${chequeo.esperados}`);
console.log(`  cargos realmente generados                         : ${chequeo.reales}`);
console.log(`  ${chequeo.esperados === chequeo.reales ? "COINCIDE ✓" : "NO COINCIDE ✗"}`);

// ── Integridad ──────────────────────────────────────────────────────────────
console.log("\n── Integridad ──");
const [dup] = await q(`
  SELECT COUNT(*)::int AS n FROM (
    SELECT fixed_expense_id, period FROM fixed_expense_charges
     WHERE fixed_expense_id IS NOT NULL
     GROUP BY 1,2 HAVING COUNT(*) > 1) x`);
console.log(`  ${dup.n === 0 ? "ok   " : "FALLA"} sin cargos duplicados por gasto/mes (${dup.n})`);

const [huecos] = await q(`
  SELECT COUNT(*)::int AS n FROM fixed_expenses fe
   CROSS JOIN LATERAL generate_series(
     date_trunc('month', fe.start_date::timestamp),
     date_trunc('month', COALESCE(fe.end_date, CURRENT_DATE)::timestamp),
     INTERVAL '1 month') m(period)
   WHERE NOT EXISTS (
     SELECT 1 FROM fixed_expense_charges c
      WHERE c.fixed_expense_id = fe.id AND c.period = m.period::date)`);
console.log(`  ${huecos.n === 0 ? "ok   " : "FALLA"} sin meses faltantes dentro de la vigencia (${huecos.n})`);

const [nulos] = await q(`
  SELECT COUNT(*)::int AS n FROM fixed_expense_charges
   WHERE name IS NULL OR due_day IS NULL OR amount IS NULL OR category_id IS NULL`);
console.log(`  ${nulos.n === 0 ? "ok   " : "FALLA"} sin campos vacíos en los cargos (${nulos.n})`);

const [clamp] = await q(`
  SELECT COUNT(*)::int AS n FROM fixed_expense_charges
   WHERE EXTRACT(DAY FROM due_date)::int
         <> LEAST(due_day, EXTRACT(DAY FROM (period + INTERVAL '1 month' - INTERVAL '1 day'))::int)`);
console.log(`  ${clamp.n === 0 ? "ok   " : "FALLA"} vencimientos bien clampeados al mes (${clamp.n} mal)`);

// ── Los montos del mes en curso deben dar el run-rate ─────────────────────
console.log("\n── Mes en curso ──");
for (const r of await q(`
  SELECT t.name,
         SUM(c.amount)                                          AS cargos,
         (SELECT SUM(amount) FROM fixed_expenses f2
           WHERE f2.tenant_id = t.id AND f2.status='active')     AS plantillas
    FROM tenants t
    JOIN fixed_expense_charges c ON c.tenant_id = t.id
   WHERE c.period = date_trunc('month', CURRENT_DATE)::date
   GROUP BY t.id, t.name ORDER BY t.name`)) {
  const igual = Number(r.cargos) === Number(r.plantillas);
  console.log(`  ${r.name}: cargos ${money(r.cargos)} vs plantillas activas ${money(r.plantillas)} ${igual ? "✓" : "(difieren: hay gastos dados de baja)"}`);
}

console.log("\n── Períodos marcados ──");
for (const r of await q(`
  SELECT t.name, p.source, COUNT(*)::int AS n
    FROM fixed_expense_periods p JOIN tenants t ON t.id = p.tenant_id
   GROUP BY t.name, p.source ORDER BY t.name`)) {
  console.log(`  ${r.name}: ${r.n} períodos '${r.source}'`);
}

await client.release();
await pool.end();
console.log("\nNo se escribió nada.");
