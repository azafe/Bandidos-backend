-- 022: agrega el método de pago propio de la seña/anticipo.
--
-- Hasta ahora agenda_turnos.payment_method_id solo registraba el método de
-- pago del saldo final. Cuando la seña se cobraba con un medio distinto al
-- del saldo (por ejemplo seña por transferencia y saldo en efectivo, o al
-- revés), el sistema no tenía dónde guardarlo, lo que generaba diferencias
-- de caja difíciles de rastrear.
ALTER TABLE agenda_turnos
  ADD COLUMN IF NOT EXISTS deposit_payment_method_id uuid REFERENCES payment_methods(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_agenda_turnos_deposit_payment_method_id
  ON agenda_turnos (deposit_payment_method_id);
