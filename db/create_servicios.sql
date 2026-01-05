CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS servicios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date date NOT NULL,
  dog_name text NOT NULL,
  owner_name text NOT NULL,
  type text NOT NULL,
  price numeric(10,2) NOT NULL DEFAULT 0,
  payment_method text NOT NULL,
  groomer text,
  notes text,
  created_at timestamptz DEFAULT now()
);
