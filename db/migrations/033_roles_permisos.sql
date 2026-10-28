-- Roles y permisos por módulo, adaptado del módulo Permisos de la ONG.
--
-- Hasta acá había dos puertas fijas en el código: admin veía todo y staff lo
-- que el menú le mostraba. Ahora hay más roles (Recepción, Peluquero/a,
-- Administración, además de Staff) y qué módulo abre cada uno lo decide el
-- admin de cada local desde Usuarios › Permisos, sin deploy.
--
--  * tenant_role_permissions: una fila por local y rol, con sus módulos. Sin
--    fila, el rol usa sus módulos por defecto (src/permissions.js): Staff
--    arranca exactamente con lo que veía antes, así nadie pierde nada.
--  * admin no tiene filas: entra a todo siempre, para que ningún local quede
--    sin quien administre los permisos.
--  * El backend hace cumplir cada módulo endpoint por endpoint.
--
-- Aditiva y repetible.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('super_admin', 'admin', 'staff', 'user', 'recepcion', 'peluquero', 'administracion'));

CREATE TABLE IF NOT EXISTS tenant_role_permissions (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('staff', 'recepcion', 'peluquero', 'administracion')),
  modules text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (tenant_id, role)
);

-- Solo el backend lee y escribe (se conecta como el dueño de las tablas, que
-- no pasa por RLS). En Supabase, sin esto la API pública podría leerla.
ALTER TABLE tenant_role_permissions ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON tenant_role_permissions FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON tenant_role_permissions FROM authenticated;
  END IF;
END $$;
