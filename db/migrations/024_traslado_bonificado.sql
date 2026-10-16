-- NULL conserva la falta de clasificación histórica: un monto cero anterior
-- no demuestra que el traslado se haya bonificado. Las altas nuevas declaran
-- la decisión desde la API, sin actualizar ni reinterpretar datos existentes.
ALTER TABLE agenda_turnos
  ADD COLUMN IF NOT EXISTS traslado_bonificado boolean;
