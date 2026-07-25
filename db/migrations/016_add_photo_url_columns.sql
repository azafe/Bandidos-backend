-- Migración 016: Agregar photo_url a pets y agenda_turnos
ALTER TABLE pets ADD COLUMN IF NOT EXISTS photo_url text;
ALTER TABLE agenda_turnos ADD COLUMN IF NOT EXISTS photo_url text;
