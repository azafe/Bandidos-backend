BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS employees_tenant_id_id ON employees (tenant_id, id);
ALTER TABLE agenda_turnos ADD COLUMN IF NOT EXISTS second_groomer_id uuid;
ALTER TABLE services ADD COLUMN IF NOT EXISTS second_groomer_id uuid;
ALTER TABLE agenda_turnos ADD CONSTRAINT agenda_shared_groomer_distinct
  CHECK (second_groomer_id IS NULL OR (groomer_id IS NOT NULL AND groomer_id <> second_groomer_id));
ALTER TABLE services ADD CONSTRAINT services_shared_groomer_distinct
  CHECK (second_groomer_id IS NULL OR (groomer_id IS NOT NULL AND groomer_id <> second_groomer_id));
ALTER TABLE agenda_turnos ADD CONSTRAINT agenda_second_groomer_tenant_fk
  FOREIGN KEY (tenant_id, second_groomer_id) REFERENCES employees (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE services ADD CONSTRAINT services_second_groomer_tenant_fk
  FOREIGN KEY (tenant_id, second_groomer_id) REFERENCES employees (tenant_id, id) ON DELETE RESTRICT;
COMMIT;
