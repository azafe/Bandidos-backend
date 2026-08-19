-- Migración 018: Devengamiento de gastos fijos (Etapa 1)
--
-- Convierte `fixed_expenses` en una PLANTILLA y agrega `fixed_expense_charges`
-- como el hecho contable: un cargo por gasto y por mes, con el monto CONGELADO
-- al momento de generarse. El total de un período se calcula siempre desde los
-- cargos, nunca desde la plantilla — mismo criterio que `supplier_movements`.
--
-- NOTA sobre el backfill histórico: el modelo anterior nunca guardó el monto
-- que tenía cada gasto en cada mes, así que esa información está genuinamente
-- perdida. El backfill congela el monto ACTUAL en todos los meses pasados. No
-- reconstruye la historia real, pero detiene la deriva: de acá en adelante los
-- meses cerrados dejan de reescribirse cuando se actualiza un monto.

BEGIN;

-- ── 1. Vigencia y auditoría en la plantilla ─────────────────────────────────
ALTER TABLE fixed_expenses ADD COLUMN IF NOT EXISTS start_date date;
ALTER TABLE fixed_expenses ADD COLUMN IF NOT EXISTS end_date   date;
ALTER TABLE fixed_expenses ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Los gastos existentes se consideran vigentes desde el mes en que se cargaron.
UPDATE fixed_expenses
   SET start_date = date_trunc('month', created_at)::date
 WHERE start_date IS NULL;

-- Default para que todo INSERT existente (seed, POST /v2/fixed-expenses) siga
-- funcionando sin pasar start_date: un gasto nuevo rige desde el mes en curso.
ALTER TABLE fixed_expenses ALTER COLUMN start_date SET DEFAULT date_trunc('month', CURRENT_DATE)::date;
ALTER TABLE fixed_expenses ALTER COLUMN start_date SET NOT NULL;

-- Un gasto hoy inactivo dejó de devengar a fin del mes pasado, pero conserva
-- su historia previa en lugar de desaparecer retroactivamente de todo.
UPDATE fixed_expenses
   SET end_date = (date_trunc('month', CURRENT_DATE) - INTERVAL '1 day')::date
 WHERE status <> 'active'
   AND end_date IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fixed_expenses_vigencia_check'
  ) THEN
    ALTER TABLE fixed_expenses
      ADD CONSTRAINT fixed_expenses_vigencia_check
      CHECK (end_date IS NULL OR end_date >= start_date);
  END IF;
END $$;

-- ── 2. Cargos devengados ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fixed_expense_charges (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT: borrar una plantilla con historia devengada queda bloqueado.
  fixed_expense_id uuid NOT NULL REFERENCES fixed_expenses(id) ON DELETE RESTRICT,
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  period           date NOT NULL,                 -- primer día del mes devengado
  due_date         date NOT NULL,                 -- due_day clampeado al mes real
  amount           numeric(12,2) NOT NULL CHECK (amount >= 0),
  paid_at          date,
  paid_amount      numeric(12,2) CHECK (paid_amount IS NULL OR paid_amount >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Distinto de created_at = el monto de ese mes fue corregido a mano. Es la
  -- única forma de arreglar lo que el backfill no pudo saber.
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fixed_expense_id, period)
);

-- Por si la tabla ya existía de una corrida anterior de esta misma migración.
ALTER TABLE fixed_expense_charges
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_fec_tenant_due
  ON fixed_expense_charges(tenant_id, due_date);
CREATE INDEX IF NOT EXISTS idx_fec_tenant_period
  ON fixed_expense_charges(tenant_id, period);
CREATE INDEX IF NOT EXISTS idx_fec_unpaid
  ON fixed_expense_charges(tenant_id, due_date) WHERE paid_at IS NULL;

-- ── 3. Backfill de cargos desde la vigencia de cada gasto ───────────────────
INSERT INTO fixed_expense_charges (fixed_expense_id, tenant_id, period, due_date, amount)
SELECT
  fe.id,
  fe.tenant_id,
  m.period::date,
  (
    m.period
    + (LEAST(
         fe.due_day,
         EXTRACT(DAY FROM (m.period + INTERVAL '1 month' - INTERVAL '1 day'))::int
       ) - 1) * INTERVAL '1 day'
  )::date,
  fe.amount
FROM fixed_expenses fe
CROSS JOIN LATERAL generate_series(
  date_trunc('month', fe.start_date::timestamp),
  date_trunc('month', COALESCE(fe.end_date, CURRENT_DATE)::timestamp),
  INTERVAL '1 month'
) AS m(period)
ON CONFLICT (fixed_expense_id, period) DO NOTHING;

-- ── 4. Comisión por empleado ────────────────────────────────────────────────
-- Default 0.40 = la constante que estaba hardcodeada en el frontend, así que
-- migrar no cambia ningún número hasta que el dueño ajuste las tasas reales.
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS commission_rate numeric(5,4) NOT NULL DEFAULT 0.40
  CHECK (commission_rate >= 0 AND commission_rate <= 1);

COMMIT;
