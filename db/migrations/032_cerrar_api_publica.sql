-- Cierra la base a la API pública de Supabase (PostgREST / GraphQL).
--
-- Bandidos no usa esa API: el frontend habla solo con este backend, y el
-- backend se conecta directo a Postgres como `postgres`, dueño de las tablas,
-- que no pasa por RLS. Pero todas las tablas de `public` tenían RLS apagado y
-- los roles `anon` y `authenticated` podían leer, insertar, modificar y borrar
-- en todas (incluidas `users` y `password_reset_tokens`), con solo conocer la
-- URL del proyecto y la clave pública.
--
-- Esta migración:
--  * prende RLS en todas las tablas de `public`, sin políticas: los roles de la
--    API no ven ninguna fila; el dueño (el backend) sigue igual;
--  * les quita a `anon` y `authenticated` todos los permisos sobre tablas,
--    secuencias y funciones de `public`;
--  * cambia los permisos por defecto para que las tablas que se creen después
--    tampoco queden abiertas;
--  * fija el search_path de set_updated_at (aviso de seguridad de Supabase).
-- No toca el storage de fotos ni al rol service_role. Repetible.

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM authenticated;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM authenticated;
  END IF;

  IF to_regprocedure('public.set_updated_at()') IS NOT NULL THEN
    ALTER FUNCTION public.set_updated_at() SET search_path = pg_catalog, public;
  END IF;
END $$;
