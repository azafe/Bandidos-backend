// Aplica la migración 020 (archivado de mascotas + vendedor en PetShop).
//
//   node scripts/migrar-020.mjs           -> simulacro, no escribe nada
//   node scripts/migrar-020.mjs --aplicar -> aplica de verdad
//
// Son ALTER TABLE ... ADD COLUMN IF NOT EXISTS: no tocan ninguna fila y se
// pueden correr dos veces sin romper nada.

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

const existeColumna = async (tabla, columna) =>
  (await q(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [tabla, columna]
  )).length > 0;

const ARCHIVO = "020_pets_archive_and_petshop_stylist.sql";
const COLUMNAS = [
  ["pets", "archived_at"],
  ["petshop_sales", "stylist_id"]
];

console.log(APLICAR ? "MODO APLICAR — se va a escribir\n" : "SIMULACRO — no se escribe nada\n");

console.log("── Estado previo ──");
const previo = [];
for (const [t, c] of COLUMNAS) {
  const existe = await existeColumna(t, c);
  previo.push(existe);
  console.log(`  ${t}.${c.padEnd(12)} : ${existe ? "YA EXISTE" : "pendiente"}`);
}

const [{ mascotas }] = await q("SELECT COUNT(*)::int AS mascotas FROM pets");
console.log(`  mascotas cargadas   : ${mascotas}`);

if (previo.every(Boolean)) {
  console.log("\nNada que hacer: las dos columnas ya están.");
  await pool.end();
  process.exit(0);
}

if (!APLICAR) {
  console.log(`\n── Qué haría ──\n  correr ${ARCHIVO}`);
  console.log("\nVolvé a correrlo con --aplicar para hacerlo de verdad.");
  await pool.end();
  process.exit(0);
}

console.log(`\n── Aplicando ──\n  ${ARCHIVO} ...`);
try {
  await pool.query(
    fs.readFileSync(
      path.join(import.meta.dirname, "..", "db", "migrations", ARCHIVO),
      "utf8"
    )
  );
  console.log("  OK");
} catch (err) {
  console.log("  FALLÓ");
  console.error(`\n  ${err.message}`);
  await pool.end();
  process.exit(1);
}

console.log("\n── Verificación ──");
for (const [t, c] of COLUMNAS) {
  console.log(`  ${(await existeColumna(t, c)) ? "ok   " : "FALTA"} ${t}.${c}`);
}

const [{ archivadas }] = await q(
  "SELECT COUNT(*)::int AS archivadas FROM pets WHERE archived_at IS NOT NULL"
);
console.log(`\n  mascotas archivadas: ${archivadas} (arranca en 0, como corresponde)`);

await pool.end();
