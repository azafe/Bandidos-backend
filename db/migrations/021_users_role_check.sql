-- 021: restringe users.role a los valores que el código realmente entiende.
--
-- Hasta ahora la columna era `text` libre: un bug en la app (ver PUT /v2/users/:id
-- sin filtro de tenant, corregido en este mismo cambio) permitía escribir
-- cualquier string ahí, incluyendo "super_admin" desde una cuenta admin común.
-- Este CHECK es la segunda barrera, a nivel de base, por si el código vuelve a
-- fallar.
--
-- Antes de aplicar en producción, correr:
--   SELECT DISTINCT role FROM users;
-- y confirmar que no hay valores fuera de la lista de abajo (de haberlos, hay
-- que decidir a qué rol real corresponden y actualizarlos antes de agregar el
-- constraint, o el ALTER TABLE va a fallar).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_role_check
      CHECK (role IN ('super_admin', 'admin', 'staff', 'user'));
  END IF;
END $$;
