# Cuentas personales, liquidaciones y chat del equipo

Cada usuario se vincula por `employee_id` a una persona de `employees` del mismo
local. La cuenta personal consulta su trabajo, sus entregas y su chat. Si la
persona tiene `is_driver`, también opera sus propios traslados. Las cuentas
anteriores de chofer (`chofer_id`) mantienen el recorrido y suman cuenta y chat.
Los permisos se revalidan con la base en cada petición, incluidos los tokens
emitidos antes de un cambio de vínculo o una baja. `/me` informa el estado actual.

## Reutilización

Fuentes revisadas en GitHub el 30/10/2026 y copiadas para consulta en
`/workspace/review/reutilizacion`:

| Origen | Módulo | Aplicación en Bandidos |
| --- | --- | --- |
| [AppTzReactChofer](https://github.com/azafe/AppTzReactChofer) | `src/pages/MiPagoPage.tsx`, `AnticiposPage.tsx` | Consulta por mes, resumen de ingresos y anticipos, cantidad e historial de entregas; presentación adaptada en `EmployeeStatementPage.jsx` |
| AppTzReactChofer | `src/context/AuthContext.tsx` | Revalidación al recuperar foco y cada minuto, conservando la autenticación JWT existente de Bandidos |
| [ONG](https://github.com/azafe/ONG) | `apps/backend/src/chat.js` | Validación de texto/nombre y políticas de edición/borrado reutilizadas en `src/chatRules.js`; rutas y consultas adaptadas en `src/chat.js` |
| ONG | `apps/panel-admin/src/staff/chat/formato.ts` | Módulo reutilizado como `src/lib/chatFormat.js`, con tipos TypeScript removidos |
| ONG | `staff/api/chat.ts`, `staff/hooks/useChat.ts` | Contratos y patrón de privados/grupos, paginación, no leídos y recuperación al volver a la app; adaptados a la API de Bandidos |
| Bandidos | `users`, `employees`, Agenda, acceso de chofer | Base existente de identidad, trabajos y aislamiento por local |

El chat usa PostgreSQL y JWT de Bandidos. Se adapta el transporte: consulta
cada 5 segundos en la conversación abierta y cada 15 segundos en el inbox,
con pausa cuando la pestaña está oculta. Esto permite utilizar las sesiones
actuales sin incorporar autenticación ni canales Realtime de Supabase.

## Liquidación

- Fuente de trabajos: `agenda_turnos` con `status='finished'`. `services` puede
  contener copias de los mismos trabajos y no se suma a la liquidación.
- Al finalizar se congela `commission_rate_snapshot` de la peluquera principal.
  Cambiar su porcentaje actual no modifica los trabajos ya finalizados.
- El pool se reparte entre principal, segunda y tercera, sin repetir personas,
  todas del mismo local. Se calcula en centavos; el remanente va primero a la
  principal y luego a la segunda. Los importes individuales suman el pool.
- Corregir precio, fecha, participantes o estado del trabajo corrige la cuenta;
  volver a finalizar un trabajo o cambiar la principal toma su tasa vigente.
- El backfill usa el porcentaje vigente al migrar y se identifica como estimado:
  no hay información histórica para reconstruir una tasa que nunca se guardó.
- Cada empleado tiene `payroll_start_date` (por defecto el día de la migración)
  y `opening_balance` (por defecto cero). Administración debe definirlos antes
  de registrar la primera entrega. Así se incorporan los pendientes anteriores
  sin asumir que todos los trabajos históricos siguen sin pagar.
- Saldo final = saldo inicial + comisiones desde el inicio hasta el cierre
  consultado − anticipos − pagos realizados en ese lapso. El resumen mensual
  distingue saldo anterior, generado, anticipos y pagos del mes. No proyecta
  ingresos de turnos futuros.
- Las entregas tienen ID idempotente generado por el cliente. Un reintento no
  duplica el registro; cambiar el contenido del mismo ID devuelve 409. Solo
  administración registra o anula. Las anulaciones guardan responsable y motivo.
- Los pagos son entregas sobre comisiones devengadas: no se vuelven a cargar
  como gasto operativo automáticamente. La comisión ya forma parte del costo
  de los trabajos. Los movimientos permanecen en el registro del empleado.

## Chat

Incluye privados, grupos, participantes administrados por quien crea el grupo,
texto, fotos, reacciones, edición propia durante 15 minutos, borrado propio
durante 24 horas, favoritos, silencio, búsqueda y contadores de no leídos.
Administración puede borrar mensajes únicamente en conversaciones de las que
forma parte. Los nuevos miembros ven mensajes posteriores a su ingreso.

El cursor es una secuencia entera: evita perder mensajes con timestamps iguales.
La lectura avanza hasta el último mensaje efectivamente visible en la pantalla.
Las respuestas y el cache se separan por usuario/local y no se guardan en
localStorage. Las rutas envían `Cache-Control: no-store`.

Las fotos se comprimen en el navegador (lado máximo 1400px, JPEG), se limitan
a 1 MB y se guardan con el mensaje en PostgreSQL. La descarga exige JWT y
membresía, no genera una URL pública. Dejan de estar disponibles a los 180 días.
Para liberar físicamente ese almacenamiento, ejecutar en el mantenimiento:

```sql
UPDATE team_chat_messages SET photo_data=NULL,photo_type=NULL
WHERE photo_data IS NOT NULL AND created_at < now()-interval '180 days';
```

El push usa las variables VAPID existentes y los dispositivos de los miembros
activos, respeta el silencio y oculta el contenido del mensaje. Las cuentas
personales no reciben los avisos generales de Agenda. El chat sigue funcionando
por consulta periódica sin configurar push. Las cuentas de chofer conservan
su restricción anterior de suscripción push y cuentan con los avisos dentro de la app.

## Activación

1. Respaldar la base siguiendo el procedimiento habitual.
2. Con `DATABASE_URL` del entorno correspondiente, ejecutar
   `node scripts/migrar-cuentas-chat.mjs`. Usa la misma conexión propietaria que el
   backend. Las nuevas tablas tienen RLS habilitado para bloquear clientes
   directos; las consultas del servidor usan la conexión propietaria.
3. Publicar el backend y después el frontend. Las migraciones son aditivas y
   pueden aplicarse antes de publicar el código.
4. En Equipo → empleado → Liquidación, definir inicio y saldo anterior.
5. En Usuarios, crear o vincular una cuenta Staff a ese empleado.
6. Verificar una sesión personal y una de administración en el mismo período.

Implementado y probado localmente. No se aplicaron migraciones a producción
ni se publicaron versiones como parte de este cambio.

## Validación

`node --test --experimental-test-module-mocks tests/*.test.js` ejecuta la
regresión del backend; `tests/employee-ecosystem.test.js` cubre PostgreSQL real
embebido, comisiones compartidas, saldo, idempotencia, permisos por local,
chat privado/grupal, fotos, paginación y bajas con tokens existentes.
La prueba de navegador y las capturas están en
`/workspace/review/employee-ecosystem` y usan datos ficticios.
