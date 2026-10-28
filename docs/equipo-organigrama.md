# Equipo: organigrama y personal

Adaptado del módulo Equipo de la ONG. Aplicar **031_equipo_organigrama.sql
antes de desplegar el backend**: el alta y la edición de empleados escriben
las columnas nuevas. Es aditiva y repetible y no modifica empleados.

- **Puesto** (`team_positions`): la caja del organigrama, con descripción, área
  (solo da el color) y de quién depende. Sin ciclos: el backend los rechaza.
  No se borra un puesto con otros debajo (409); sus asignaciones sí se van.
- **Persona**: la fila de `employees`, la misma de agenda, comisiones y
  Bandimóviles. Suma `dni`, `hire_date` y `end_date`. Pasar a inactivo sin
  fecha toma la de hoy y reactivar la limpia, solo cuando el estado cambia.
- **Asignación** (`team_assignments`): una persona puede ocupar varios puestos
  y un puesto tener varias personas. Solo personas activas del mismo local;
  borrar un empleado lo saca del organigrama.
- **Permiso**: sigue en `users.role`; el organigrama no da accesos.

## API (solo admin del local)

- GET `/v2/team`: puestos, empleados y asignaciones; el árbol se arma en el panel.
- POST `/v2/team/positions` `{name, description?, area?, parent_id?}`.
- PATCH `/v2/team/positions/:id` `{name?, description?, area?, parent_id?, sort_order?}`.
- DELETE `/v2/team/positions/:id`.
- PUT `/v2/team/positions/:id/employees` `{employee_ids}`: reemplaza la lista.
- POST `/v2/team/template`: organigrama sugerido (Dirección → Administración y
  Recepción → Peluquería, Bandimóviles, PetShop) con cada integrante activo
  ubicado según su rol. Solo si no hay puestos (409 si ya hay).

## Validación

`tests/team.test.js` contra PostgreSQL embebido: migración repetida, permisos,
sugerido por rol, orden, ciclos, asignaciones, borrado, aislamiento por local y
fecha de baja. El helper de traslados aplica también la 031. Las fallas previas
de `employees-api.test.js` (piden sin token y reciben 401) siguen igual que en main.
