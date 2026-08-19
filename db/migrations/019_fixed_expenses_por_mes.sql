-- Migración 019: el mes pasa a ser la unidad editable
--
-- La 018 dejó un cargo por gasto y por mes, pero el cargo solo era dueño del
-- monto: nombre, categoría, método de pago y proveedor seguían viviendo en la
-- plantilla. Renombrar un gasto lo renombraba en TODOS los meses, hacia atrás
-- incluido — el mismo problema de reescritura de historia que la 018 resolvió
-- para el monto.
--
-- Acá el cargo pasa a llevar su propio snapshot de esos campos. La plantilla
-- (fixed_expenses) queda como catálogo: sirve para dar de alta un gasto nuevo
-- y para sembrar el primer mes. De ahí en adelante cada mes se arma copiando
-- el anterior, y editar un mes no toca ningún otro.

BEGIN;

-- ── 1. El cargo se vuelve autónomo ──────────────────────────────────────────
ALTER TABLE fixed_expense_charges
  ADD COLUMN IF NOT EXISTS name              text,
  ADD COLUMN IF NOT EXISTS category_id       uuid REFERENCES expense_categories(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS payment_method_id uuid REFERENCES payment_methods(id)    ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS supplier_id       uuid REFERENCES suppliers(id)          ON DELETE SET NULL;

-- Snapshot inicial: lo que hoy dice la plantilla.
UPDATE fixed_expense_charges c
   SET name              = COALESCE(c.name, f.name),
       category_id       = COALESCE(c.category_id, f.category_id),
       payment_method_id = COALESCE(c.payment_method_id, f.payment_method_id),
       supplier_id       = COALESCE(c.supplier_id, f.supplier_id)
  FROM fixed_expenses f
 WHERE f.id = c.fixed_expense_id;

ALTER TABLE fixed_expense_charges ALTER COLUMN name SET NOT NULL;

-- El cargo guardaba solo due_date (la fecha ya resuelta). Al copiar de un mes
-- a otro se heredaba esa fecha, así que un vencimiento 31 que pasaba por un mes
-- de 30 días quedaba en 30 PARA SIEMPRE. Guardar el día pedido por separado
-- mantiene la intención: due_date se recalcula contra cada mes.
ALTER TABLE fixed_expense_charges
  ADD COLUMN IF NOT EXISTS due_day int CHECK (due_day BETWEEN 1 AND 31);

UPDATE fixed_expense_charges c
   SET due_day = COALESCE(f.due_day, EXTRACT(DAY FROM c.due_date)::int)
  FROM fixed_expenses f
 WHERE f.id = c.fixed_expense_id AND c.due_day IS NULL;

UPDATE fixed_expense_charges
   SET due_day = EXTRACT(DAY FROM due_date)::int
 WHERE due_day IS NULL;

ALTER TABLE fixed_expense_charges ALTER COLUMN due_day SET NOT NULL;

-- Un mes puede tener un ítem que no venga de ninguna plantilla (lo agregó el
-- admin suelto en ese mes), así que el vínculo pasa a ser opcional.
ALTER TABLE fixed_expense_charges ALTER COLUMN fixed_expense_id DROP NOT NULL;

-- El UNIQUE (fixed_expense_id, period) impedía dos ítems sueltos en el mismo
-- mes, porque en Postgres los NULL no chocan entre sí pero sí bloqueaban el
-- alta repetida desde una misma plantilla. Se reemplaza por un índice parcial
-- que solo aplica cuando hay plantilla detrás.
ALTER TABLE fixed_expense_charges
  DROP CONSTRAINT IF EXISTS fixed_expense_charges_fixed_expense_id_period_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_fec_plantilla_periodo
  ON fixed_expense_charges(fixed_expense_id, period)
  WHERE fixed_expense_id IS NOT NULL;

-- ── 2. Marca de mes armado ──────────────────────────────────────────────────
-- Sin esto no se puede distinguir "el mes está vacío porque nadie lo armó" de
-- "el admin lo armó y borró todos los ítems". Y hace falta para que borrar un
-- ítem sea definitivo en vez de reaparecer en la próxima consulta.
CREATE TABLE IF NOT EXISTS fixed_expense_periods (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  period     date NOT NULL,
  -- De dónde salió la lista. 'backfill' es el caso delicado: son los meses que
  -- esta migración completó con el monto ACTUAL de cada gasto, porque el modelo
  -- viejo nunca guardó el histórico. Son estimaciones, no lo que se pagó, y la
  -- pantalla tiene que decirlo.
  source     text NOT NULL DEFAULT 'manual'
             CHECK (source IN ('copy', 'seed', 'manual', 'backfill')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period)
);

CREATE INDEX IF NOT EXISTS idx_fep_tenant_period
  ON fixed_expense_periods(tenant_id, period);

-- Todo mes que ya tiene cargos (los que generó el backfill de la 018) cuenta
-- como armado, pero marcado como 'backfill': sus montos son los actuales
-- aplicados hacia atrás, no los que se pagaron en su momento.
INSERT INTO fixed_expense_periods (tenant_id, period, source)
SELECT DISTINCT c.tenant_id, c.period, 'backfill'
  FROM fixed_expense_charges c
ON CONFLICT (tenant_id, period) DO NOTHING;

COMMIT;
