-- Solo estructura: importar requiere revisar cantidad y SQL desde el panel.
-- Se conserva una copia exacta del legado; un cero no demuestra bonificación.
BEGIN;
CREATE TABLE IF NOT EXISTS traslado_historicos (
  tenant_id uuid NOT NULL,
  solicitud_id uuid NOT NULL,
  turno_id uuid NOT NULL,
  fecha date NOT NULL,
  turno_status text NOT NULL,
  pet_name text,
  owner_name text,
  monto numeric,
  bonificado boolean,
  direccion text,
  revision_importacion text NOT NULL,
  importado_por uuid NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id, solicitud_id),
  UNIQUE(tenant_id, turno_id),
  FOREIGN KEY(tenant_id, solicitud_id) REFERENCES traslado_solicitudes(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id, turno_id) REFERENCES agenda_turnos(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id, importado_por) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS traslado_historicos_fecha ON traslado_historicos(tenant_id, fecha);
CREATE INDEX IF NOT EXISTS traslado_historicos_revision ON traslado_historicos(tenant_id, revision_importacion);
COMMIT;
