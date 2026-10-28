# Roles y permisos por módulo

Adaptado del módulo Permisos de la ONG. Aplicar **033_roles_permisos.sql**
(antes o después del backend: sin la tabla, cada rol usa sus permisos por
defecto). Aditiva y repetible.

- **Roles**: admin (entra a todo siempre y es el único que edita usuarios y
  permisos), y los configurables Staff, Recepción, Peluquero/a y
  Administración. `user` (rol viejo) funciona como Staff. super_admin no se
  asigna desde un local.
- **Módulos** (`src/permissions.js`): Inicio y Nueva sucursal, Servicios,
  Agenda, Reservas online, Bandimóviles, Mascotas y clientes, Comunicaciones,
  PetShop, Rendición de caja, Gastos diarios, Gastos fijos, Proveedores, Tipos
  de servicio, Métodos de pago y categorías, Equipo.
- **Por defecto**: Staff = lo que veía antes (agenda, Bandimóviles,
  comunicaciones, mascotas, PetShop, caja, gastos diarios, tipos de servicio).
  Recepción, Peluquero/a y Administración tienen su propio punto de partida.
- **Por local**: `tenant_role_permissions` guarda una fila por local y rol;
  sin fila se usan los valores por defecto.

## Cómo se hace cumplir

`enforceModules` corre después de revalidar el usuario y del límite de
choferes, y antes de registrar las rutas. Cruza cada pedido con
`MODULE_RULES` (método + ruta → módulos). Sin regla, el pedido queda abierto:
son las listas de referencia que usan varias pantallas (empleados, mascotas,
clientes, métodos de pago, tipos de servicio, agenda) y la sesión. Las rutas
que eran solo del admin y ahora se delegan (empleados, reservas online,
métodos de pago, categorías, edición de servicios, proveedores, equipo) usan
`delegatedToModules`: el rol lo decide el módulo. Usuarios y permisos siguen
siendo solo del admin, igual que las finanzas de Bandimóviles. Las cuentas de
chofer siguen limitadas a su hoja de ruta.

Cambio de comportamiento a propósito: antes el staff podía llamar a gastos
fijos o reportes aunque el menú no se los mostrara; ahora el backend lo frena.

## API

- GET `/me/permissions` (cualquiera con sesión): `{role, role_label, is_admin, driver, modules}`.
- GET `/v2/permissions` (admin): módulos, roles, valores por defecto y permisos del local.
- PUT `/v2/permissions/:role` (admin) `{modules}`: reemplaza los módulos del rol.

## Validación

`tests/permissions.test.js`: toda ruta que era solo del admin tiene módulo;
defaults, configuración por local, 403 con mensaje, rutas delegadas,
usuarios y permisos no delegables, chofer y alta de usuarios con roles nuevos.
