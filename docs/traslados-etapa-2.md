# Bandimóviles — Etapa 2: operación diaria

## Despliegue

1. Aplicar `db/migrations/026_traslados_operacion.sql`, después de 025 y las
   migraciones anteriores, incluida la tabla `push_subscriptions` de 013.
2. Desplegar backend y luego frontend. La revalidación de sesión consulta
   `users.chofer_id`, por lo que **026 debe estar aplicada antes del backend**.
3. En Equipo marcar a los integrantes como choferes. En Usuarios crear una
   cuenta individual de Staff y elegir su acceso exclusivo de chofer, o vincular
   una cuenta existente desde su detalle. Compartir las credenciales por el
   canal habitual del local; no se crean contraseñas ni cuentas de producción
   automáticamente.

026 agrega `traslados.orden_ruta`, `users.chofer_id` y
`push_subscriptions.user_id`. No cambia roles, importes, estados ni históricos.
La FK compuesta impide vincular empleados de otro local. Una cuenta por chofer,
sin afectar a empleados sin cuenta ni a cuentas generales existentes.

## Autorización

El acceso exclusivo depende del vínculo en la base, no de un filtro de pantalla
ni de los claims antiguos del JWT. En cada request se revalida usuario, local,
vínculo y actividad del chofer. Una cuenta vinculada solo puede consultar `/me`,
leer su hoja de ruta y avanzar sus propios tramos. Un chofer desactivado o sin
la capacidad `is_driver` conserva la restricción y queda bloqueado.

El chofer no accede a Agenda, Caja, empleados, mascotas, solicitudes económicas,
catálogos, asistente ni administración. La hoja de ruta expone solo los datos
operativos y contactos de sus asignaciones, sin precio, cobro ni tramo hermano.
Cambiar IDs, filtros o URL no amplía el alcance. El administrador ve el local
completo y ordena rutas. Staff general mantiene sus permisos operativos previos,
pero no puede ordenar rutas ni gestionar accesos.

El administrador puede quitar explícitamente un vínculo, lo que devuelve el
acceso general del rol; la interfaz pide confirmar ese efecto. El endpoint no
permite cambiar el propio acceso ni vincular una cuenta administrativa. Si
posteriormente se cambia el rol de una cuenta vinculada, el vínculo continúa
restringiéndola hasta que un administrador lo quite explícitamente.

Los avisos push generales de Agenda excluyen las cuentas vinculadas a choferes.
Las suscripciones anteriores sin usuario asociado no reciben esos avisos hasta
que el usuario abre el panel actualizado: entonces se vinculan nuevamente sin
pedir permiso de notificaciones otra vez. La vista del chofer desuscribe el
navegador si conserva una suscripción de una sesión general anterior.

## API

- `GET /v2/traslados/hoja-de-ruta?fecha=YYYY-MM-DD&chofer_id=UUID&vehiculo_id=UUID`.
  Filtros opcionales salvo fecha. El chofer queda siempre restringido a su ID;
  intentar indicar otro devuelve 403. Devuelve `{items,historicos_pendientes}`.
  Cada item incluye mascota, dueño, teléfono, dirección, tipo, estado,
  asignaciones, horario, orden y revisión opaca de concurrencia. El teléfono se
  obtiene del cliente de la mascota vinculada al turno, con fallback a su
  `owner_phone`, siempre dentro del local; no se busca por nombre.
- `PUT /v2/traslados/orden-ruta`: administrador. Body
  `{fecha,chofer_id,vehiculo_id,tramos:[{id,revision}]}` con la lista completa
  del grupo, en el nuevo orden. Bloquea filas y rechaza listas incompletas,
  duplicadas, de otro ámbito o desactualizadas. La revisión de PostgreSQL evita
  depender de timestamps truncados a milisegundos. Guarda posiciones desde 1.
- `PATCH /v2/traslados/:id/estado`: `{estado_anterior,estado}`. Solo avances
  `pendiente → en_camino → retirado → entregado`. Bloquea turno y solicitud,
  revalida propiedad y estado actual y reutiliza las reglas de Etapa 1. Un
  reintento al mismo estado es idempotente; un conflicto devuelve 409. Solo
  devuelve `{id,estado,updated_at}`, sin exponer solicitudes ni otros tramos.
- `POST /v2/users` ahora admite `chofer_id` opcional. Cuando viene informado,
  valida integrante activo del local y crea cuenta y vínculo atómicamente.
- `PUT /v2/users/:id/chofer`: administrador, `{chofer_id:UUID|null}`. La unicidad
  y referencias se validan en base además de la API. GET de usuarios y `/me`
  incluyen el vínculo; login también permite redirigir sin abrir Agenda.

## Hoja de ruta

Se agrupa por chofer y móvil del día. Sin orden manual, usa horario (los
pendientes al final) y un desempate estable. Reasignar chofer, móvil o fecha
limpia el orden de ese tramo para no trasladar la posición a otra ruta. El
administrador puede guardar un orden nuevo; el chofer solo lo consulta.

Los tramos cancelados y los turnos cancelados/ausentes no aparecen. Los
históricos sin solicitud solo generan un aviso para el equipo general; no se
importan ni se inventan asignaciones. Una entrega de búsqueda significa llegada
al local; la entrega de vuelta significa llegada al dueño. Son estados de cada
tramo, independientes del grooming y de su cobro.

WhatsApp abre un mensaje preparado para revisión y envío manual. Maps abre la
dirección del tramo. Los datos faltantes se muestran como pendientes; no se
habilitan enlaces de WhatsApp con números inválidos ni salida sin asignación.

## Verificación

`node --test tests/traslados-operacion.test.js tests/traslados-registros.test.js tests/traslados-api.test.js`
ejecuta las rutas contra PostgreSQL embebido, incluyendo autenticación real
consultada en la base, aislamiento entre choferes del mismo local y locales
distintos, tokens vigentes, estados, concurrencia, FK y destinatarios push.
El helper aplica 026 dos veces para verificar repetibilidad.

Completar con lint, npm test, npm run test:integration y navegador con frontend.
Las cinco fallas previas de npm test son las pruebas antiguas de empleados sin
autenticación y su contenedor. Integración conserva además las dos suites de
fotos que necesitan el flag de mocks de módulos.

No se ejecutó esta migración en producción. No incluye rentabilidad, simulador,
GPS, optimización automática, acceso público ni importación de históricos.
