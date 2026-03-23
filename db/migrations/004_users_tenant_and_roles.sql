-- Migración 004: Agregar tenant_id a users y asignar roles
-- Ejecutar DESPUÉS de 003_create_tenants.sql y de verificar que Bandidos quedó como tenant #1

-- 1. Agregar columna tenant_id a users (nullable: SUPER_ADMIN no tiene tenant)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT;

-- 2. Promover a SUPER_ADMIN (dueño del SaaS, sin tenant asignado)
UPDATE users
SET role = 'super_admin'
WHERE email = 'alvarozafe@gmail.com';

-- 3. Asignar rol ADMIN y tenant #1 al administrador de Bandidos
UPDATE users
SET role      = 'admin',
    tenant_id = '00000000-0000-0000-0000-000000000001'
WHERE email = 'jsafe@safe.com.ar';

-- 4. Asignar tenant #1 a todos los demás usuarios existentes (staff)
--    Excluye al super_admin que debe quedar con tenant_id = NULL
UPDATE users
SET tenant_id = '00000000-0000-0000-0000-000000000001'
WHERE tenant_id IS NULL
  AND role != 'super_admin';

-- Verificación: ejecutar esto después para confirmar que todo quedó bien
-- SELECT id, email, role, tenant_id FROM users ORDER BY created_at;
