BEGIN;

ALTER TABLE public.agenda_turnos ADD COLUMN IF NOT EXISTS third_groomer_id uuid;
ALTER TABLE public.services ADD COLUMN IF NOT EXISTS third_groomer_id uuid;

DO $$
DECLARE
  target_table text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY['agenda_turnos', 'services'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = format('public.%I', target_table)::regclass
        AND conname = target_table || '_third_groomer_distinct'
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (
          third_groomer_id IS NULL OR (
            groomer_id IS NOT NULL AND second_groomer_id IS NOT NULL
            AND third_groomer_id <> groomer_id
            AND third_groomer_id <> second_groomer_id
          ))', target_table, target_table || '_third_groomer_distinct');
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = format('public.%I', target_table)::regclass
        AND conname = target_table || '_third_groomer_tenant_fk'
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I
         FOREIGN KEY (tenant_id, third_groomer_id)
         REFERENCES public.employees (tenant_id, id) ON DELETE RESTRICT',
         target_table, target_table || '_third_groomer_tenant_fk');
    END IF;
  END LOOP;
END;
$$;

COMMIT;
