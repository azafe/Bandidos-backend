CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_password_reset_tokens_hash
  ON password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id
  ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires_at
  ON password_reset_tokens(expires_at);

CREATE TABLE IF NOT EXISTS auth_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  email text,
  ip text,
  user_agent text,
  success boolean NOT NULL DEFAULT true,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_audit_logs_event_time
  ON auth_audit_logs(event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  role text NOT NULL,
  phone text,
  email text,
  status text NOT NULL CHECK (status IN ('active', 'inactive')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text,
  email text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid,
  name text NOT NULL,
  breed text,
  owner_name text NOT NULL,
  owner_phone text,
  size text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS service_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  default_price numeric(12,2),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agenda_turnos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date date NOT NULL,
  time time NOT NULL,
  duration int NOT NULL DEFAULT 60,
  pet_id uuid REFERENCES pets(id) ON DELETE SET NULL,
  pet_name text NOT NULL,
  breed text,
  owner_name text NOT NULL,
  service_type_id uuid NOT NULL REFERENCES service_types(id) ON DELETE RESTRICT,
  payment_method_id uuid REFERENCES payment_methods(id) ON DELETE SET NULL,
  deposit_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (deposit_amount >= 0),
  notes text,
  groomer_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (
    status IN ('reserved', 'finished', 'cancelled')
  ),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date date NOT NULL,
  pet_id uuid NOT NULL REFERENCES pets(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  service_type_id uuid NOT NULL REFERENCES service_types(id) ON DELETE RESTRICT,
  price numeric(12,2) NOT NULL DEFAULT 0,
  payment_method_id uuid NOT NULL REFERENCES payment_methods(id) ON DELETE RESTRICT,
  groomer_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  category text,
  phone text,
  payment_method_id uuid REFERENCES payment_methods(id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS expense_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS daily_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date date NOT NULL,
  category_id uuid NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
  description text NOT NULL,
  amount numeric(12,2) NOT NULL DEFAULT 0,
  payment_method_id uuid NOT NULL REFERENCES payment_methods(id) ON DELETE RESTRICT,
  supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fixed_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  category_id uuid NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
  amount numeric(12,2) NOT NULL DEFAULT 0,
  due_day int NOT NULL CHECK (due_day BETWEEN 1 AND 31),
  payment_method_id uuid NOT NULL REFERENCES payment_methods(id) ON DELETE RESTRICT,
  supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_services_date ON services(date);
CREATE INDEX IF NOT EXISTS idx_agenda_turnos_date ON agenda_turnos(date);
CREATE INDEX IF NOT EXISTS idx_agenda_turnos_date_time ON agenda_turnos(date, time);
CREATE INDEX IF NOT EXISTS idx_services_pet_id ON services(pet_id);
CREATE INDEX IF NOT EXISTS idx_services_customer_id ON services(customer_id);
CREATE INDEX IF NOT EXISTS idx_services_service_type_id ON services(service_type_id);
CREATE INDEX IF NOT EXISTS idx_services_payment_method_id ON services(payment_method_id);
CREATE INDEX IF NOT EXISTS idx_services_groomer_id ON services(groomer_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_payment_method_id ON suppliers(payment_method_id);
CREATE INDEX IF NOT EXISTS idx_daily_expenses_date ON daily_expenses(date);
CREATE INDEX IF NOT EXISTS idx_daily_expenses_category_id ON daily_expenses(category_id);
CREATE INDEX IF NOT EXISTS idx_daily_expenses_payment_method_id ON daily_expenses(payment_method_id);
CREATE INDEX IF NOT EXISTS idx_daily_expenses_supplier_id ON daily_expenses(supplier_id);
CREATE INDEX IF NOT EXISTS idx_fixed_expenses_category_id ON fixed_expenses(category_id);
CREATE INDEX IF NOT EXISTS idx_fixed_expenses_payment_method_id ON fixed_expenses(payment_method_id);
CREATE INDEX IF NOT EXISTS idx_fixed_expenses_supplier_id ON fixed_expenses(supplier_id);
