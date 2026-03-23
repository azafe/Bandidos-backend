-- Migración 003: Crear tabla tenants (Fase 1 multi-tenant)
-- Ejecutar ANTES que 004_users_tenant_and_roles.sql

CREATE TABLE IF NOT EXISTS tenants (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text        NOT NULL,
  logo_url        text,
  primary_color   text,
  secondary_color text,
  plan            text        NOT NULL DEFAULT 'basic',
  status          text        NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'inactive')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Bandidos es el tenant #1. UUID fijo para facilitar la migración de datos.
INSERT INTO tenants (id, name, plan, status)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Bandidos',
  'basic',
  'active'
)
ON CONFLICT (id) DO NOTHING;
