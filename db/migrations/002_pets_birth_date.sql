-- Add birth_date column to pets table
ALTER TABLE pets ADD COLUMN IF NOT EXISTS birth_date date;
