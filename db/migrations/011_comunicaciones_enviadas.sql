-- Migration 011: Comunicaciones enviadas
-- Registra qué mascotas recibieron un mensaje de WhatsApp (recordatorio de turno o cumpleaños)
-- para que el estado persista entre sesiones y dispositivos.

CREATE TABLE IF NOT EXISTS comunicaciones_enviadas (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pet_id      UUID        NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  type        TEXT        NOT NULL CHECK (type IN ('turno', 'cumple')),
  pet_name    TEXT        NOT NULL,
  owner_name  TEXT,
  sent_at     DATE        NOT NULL DEFAULT CURRENT_DATE,
  sent_by     UUID        REFERENCES users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, pet_id, type)
);

CREATE INDEX IF NOT EXISTS idx_comunicaciones_tenant_type
  ON comunicaciones_enviadas(tenant_id, type, sent_at);
