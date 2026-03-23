-- Migración 007: Agregar motivo de suspensión a tenants
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspended_reason text;
