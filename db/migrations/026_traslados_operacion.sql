-- Solo estructura: las cuentas existentes conservan su acceso y los
-- traslados no reciben un orden inventado. Aplicar antes del backend.
BEGIN;

ALTER TABLE traslados ADD COLUMN IF NOT EXISTS orden_ruta integer
  CHECK (orden_ruta > 0);

ALTER TABLE users ADD COLUMN IF NOT EXISTS chofer_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'users_chofer_del_local' AND conrelid = 'users'::regclass) THEN
    ALTER TABLE users ADD CONSTRAINT users_chofer_del_local
      FOREIGN KEY (tenant_id, chofer_id) REFERENCES employees(tenant_id, id)
      ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'users_chofer_requiere_local' AND conrelid = 'users'::regclass) THEN
    ALTER TABLE users ADD CONSTRAINT users_chofer_requiere_local
      CHECK (chofer_id IS NULL OR tenant_id IS NOT NULL);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS users_chofer_unico_por_local
  ON users(tenant_id, chofer_id) WHERE chofer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS traslados_ruta_del_dia
  ON traslados(tenant_id, fecha_programada, chofer_id, vehiculo_id, orden_ruta);

-- Una suscripción antigua sin responsable debe renovarse al abrir el panel;
-- no se envían datos generales a una cuenta que ahora es solo de chofer.
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS user_id uuid
  REFERENCES users(id) ON DELETE SET NULL;

COMMIT;
