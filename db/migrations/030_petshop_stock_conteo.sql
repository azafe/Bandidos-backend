-- Stock del PetShop con conteo: cada cambio de stock deja un movimiento con
-- su tipo, la diferencia aplicada, el saldo resultante y quién lo hizo.
-- Adaptado del módulo de stock de la ONG. Aditiva y repetible: no modifica
-- importes, ventas ni el stock actual de ningún producto.

ALTER TABLE petshop_products ADD COLUMN IF NOT EXISTS last_counted_at timestamptz;

ALTER TABLE petshop_stock_movements ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE petshop_stock_movements ADD COLUMN IF NOT EXISTS delta int;
ALTER TABLE petshop_stock_movements ADD COLUMN IF NOT EXISTS stock_after int;
ALTER TABLE petshop_stock_movements ADD COLUMN IF NOT EXISTS unit_cost numeric(12,2);
ALTER TABLE petshop_stock_movements ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE petshop_stock_movements ADD COLUMN IF NOT EXISTS sale_id uuid;
ALTER TABLE petshop_stock_movements ADD COLUMN IF NOT EXISTS client_id uuid;

-- Los movimientos anteriores conservan su tipo original; no se inventa la
-- diferencia ni el saldo que no se guardaron.
UPDATE petshop_stock_movements
SET kind = CASE type WHEN 'in' THEN 'ingreso' WHEN 'out' THEN 'merma' ELSE 'ajuste' END
WHERE kind IS NULL;

ALTER TABLE petshop_stock_movements ALTER COLUMN kind SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'petshop_stock_movements_kind_check') THEN
    ALTER TABLE petshop_stock_movements ADD CONSTRAINT petshop_stock_movements_kind_check
      CHECK (kind IN ('ingreso', 'venta', 'devolucion', 'ajuste', 'merma', 'conteo', 'inicial'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'petshop_stock_movements_unit_cost_check') THEN
    ALTER TABLE petshop_stock_movements ADD CONSTRAINT petshop_stock_movements_unit_cost_check
      CHECK (unit_cost IS NULL OR unit_cost >= 0);
  END IF;
END $$;

-- Reintentar el mismo movimiento (corte de wifi en medio del conteo) no lo duplica.
CREATE UNIQUE INDEX IF NOT EXISTS uq_petshop_stock_movements_client
  ON petshop_stock_movements(tenant_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_petshop_stock_movements_tenant_created
  ON petshop_stock_movements(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_petshop_stock_movements_tenant_product
  ON petshop_stock_movements(tenant_id, product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_petshop_stock_movements_sale
  ON petshop_stock_movements(sale_id) WHERE sale_id IS NOT NULL;
