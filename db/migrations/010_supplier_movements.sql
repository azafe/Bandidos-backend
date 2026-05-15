-- Migration 010: Cuenta corriente de proveedores
-- Crea la tabla supplier_movements para registrar cargos y pagos por proveedor.
-- El saldo siempre se calcula desde los movimientos; nunca se almacena.

CREATE TABLE IF NOT EXISTS supplier_movements (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID        NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  tenant_id   UUID        NOT NULL REFERENCES tenants(id),
  date        DATE        NOT NULL,
  tipo        TEXT        NOT NULL CHECK (tipo IN ('cargo', 'pago')),
  monto       NUMERIC     NOT NULL CHECK (monto > 0),
  descripcion TEXT        NOT NULL,
  referencia  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_supplier_movements_supplier_id
  ON supplier_movements(supplier_id);

CREATE INDEX IF NOT EXISTS idx_supplier_movements_tenant_id
  ON supplier_movements(tenant_id);
