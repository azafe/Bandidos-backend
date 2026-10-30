-- Equipo: organigrama y personal, adaptado del módulo Equipo de la ONG.
--
-- Tres cosas que parecen una y no lo son:
--  * el PUESTO es la caja del organigrama: qué se hace y de quién depende.
--  * la PERSONA es alguien del personal: acá es la fila de `employees`, la
--    misma que usan la agenda, las comisiones y Bandimóviles.
--  * el PERMISO es users.role: qué pantallas abre. No vive acá.
-- Separarlos permite que en "Peluquería" haya tres personas, que alguien esté
-- en Recepción y en PetShop a la vez, y que cambiar a alguien sea moverlo sin
-- tocar el puesto.
--
-- Aditiva y repetible: no modifica empleados existentes.

ALTER TABLE employees ADD COLUMN IF NOT EXISTS dni text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS hire_date date;
-- Fecha de baja. La baja es lógica (status = 'inactive'): lo que hizo la
-- persona (turnos, comisiones, traslados) sigue a su nombre.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS end_date date;

-- Ya existe desde 025; se repite por si este archivo se aplica en otro orden.
CREATE UNIQUE INDEX IF NOT EXISTS employees_tenant_id_id ON employees(tenant_id, id);

CREATE TABLE IF NOT EXISTS team_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  -- Qué hace quien ocupa el puesto. Es lo que se lee al tocar la caja.
  description text,
  -- Solo decide el color de la caja; no agrupa ni da permisos.
  area text NOT NULL DEFAULT 'otro'
    CHECK (area IN ('direccion', 'administracion', 'recepcion', 'peluqueria', 'bandimoviles', 'petshop', 'otro')),
  -- null = arriba de todo. Borrar un puesto con otros debajo lo frena el
  -- backend (y la FK), para no llevarse medio organigrama de un toque. Los
  -- ciclos largos (A→B→A) los corta el backend antes de guardar.
  parent_id uuid,
  -- Orden entre hermanos del mismo jefe, de izquierda a derecha.
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT team_positions_parent_fk FOREIGN KEY (tenant_id, parent_id)
    REFERENCES team_positions(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT team_positions_not_self CHECK (parent_id IS DISTINCT FROM id)
);

CREATE INDEX IF NOT EXISTS idx_team_positions_parent ON team_positions(tenant_id, parent_id);

CREATE TABLE IF NOT EXISTS team_assignments (
  tenant_id uuid NOT NULL,
  position_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (position_id, employee_id),
  -- Puesto y persona siempre del mismo local.
  FOREIGN KEY (tenant_id, position_id) REFERENCES team_positions(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_team_assignments_employee ON team_assignments(tenant_id, employee_id);

-- Solo el backend lee y escribe (se conecta como el dueño de las tablas, que
-- no pasa por RLS). En Supabase, sin esto la API pública podría leerlas.
ALTER TABLE team_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_assignments ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON team_positions, team_assignments FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON team_positions, team_assignments FROM authenticated;
  END IF;
END $$;
