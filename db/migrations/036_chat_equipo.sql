BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_identity ON users(tenant_id,id);
CREATE TABLE IF NOT EXISTS team_chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL CHECK(kind IN ('directa','grupo')),
  name text CHECK(length(name) BETWEEN 1 AND 60),
  direct_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,direct_key),
  CHECK((kind='directa' AND direct_key IS NOT NULL) OR (kind='grupo' AND direct_key IS NULL AND name IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS team_chat_members (
  tenant_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  user_id uuid NOT NULL,
  is_admin boolean NOT NULL DEFAULT false,
  joined_after bigint NOT NULL DEFAULT 0,
  read_seq bigint NOT NULL DEFAULT 0,
  muted boolean NOT NULL DEFAULT false,
  favorite boolean NOT NULL DEFAULT false,
  PRIMARY KEY(chat_id,user_id),
  FOREIGN KEY(tenant_id,chat_id) REFERENCES team_chats(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS team_chats_inbox ON team_chat_members(tenant_id,user_id,chat_id);
CREATE TABLE IF NOT EXISTS team_chat_messages (
  id uuid NOT NULL UNIQUE,
  seq bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  text text CHECK(length(text)<=4000),
  photo_data text CHECK(length(photo_data)<=1400000),
  photo_type text CHECK(photo_type IN ('image/jpeg','image/png','image/webp')),
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  FOREIGN KEY(tenant_id,chat_id) REFERENCES team_chats(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS team_messages_history ON team_chat_messages(tenant_id,chat_id,seq DESC);
CREATE INDEX IF NOT EXISTS team_messages_rate ON team_chat_messages(tenant_id,author_id,created_at DESC);
CREATE TABLE IF NOT EXISTS team_chat_reactions (
  message_id uuid NOT NULL REFERENCES team_chat_messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji text NOT NULL CHECK(emoji IN ('👍','❤️','😂','😮','😢','✅')),
  PRIMARY KEY(message_id,user_id)
);
-- Sin acceso directo desde roles de navegador. La conexión del backend,
-- propietaria de las tablas, valida tenant y membresía en cada operación.
ALTER TABLE team_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_chat_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_chat_reactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON team_chats,team_chat_members,team_chat_messages,team_chat_reactions FROM PUBLIC;
COMMIT;
