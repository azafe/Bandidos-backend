-- Precio y cobro pertenecen a la solicitud completa, nunca a cada tramo.
-- Esta migración solo agrega estructura: no importa ni clasifica históricos.
BEGIN;

ALTER TABLE employees ADD COLUMN IF NOT EXISTS is_driver boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS employees_tenant_id_id ON employees(tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS agenda_turnos_tenant_id_id ON agenda_turnos(tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS payment_methods_tenant_id_id ON payment_methods(tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_id_id ON users(tenant_id, id);

CREATE TABLE IF NOT EXISTS vehiculos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  nombre text NOT NULL CHECK (length(trim(nombre)) > 0),
  patente text NOT NULL CHECK (length(trim(patente)) > 0),
  propietario text,
  activo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, id), UNIQUE(tenant_id, patente)
);
CREATE TABLE IF NOT EXISTS traslado_zonas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  nombre text NOT NULL CHECK (length(trim(nombre)) > 0),
  tarifa numeric(12,2) CHECK (tarifa >= 0),
  activo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, id), UNIQUE(tenant_id, nombre)
);
CREATE TABLE IF NOT EXISTS traslado_configuracion (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK(version > 0),
  modelo_pago text CHECK (modelo_pago IN ('ninguno', 'porcentaje', 'jornal')),
  valor_pago numeric(12,2) CHECK (valor_pago >= 0),
  costo_referencia numeric(12,2) CHECK (costo_referencia >= 0),
  unidad_referencia text CHECK (unidad_referencia IN ('dia', 'traslado')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((modelo_pago IS NULL AND valor_pago IS NULL)
      OR (modelo_pago IS NOT NULL AND valor_pago IS NOT NULL AND (
         (modelo_pago = 'ninguno' AND valor_pago = 0)
      OR (modelo_pago = 'porcentaje' AND valor_pago BETWEEN 0 AND 100)
      OR (modelo_pago = 'jornal' AND valor_pago > 0)))),
  CHECK ((costo_referencia IS NULL) = (unidad_referencia IS NULL)),
  UNIQUE(tenant_id, id), UNIQUE(tenant_id, version)
);
CREATE TABLE IF NOT EXISTS traslado_solicitudes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  turno_id uuid NOT NULL,
  origen text NOT NULL DEFAULT 'agenda' CHECK (origen IN ('agenda','historico')),
  precio_total numeric(12,2) CHECK (precio_total >= 0),
  bonificado boolean NOT NULL DEFAULT false,
  cancelado boolean NOT NULL DEFAULT false,
  configuracion_id uuid,
  notas text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Para bonificados sí se guarda cero; pendientes conservan NULL.
  CHECK ((bonificado AND precio_total IS NOT NULL AND precio_total = 0)
      OR (NOT bonificado AND (precio_total IS NULL OR precio_total > 0))),
  UNIQUE(tenant_id, id), UNIQUE(tenant_id, turno_id),
  FOREIGN KEY(tenant_id, turno_id) REFERENCES agenda_turnos(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id, configuracion_id) REFERENCES traslado_configuracion(tenant_id, id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS traslados (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  solicitud_id uuid NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('busqueda','entrega','ida_y_vuelta')),
  chofer_id uuid, vehiculo_id uuid, zona_id uuid,
  direccion text,
  fecha_programada date NOT NULL,
  hora_programada time,
  -- El estado desconocido de un futuro legado no debe inventarse como pendiente.
  estado text DEFAULT 'pendiente'
    CHECK ((tipo = 'ida_y_vuelta' AND estado IS NULL) OR
      (estado IS NOT NULL AND estado IN ('pendiente','en_camino','retirado','entregado','cancelado'))),
  notas text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, id), UNIQUE(tenant_id, solicitud_id, tipo),
  FOREIGN KEY(tenant_id, solicitud_id) REFERENCES traslado_solicitudes(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id, chofer_id) REFERENCES employees(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id, vehiculo_id) REFERENCES vehiculos(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id, zona_id) REFERENCES traslado_zonas(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS traslados_tenant_fecha ON traslados(tenant_id, fecha_programada);
CREATE INDEX IF NOT EXISTS traslados_tenant_chofer ON traslados(tenant_id, chofer_id, fecha_programada);
CREATE INDEX IF NOT EXISTS traslados_tenant_vehiculo ON traslados(tenant_id, vehiculo_id, fecha_programada);
CREATE TABLE IF NOT EXISTS traslado_cobros (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  solicitud_id uuid NOT NULL,
  monto numeric(12,2) NOT NULL CHECK(monto > 0),
  fecha date NOT NULL,
  cobrado_por text NOT NULL CHECK(cobrado_por IN ('chofer','local')),
  chofer_id uuid,
  payment_method_id uuid NOT NULL,
  registrado_por uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((cobrado_por = 'chofer' AND chofer_id IS NOT NULL) OR (cobrado_por = 'local' AND chofer_id IS NULL)),
  UNIQUE(tenant_id, solicitud_id),
  FOREIGN KEY(tenant_id, solicitud_id) REFERENCES traslado_solicitudes(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id, chofer_id) REFERENCES employees(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id, payment_method_id) REFERENCES payment_methods(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id, registrado_por) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS traslado_cobros_tenant_fecha ON traslado_cobros(tenant_id, fecha);
COMMIT;
