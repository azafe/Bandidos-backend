CREATE TABLE IF NOT EXISTS agenda_day_notes (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  date        date        NOT NULL,
  note        text        NOT NULL DEFAULT '',
  updated_by  uuid        REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, date)
);
