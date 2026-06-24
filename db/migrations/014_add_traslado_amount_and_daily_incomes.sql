-- Migración 014: Agregar traslado_amount a agenda_turnos y crear tablas de ingresos diarios

-- 1. Agregar columna traslado_amount a agenda_turnos (por defecto 0)
ALTER TABLE agenda_turnos 
  ADD COLUMN IF NOT EXISTS traslado_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (traslado_amount >= 0);

-- 2. Crear tabla daily_incomes
CREATE TABLE IF NOT EXISTS daily_incomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date date NOT NULL,
  concept text NOT NULL, -- 'servicios', 'señas', 'traslados', 'ventas_petshop'
  payment_method_id uuid NOT NULL REFERENCES payment_methods(id) ON DELETE RESTRICT,
  amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indice único para evitar duplicidades
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_incomes_date_concept_pm_tenant 
  ON daily_incomes (date, concept, payment_method_id, tenant_id);

-- 3. Crear tabla daily_income_notes
CREATE TABLE IF NOT EXISTS daily_income_notes (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  date date NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, date)
);
