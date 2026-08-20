-- 020: archivado de mascotas + vendedor en ventas de PetShop.

-- ── Mascotas archivadas ──────────────────────────────────────────────────────
-- Una mascota con servicios cargados no se puede borrar: services.pet_id es
-- ON DELETE RESTRICT y borrarla rompería la facturación histórica. Archivar la
-- saca de las listas sin tocar el historial.
ALTER TABLE pets ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_pets_archived_at ON pets(archived_at);

-- ── Vendedor de PetShop ──────────────────────────────────────────────────────
-- La columna ya existía en producción (se agregó a mano), pero no estaba en
-- ninguna migración: sin esto un entorno nuevo levanta sin ella y todo POST de
-- venta falla.
ALTER TABLE petshop_sales
  ADD COLUMN IF NOT EXISTS stylist_id uuid REFERENCES employees(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_petshop_sales_stylist_id ON petshop_sales(stylist_id);
