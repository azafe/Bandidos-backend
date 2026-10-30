BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='users_employee_del_local') THEN
    ALTER TABLE users ADD CONSTRAINT users_employee_del_local
      FOREIGN KEY(tenant_id,employee_id) REFERENCES employees(tenant_id,id) ON DELETE RESTRICT;
    ALTER TABLE users ADD CONSTRAINT users_acceso_personal_valido CHECK (
      (employee_id IS NULL OR (tenant_id IS NOT NULL AND role IN ('staff','user'))) AND
      (employee_id IS NULL OR chofer_id IS NULL));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS users_persona_unica ON users(tenant_id,COALESCE(employee_id,chofer_id))
  WHERE COALESCE(employee_id,chofer_id) IS NOT NULL;

ALTER TABLE employees ADD COLUMN IF NOT EXISTS payroll_start_date date NOT NULL DEFAULT CURRENT_DATE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS opening_balance numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE agenda_turnos ADD COLUMN IF NOT EXISTS second_groomer_id uuid REFERENCES employees(id) ON DELETE RESTRICT;
ALTER TABLE agenda_turnos ADD COLUMN IF NOT EXISTS third_groomer_id uuid REFERENCES employees(id) ON DELETE RESTRICT;
ALTER TABLE agenda_turnos ADD COLUMN IF NOT EXISTS commission_rate_snapshot numeric(5,4)
  CHECK(commission_rate_snapshot BETWEEN 0 AND 1);
ALTER TABLE agenda_turnos ADD COLUMN IF NOT EXISTS commission_historical_estimate boolean NOT NULL DEFAULT false;

DROP TRIGGER IF EXISTS agenda_commission_snapshot ON agenda_turnos;

-- Solo conocemos el porcentaje actual para los trabajos anteriores. Se señala
-- explícitamente; no se presentan esos valores como pagos históricos reales.
UPDATE agenda_turnos a SET commission_rate_snapshot=COALESCE(e.commission_rate,0.40),
  commission_historical_estimate=true
FROM employees e WHERE e.tenant_id=a.tenant_id AND e.id=a.groomer_id
  AND a.status='finished' AND a.commission_rate_snapshot IS NULL;

CREATE OR REPLACE FUNCTION snapshot_groomer_commission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE participant uuid;
BEGIN
  IF NEW.second_groomer_id IS NOT NULL OR NEW.third_groomer_id IS NOT NULL THEN
    IF NEW.groomer_id IS NULL OR
       NEW.groomer_id=NEW.second_groomer_id OR NEW.groomer_id=NEW.third_groomer_id OR
       NEW.second_groomer_id=NEW.third_groomer_id THEN
      RAISE EXCEPTION 'Elegí peluqueras distintas y una principal' USING ERRCODE='23514';
    END IF;
  END IF;
  FOREACH participant IN ARRAY ARRAY[NEW.groomer_id,NEW.second_groomer_id,NEW.third_groomer_id] LOOP
    IF participant IS NOT NULL AND NOT EXISTS(SELECT 1 FROM employees WHERE id=participant AND tenant_id=NEW.tenant_id) THEN
      RAISE EXCEPTION 'El empleado debe pertenecer al mismo local' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF NEW.status='finished' AND NEW.groomer_id IS NOT NULL THEN
    IF TG_OP='INSERT' THEN
      SELECT COALESCE(commission_rate,0.40) INTO NEW.commission_rate_snapshot FROM employees WHERE id=NEW.groomer_id;
      NEW.commission_historical_estimate=false;
    ELSIF OLD.status IS DISTINCT FROM 'finished' OR OLD.groomer_id IS DISTINCT FROM NEW.groomer_id THEN
      SELECT COALESCE(commission_rate,0.40) INTO NEW.commission_rate_snapshot FROM employees WHERE id=NEW.groomer_id;
      NEW.commission_historical_estimate=false;
    ELSE
      NEW.commission_rate_snapshot=OLD.commission_rate_snapshot;
      NEW.commission_historical_estimate=OLD.commission_historical_estimate;
    END IF;
  ELSE
    NEW.commission_rate_snapshot=NULL;
    NEW.commission_historical_estimate=false;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agenda_commission_snapshot BEFORE INSERT OR UPDATE ON agenda_turnos
  FOR EACH ROW EXECUTE FUNCTION snapshot_groomer_commission();

CREATE TABLE IF NOT EXISTS employee_payments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  employee_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('anticipo','pago')),
  date date NOT NULL,
  amount numeric(12,2) NOT NULL CHECK(amount>0),
  method text NOT NULL CHECK(method IN ('efectivo','transferencia','otro')),
  notes text NOT NULL DEFAULT '' CHECK(length(notes)<=1000),
  recorded_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  void_reason text,
  CHECK ((voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL) OR
         (voided_at IS NOT NULL AND voided_by IS NOT NULL AND length(trim(void_reason))>0)),
  FOREIGN KEY(tenant_id,employee_id) REFERENCES employees(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS employee_payments_ledger ON employee_payments(tenant_id,employee_id,date);
CREATE INDEX IF NOT EXISTS agenda_personal_primary ON agenda_turnos(tenant_id,groomer_id,date);
CREATE INDEX IF NOT EXISTS agenda_personal_second ON agenda_turnos(tenant_id,second_groomer_id,date) WHERE second_groomer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agenda_personal_third ON agenda_turnos(tenant_id,third_groomer_id,date) WHERE third_groomer_id IS NOT NULL;
-- Conservar el origen de las comisiones aunque no tenga todavía una cuenta.
CREATE OR REPLACE FUNCTION preserve_employee_work_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM agenda_turnos WHERE tenant_id=OLD.tenant_id AND status='finished'
    AND OLD.id IN (groomer_id,second_groomer_id,third_groomer_id)) THEN
    RAISE EXCEPTION 'El empleado tiene trabajos finalizados: usá la baja en lugar de eliminarlo' USING ERRCODE='23503';
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS employee_work_history_guard ON employees;
CREATE TRIGGER employee_work_history_guard BEFORE DELETE ON employees
  FOR EACH ROW EXECUTE FUNCTION preserve_employee_work_history();
-- Solo el backend con su conexión de servidor accede a la liquidación.
ALTER TABLE employee_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON employee_payments FROM PUBLIC;
COMMIT;
