-- Rendiciones por persona. No importa saldos ni asigna nombres anteriores.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS traslado_cobros_tenant_id_id ON traslado_cobros(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS traslado_costos_externos_tenant_id_id ON traslado_costos_externos(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS traslado_jornadas_tenant_id_id ON traslado_jornadas(tenant_id,id);

CREATE TABLE IF NOT EXISTS traslado_reintegros (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  costo_id uuid NOT NULL,
  persona_id uuid NOT NULL,
  reintegrable boolean NOT NULL,
  fuente_revision text NOT NULL,
  registrado_por uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,costo_id),
  FOREIGN KEY(tenant_id,costo_id) REFERENCES traslado_costos_externos(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,persona_id) REFERENCES employees(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,registrado_por) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS traslado_remuneracion_repartos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  cobro_id uuid NOT NULL,
  fuente_revision text NOT NULL,
  registrado_por uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,cobro_id),
  FOREIGN KEY(tenant_id,cobro_id) REFERENCES traslado_cobros(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,registrado_por) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS traslado_remuneracion_items (
  tenant_id uuid NOT NULL,
  reparto_id uuid NOT NULL,
  persona_id uuid NOT NULL,
  porcentaje numeric(5,2) NOT NULL CHECK(porcentaje>0 AND porcentaje<=100),
  PRIMARY KEY(tenant_id,reparto_id,persona_id),
  FOREIGN KEY(tenant_id,reparto_id) REFERENCES traslado_remuneracion_repartos(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,persona_id) REFERENCES employees(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS traslado_rendiciones (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  persona_id uuid NOT NULL,
  persona_nombre text NOT NULL,
  desde date NOT NULL,
  hasta date NOT NULL CHECK(hasta>=desde),
  revision_origen text NOT NULL,
  cobrado numeric(16,2) NOT NULL CHECK(cobrado>=0),
  remuneracion numeric(16,2) NOT NULL CHECK(remuneracion>=0),
  reintegros numeric(16,2) NOT NULL CHECK(reintegros>=0),
  saldo_inicial numeric(16,2) NOT NULL,
  registrado_por uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  anulada boolean NOT NULL DEFAULT false,
  anulada_por uuid,
  anulada_at timestamptz,
  motivo_anulacion text,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,id,persona_id),
  CHECK(saldo_inicial=cobrado-remuneracion-reintegros),
  CHECK((NOT anulada AND anulada_por IS NULL AND anulada_at IS NULL AND motivo_anulacion IS NULL)
    OR (anulada AND anulada_por IS NOT NULL AND anulada_at IS NOT NULL AND motivo_anulacion IS NOT NULL AND length(trim(motivo_anulacion))>0)),
  FOREIGN KEY(tenant_id,persona_id) REFERENCES employees(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,registrado_por) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,anulada_por) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS traslado_rendicion_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  rendicion_id uuid NOT NULL,
  persona_id uuid NOT NULL,
  tipo text NOT NULL CHECK(tipo IN ('cobro','remuneracion','gasto','jornal')),
  cobro_id uuid,
  costo_id uuid,
  jornada_id uuid,
  fuente_id uuid GENERATED ALWAYS AS (COALESCE(cobro_id,costo_id,jornada_id)) STORED,
  fecha date NOT NULL,
  concepto text NOT NULL,
  monto numeric(14,2) NOT NULL CHECK(monto>=0),
  detalle jsonb NOT NULL,
  vigente boolean NOT NULL DEFAULT true,
  CHECK((tipo IN ('cobro','remuneracion') AND cobro_id IS NOT NULL AND costo_id IS NULL AND jornada_id IS NULL)
    OR (tipo='gasto' AND costo_id IS NOT NULL AND cobro_id IS NULL AND jornada_id IS NULL)
    OR (tipo='jornal' AND jornada_id IS NOT NULL AND costo_id IS NULL AND cobro_id IS NULL)),
  FOREIGN KEY(tenant_id,rendicion_id,persona_id) REFERENCES traslado_rendiciones(tenant_id,id,persona_id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,persona_id) REFERENCES employees(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,cobro_id) REFERENCES traslado_cobros(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,costo_id) REFERENCES traslado_costos_externos(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,jornada_id) REFERENCES traslado_jornadas(tenant_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS traslado_rendicion_items_vigentes
  ON traslado_rendicion_items(tenant_id,tipo,fuente_id,persona_id) WHERE vigente;
CREATE TABLE IF NOT EXISTS traslado_rendicion_movimientos (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  rendicion_id uuid NOT NULL,
  tipo text NOT NULL CHECK(tipo IN ('entrega_local','pago_persona')),
  monto numeric(14,2) NOT NULL CHECK(monto>0),
  fecha date NOT NULL,
  payment_method_id uuid NOT NULL,
  referencia text NOT NULL DEFAULT '',
  reversion_de uuid,
  motivo text,
  registrado_por uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,rendicion_id,id), UNIQUE(tenant_id,reversion_de),
  CHECK((reversion_de IS NULL AND motivo IS NULL) OR (reversion_de IS NOT NULL AND motivo IS NOT NULL AND length(trim(motivo))>0)),
  FOREIGN KEY(tenant_id,rendicion_id) REFERENCES traslado_rendiciones(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,rendicion_id,reversion_de) REFERENCES traslado_rendicion_movimientos(tenant_id,rendicion_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,payment_method_id) REFERENCES payment_methods(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,registrado_por) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS traslado_rendiciones_persona ON traslado_rendiciones(tenant_id,persona_id,created_at);
CREATE INDEX IF NOT EXISTS traslado_rendicion_movimientos_fecha ON traslado_rendicion_movimientos(tenant_id,fecha);
COMMIT;
