-- Migración 006: Añadir configuración de módulos habilitados a tenants
-- Permite habilitar/deshabilitar secciones del SaaS por cada tenant.

ALTER TABLE tenants 
ADD COLUMN IF NOT EXISTS enabled_modules jsonb NOT NULL DEFAULT '{
  "dashboard": true,
  "agenda": true,
  "services": true,
  "customers": true,
  "pets": true,
  "expenses": true,
  "employees": true,
  "suppliers": true,
  "catalog": true,
  "petshop": true,
  "comunicaciones": true
}';

-- Asegurar que Bandidos tiene todo habilitado por defecto
UPDATE tenants 
SET enabled_modules = '{
  "dashboard": true,
  "agenda": true,
  "services": true,
  "customers": true,
  "pets": true,
  "expenses": true,
  "employees": true,
  "suppliers": true,
  "catalog": true,
  "petshop": true,
  "comunicaciones": true
}'
WHERE id = '00000000-0000-0000-0000-000000000001';
