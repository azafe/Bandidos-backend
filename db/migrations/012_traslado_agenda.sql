ALTER TABLE agenda_turnos
  ADD COLUMN IF NOT EXISTS traslado boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS traslado_direccion text;
