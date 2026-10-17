-- Cuenta propia de Bandimóviles. No clasifica gastos ni modifica viajes previos.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS expense_categories_tenant_id_id ON expense_categories(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS daily_expenses_tenant_id_id ON daily_expenses(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS fixed_expense_charges_tenant_id_id ON fixed_expense_charges(tenant_id,id);

CREATE TABLE IF NOT EXISTS traslado_resultado_ajustes (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS traslado_resultado_categorias (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  category_id uuid NOT NULL,
  PRIMARY KEY(tenant_id,category_id),
  FOREIGN KEY(tenant_id,category_id) REFERENCES expense_categories(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS traslado_gasto_asignaciones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  daily_expense_id uuid,
  fixed_charge_id uuid,
  vehiculo_id uuid NOT NULL,
  CHECK (num_nonnulls(daily_expense_id,fixed_charge_id)=1),
  UNIQUE(tenant_id,daily_expense_id), UNIQUE(tenant_id,fixed_charge_id),
  FOREIGN KEY(tenant_id,daily_expense_id) REFERENCES daily_expenses(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,fixed_charge_id) REFERENCES fixed_expense_charges(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,vehiculo_id) REFERENCES vehiculos(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS traslado_costos_externos (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  fecha date NOT NULL,
  concepto text NOT NULL CHECK (length(trim(concepto)) BETWEEN 1 AND 200),
  monto numeric(12,2) NOT NULL CHECK (monto>0),
  pagado_por text NOT NULL CHECK (length(trim(pagado_por)) BETWEEN 1 AND 100),
  vehiculo_id uuid,
  anulado boolean NOT NULL DEFAULT false,
  registrado_por uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,vehiculo_id) REFERENCES vehiculos(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,registrado_por) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS traslado_costos_externos_fecha ON traslado_costos_externos(tenant_id,fecha);
CREATE TABLE IF NOT EXISTS traslado_jornadas (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  fecha date NOT NULL,
  chofer_id uuid NOT NULL,
  vehiculo_id uuid,
  monto numeric(12,2) NOT NULL CHECK (monto>0),
  anulado boolean NOT NULL DEFAULT false,
  registrado_por uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,fecha,chofer_id),
  FOREIGN KEY(tenant_id,chofer_id) REFERENCES employees(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,vehiculo_id) REFERENCES vehiculos(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,registrado_por) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS traslado_repartos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  solicitud_id uuid NOT NULL,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,solicitud_id),
  FOREIGN KEY(tenant_id,solicitud_id) REFERENCES traslado_solicitudes(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS traslado_reparto_items (
  tenant_id uuid NOT NULL,
  reparto_id uuid NOT NULL,
  vehiculo_id uuid NOT NULL,
  porcentaje numeric(5,2) NOT NULL CHECK(porcentaje>0 AND porcentaje<=100),
  PRIMARY KEY(tenant_id,reparto_id,vehiculo_id),
  FOREIGN KEY(tenant_id,reparto_id) REFERENCES traslado_repartos(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,vehiculo_id) REFERENCES vehiculos(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS traslado_revision_costos (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  periodo date NOT NULL CHECK (EXTRACT(DAY FROM periodo)=1),
  revision text NOT NULL,
  registrado_por uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,periodo),
  FOREIGN KEY(tenant_id,registrado_por) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);
-- Completar condiciones desconocidas requiere una revisión explícita. La
-- configuración original del viaje no se sobrescribe ni se aplica en lote.
CREATE TABLE IF NOT EXISTS traslado_condiciones_revisadas (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  solicitud_id uuid NOT NULL,
  configuracion_id uuid NOT NULL,
  registrado_por uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,solicitud_id),
  FOREIGN KEY(tenant_id,solicitud_id) REFERENCES traslado_solicitudes(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,configuracion_id) REFERENCES traslado_configuracion(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,registrado_por) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);
COMMIT;
