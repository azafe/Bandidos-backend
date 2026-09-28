-- 023: web de reservas online (entrega 1: configuración y motor de horarios).
--
-- Cada local puede publicar una página pública (/reservar/<slug>) donde sus
-- clientes eligen servicio, tamaño del perro, día y horario libre. Para
-- calcular qué horarios ofrecer hace falta saber:
--   - si el local tiene las reservas prendidas y con qué reglas
--     (booking_settings),
--   - en qué franjas atiende cada día de la semana (booking_hours),
--   - qué días puntuales cierra: feriados, vacaciones (booking_closed_days),
--   - qué franjas bloqueó a mano desde la agenda (agenda_blocks),
--   - cuánto dura y cuánto cuesta cada servicio según el tamaño del perro
--     (columnas nuevas en service_types).
--
-- Todo es aditivo (ADD COLUMN / CREATE TABLE IF NOT EXISTS): no toca filas
-- existentes y se puede correr dos veces sin romper nada. La única excepción
-- es el CHECK de agenda_turnos.status, que se recrea para sumar 'no_show'
-- conservando los tres valores actuales.

-- ── Configuración por local ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS booking_settings (
  tenant_id            uuid        PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled              boolean     NOT NULL DEFAULT false,
  -- Parte final del link público. Minúsculas, números y guiones.
  slug                 text        UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  address              text,
  whatsapp             text,
  cancellation_policy  text,
  -- Cuántos perros se pueden atender al mismo tiempo.
  capacity             int         NOT NULL DEFAULT 1  CHECK (capacity BETWEEN 1 AND 20),
  -- Cada cuántos minutos se ofrece un horario de inicio.
  slot_interval        int         NOT NULL DEFAULT 30 CHECK (slot_interval IN (15, 30, 60)),
  -- Anticipación mínima para reservar (en minutos) y máxima (en días).
  min_notice_minutes   int         NOT NULL DEFAULT 120 CHECK (min_notice_minutes BETWEEN 0 AND 10080),
  max_days_ahead       int         NOT NULL DEFAULT 30  CHECK (max_days_ahead BETWEEN 1 AND 180),
  -- Hasta cuántas horas antes del turno el cliente puede cancelar solo.
  cancel_hours         int         NOT NULL DEFAULT 24  CHECK (cancel_hours BETWEEN 0 AND 168),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- ── Horario de atención semanal ────────────────────────────────────────────
-- Un día puede tener varias franjas (ej. 9-13 y 16-20). weekday: 0 = domingo.
CREATE TABLE IF NOT EXISTS booking_hours (
  id          uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid  NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  weekday     int   NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time  time  NOT NULL,
  end_time    time  NOT NULL,
  CHECK (start_time < end_time)
);

CREATE INDEX IF NOT EXISTS idx_booking_hours_tenant ON booking_hours (tenant_id, weekday);

-- ── Días cerrados puntuales (feriados, vacaciones) ─────────────────────────
CREATE TABLE IF NOT EXISTS booking_closed_days (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  date        date        NOT NULL,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, date)
);

-- ── Franjas bloqueadas desde la agenda ─────────────────────────────────────
-- Un bloqueo ocupa todos los cupos de esa franja: la web no ofrece horarios
-- que se superpongan con él.
CREATE TABLE IF NOT EXISTS agenda_blocks (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  date        date        NOT NULL,
  start_time  time        NOT NULL,
  end_time    time        NOT NULL,
  reason      text,
  created_by  uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (start_time < end_time)
);

CREATE INDEX IF NOT EXISTS idx_agenda_blocks_tenant_date ON agenda_blocks (tenant_id, date);

-- ── Servicios: duración, precio por tamaño y visibilidad en la web ─────────
-- size_pricing: {"chico": {"price": 12000, "duration": 60}, "grande": {...}}.
-- Los tamaños sin entrada usan default_price y duration_minutes.
ALTER TABLE service_types ADD COLUMN IF NOT EXISTS duration_minutes int
  CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 5 AND 600);
ALTER TABLE service_types ADD COLUMN IF NOT EXISTS online_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE service_types ADD COLUMN IF NOT EXISTS size_pricing jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE service_types ADD COLUMN IF NOT EXISTS description text;

-- ── Turnos: origen, código de cancelación y estado "No vino" ───────────────
ALTER TABLE agenda_turnos ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'internal'
  CHECK (source IN ('internal', 'online'));
ALTER TABLE agenda_turnos ADD COLUMN IF NOT EXISTS cancel_token text UNIQUE;

ALTER TABLE agenda_turnos DROP CONSTRAINT IF EXISTS agenda_turnos_status_check;
ALTER TABLE agenda_turnos ADD CONSTRAINT agenda_turnos_status_check
  CHECK (status IN ('reserved', 'finished', 'cancelled', 'no_show'));

-- El cálculo de disponibilidad lee los turnos de un local en un rango de fechas.
CREATE INDEX IF NOT EXISTS idx_agenda_turnos_tenant_date ON agenda_turnos (tenant_id, date);
