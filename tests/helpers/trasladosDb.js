import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { handleAuthRevalidation } from "./authRevalidation.js";

// PostgreSQL real embebido: los CHECK, FK compuestos, transacciones y agregados
// se ejecutan, en lugar de repetir la implementación en un doble de SQL.
export async function createTrasladosDb({ realAuth = false } = {}) {
  const db = new PGlite({ parsers: { 1082: (value) => value } });
  await db.exec(`
    CREATE TABLE tenants(id uuid PRIMARY KEY,status text DEFAULT 'active',suspended_reason text,name text,logo_url text,primary_color text,secondary_color text,enabled_modules jsonb);
    CREATE TABLE users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid REFERENCES tenants(id),role text,email text UNIQUE,password_hash text,created_at timestamptz DEFAULT now());
    CREATE TABLE employees(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),name text,role text,phone text,email text,status text DEFAULT 'active',notes text,commission_rate numeric DEFAULT 0.40,created_at timestamptz DEFAULT now());
    CREATE TABLE payment_methods(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),name text,created_at timestamptz DEFAULT now());
    CREATE TABLE customers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,name text,phone text);
    CREATE TABLE pets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,name text,breed text,owner_name text,owner_phone text,customer_id uuid);
    CREATE TABLE service_types(id uuid PRIMARY KEY,tenant_id uuid,name text,default_price numeric DEFAULT 27000,created_at timestamptz DEFAULT now());
    CREATE TABLE comunicaciones_enviadas(tenant_id uuid,pet_id uuid,type text);
    CREATE TABLE agenda_turnos(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),date date NOT NULL,time time NOT NULL,duration integer DEFAULT 60,pet_id uuid,pet_name text,breed text,owner_name text,service_type_id uuid,payment_method_id uuid,deposit_payment_method_id uuid,price numeric,deposit_amount numeric NOT NULL DEFAULT 0,notes text,groomer_id uuid,status text DEFAULT 'reserved',traslado boolean NOT NULL DEFAULT false,traslado_direccion text,traslado_amount numeric NOT NULL DEFAULT 0,created_at timestamptz DEFAULT now());
    CREATE TABLE services(tenant_id uuid,date date,payment_method_id uuid,price numeric);
    CREATE TABLE expense_categories(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),name text,created_at timestamptz DEFAULT now());
    CREATE TABLE daily_expenses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),date date,category_id uuid REFERENCES expense_categories(id),description text,amount numeric,payment_method_id uuid,supplier_id uuid,created_at timestamptz DEFAULT now());
    CREATE TABLE fixed_expense_charges(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),period date,name text,category_id uuid REFERENCES expense_categories(id),amount numeric,paid_at date);
    CREATE TABLE fixed_expense_periods(tenant_id uuid NOT NULL REFERENCES tenants(id),period date,source text,UNIQUE(tenant_id,period));
    CREATE TABLE petshop_sales(tenant_id uuid,date date,payment_method_id uuid,total numeric);
    CREATE TABLE push_subscriptions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,device_id text,endpoint text,p256dh text,auth text,UNIQUE(tenant_id,device_id));
  `);
  await db.exec(
    await readFile(
      new URL(
        "../../db/migrations/024_traslado_bonificado.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const migration = await readFile(
    new URL("../../db/migrations/025_traslados_registros.sql", import.meta.url),
    "utf8",
  );
  await db.exec(migration);
  await db.exec(migration);
  const operationMigration = await readFile(new URL("../../db/migrations/026_traslados_operacion.sql", import.meta.url), "utf8");
  await db.exec(operationMigration);
  await db.exec(operationMigration);
  const historicalMigration = await readFile(new URL("../../db/migrations/027_traslados_historicos.sql", import.meta.url), "utf8");
  await db.exec(historicalMigration);
  await db.exec(historicalMigration);
  const resultsMigration = await readFile(new URL("../../db/migrations/028_traslados_resultados.sql", import.meta.url), "utf8");
  await db.exec(resultsMigration);
  await db.exec(resultsMigration);
  const statementsMigration = await readFile(new URL("../../db/migrations/029_traslados_rendiciones.sql", import.meta.url), "utf8");
  await db.exec(statementsMigration);
  await db.exec(statementsMigration);
  const teamMigration = await readFile(new URL("../../db/migrations/031_equipo_organigrama.sql", import.meta.url), "utf8");
  await db.exec(teamMigration);
  await db.exec(teamMigration);
  await db.exec(await readFile(new URL("../../db/migrations/035_cuentas_personales.sql", import.meta.url), "utf8"));
  let tail = Promise.resolve();
  const acquire = async () => {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  };
  const query = async (sql, params = []) => {
    const auth = realAuth ? null : handleAuthRevalidation(sql, params);
    if (auth) return auth;
    const result = await db.query(sql, params);
    return { ...result, rowCount: result.affectedRows || result.rows.length };
  };
  return {
    db,
    query,
    async connect() {
      const release = await acquire();
      return { query, release };
    },
    async close() {
      await db.close();
    },
  };
}
