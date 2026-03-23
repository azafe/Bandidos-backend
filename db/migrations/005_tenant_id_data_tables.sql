-- Migración 005: Agregar tenant_id a todas las tablas de datos
-- Ejecutar DESPUÉS de 004_users_tenant_and_roles.sql
-- Estrategia: agregar nullable → backfill → NOT NULL

-- ── 1. Agregar columnas tenant_id (nullable por ahora) ────────────────────

ALTER TABLE employees            ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE customers            ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE pets                 ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE service_types        ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE payment_methods      ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE agenda_turnos        ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE services             ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE suppliers            ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE petshop_products     ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE petshop_sales        ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE petshop_sale_items   ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE petshop_stock_movements ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE expense_categories   ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE daily_expenses       ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE fixed_expenses       ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT;

-- ── 2. Backfill: todos los datos existentes pertenecen a Bandidos ─────────

UPDATE employees            SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE customers            SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE pets                 SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE service_types        SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE payment_methods      SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE agenda_turnos        SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE services             SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE suppliers            SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE petshop_products     SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE petshop_sales        SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE petshop_sale_items   SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE petshop_stock_movements SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE expense_categories   SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE daily_expenses       SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE fixed_expenses       SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;

-- ── 3. Activar NOT NULL ahora que todos los registros tienen tenant_id ────

ALTER TABLE employees            ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE customers            ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE pets                 ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE service_types        ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE payment_methods      ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE agenda_turnos        ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE services             ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE suppliers            ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE petshop_products     ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE petshop_sales        ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE petshop_sale_items   ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE petshop_stock_movements ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE expense_categories   ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE daily_expenses       ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE fixed_expenses       ALTER COLUMN tenant_id SET NOT NULL;

-- ── 4. Índices para performance ───────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_employees_tenant            ON employees(tenant_id);
CREATE INDEX IF NOT EXISTS idx_customers_tenant            ON customers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_pets_tenant                 ON pets(tenant_id);
CREATE INDEX IF NOT EXISTS idx_service_types_tenant        ON service_types(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payment_methods_tenant      ON payment_methods(tenant_id);
CREATE INDEX IF NOT EXISTS idx_agenda_turnos_tenant        ON agenda_turnos(tenant_id);
CREATE INDEX IF NOT EXISTS idx_services_tenant             ON services(tenant_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_tenant            ON suppliers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_petshop_products_tenant     ON petshop_products(tenant_id);
CREATE INDEX IF NOT EXISTS idx_petshop_sales_tenant        ON petshop_sales(tenant_id);
CREATE INDEX IF NOT EXISTS idx_petshop_sale_items_tenant   ON petshop_sale_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_tenant      ON petshop_stock_movements(tenant_id);
CREATE INDEX IF NOT EXISTS idx_expense_categories_tenant   ON expense_categories(tenant_id);
CREATE INDEX IF NOT EXISTS idx_daily_expenses_tenant       ON daily_expenses(tenant_id);
CREATE INDEX IF NOT EXISTS idx_fixed_expenses_tenant       ON fixed_expenses(tenant_id);
