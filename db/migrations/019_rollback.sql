-- Rollback de las migraciones 018 y 019.
--
-- Las dos son puramente aditivas: crean tablas y columnas nuevas, y no borran
-- ni modifican ningún dato preexistente. Por eso deshacerlas es exacto —
-- basta con tirar lo que agregaron.
--
-- Lo ÚNICO que se pierde al correr esto son los cargos mensuales y los meses
-- armados, es decir el trabajo hecho dentro del módulo nuevo. Si el dueño ya
-- corrigió montos de meses pasados o marcó pagos, eso se va. Los gastos fijos
-- originales quedan intactos.
--
-- No es un archivo para correr por rutina: existe para poder revertir un
-- deploy fallido sin restaurar el backup entero.

BEGIN;

-- Tablas creadas por la 018 y la 019.
DROP TABLE IF EXISTS fixed_expense_periods;
DROP TABLE IF EXISTS fixed_expense_charges;

-- Columnas agregadas a tablas preexistentes.
ALTER TABLE fixed_expenses
  DROP CONSTRAINT IF EXISTS fixed_expenses_vigencia_check;

ALTER TABLE fixed_expenses
  DROP COLUMN IF EXISTS start_date,
  DROP COLUMN IF EXISTS end_date,
  DROP COLUMN IF EXISTS updated_at;

ALTER TABLE employees
  DROP COLUMN IF EXISTS commission_rate;

COMMIT;

-- Después de esto, fixed_expenses y employees quedan exactamente como estaban
-- antes de migrar. Verificar con: node scripts/inspeccionar-schema.mjs
