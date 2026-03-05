-- Allow service_type_id to be null on agenda_turnos
-- service_type is filled in when the turno is finalized, not at creation
ALTER TABLE agenda_turnos ALTER COLUMN service_type_id DROP NOT NULL;
