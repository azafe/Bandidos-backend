# Bandimóviles — Etapa 1

## Modelo y decisiones

El precio es **único por ida y vuelta**, con una solicitud económica por turno.
Los tramos de búsqueda y entrega tienen asignaciones, direcciones, fechas,
horarios y estados propios; nunca repiten el importe total.

`traslado_solicitudes` guarda el precio y la versión de configuración económica.
`traslados` guarda la operación de cada tramo. `traslado_cobros` registra un solo
cobro por solicitud, con fecha, quién cobró, chofer si corresponde, medio de pago
y usuario responsable. El importe se obtiene del precio guardado por el servidor;
no se acepta un importe libre ni un tenant enviado por el cliente.

**Registrar cobro** es una operación explícita. Finalizar la peluquería no cobra
el traslado ni marca la entrega como realizada. Un precio pendiente es NULL;
bonificado significa decisión explícita y precio cero, sin generar un cobro.
Los cobros son inmutables en esta etapa: cambios de importe, cancelaciones o
eliminaciones que borrarían un cobro se rechazan con 409. Una corrección o
anulación económica necesita un flujo posterior de reversión, no editar historia.

Las zonas ofrecen tarifas sugeridas, sin decidir tarifa por zonas o kilómetros
ni recalcular presupuestos. La configuración de chofer admite sin definir,
ninguno, porcentaje (0–100) y jornal, además de costo de referencia y unidad.
No se inventa un jornal ni se confunde falta de datos con costo cero. Cada cambio
guarda una versión; las solicitudes anteriores conservan su referencia.

## Migración y despliegue

1. Revisá y aplicá `db/migrations/025_traslados_registros.sql` en la base del
   entorno de prueba y luego en el destino aprobado. Requiere las migraciones
   anteriores, incluida la 024.
2. Desplegá el backend y después el frontend de esta etapa.
3. Creá vehículos y zonas, marcá integrantes como choferes y guardá las
   condiciones económicas que conozcas. No hay datos del negocio precargados.

La 025 agrega estructura, índices y restricciones; no importa turnos históricos,
no borra columnas ni modifica importes existentes. Se verificó repetibilidad y
conservación de filas anteriores en PostgreSQL embebido; no se ejecutó en
producción. Las referencias incluyen tenant_id para impedir cruces entre locales.
Los vehículos/zonas se desactivan y los traslados se cancelan lógicamente. No se
borra en cascada la historia al intentar eliminar turnos, empleados o responsables.

## API

Todas las rutas requieren autenticación y contexto de local activo.

| Rutas | Contrato |
| --- | --- |
| `/v2/vehiculos`, `/v2/traslado-zonas` | GET lista/detalle, POST, PUT parcial y DELETE como desactivación; escrituras de administrador. |
| `/v2/traslados/configuracion` | GET vigente y PUT que agrega una versión; administrador. Valores no definidos se envían como NULL. |
| `/v2/traslado-solicitudes` | GET por turno_id opcional, GET detalle, POST `{turno_id, solicitud}`, PUT completo de precio/tramos/notas y DELETE como cancelación. |
| `/v2/traslado-solicitudes/:id/cobro` | POST explícito e idempotente: `{fecha, cobrado_por, chofer_id, payment_method_id}`; roles actuales de caja (admin, user, staff). |
| `/v2/traslados` | GET con from/to, turno_id, chofer_id y vehiculo_id; GET detalle, POST `{solicitud_id, tramo}`, PUT completo y DELETE como cancelación. |
| `/v2/traslado-solicitudes/cobrados` | GET `{from,to}`: importe realmente cobrado en el período, incluyendo legado sin solicitud. |

Una solicitud usa `{precio_total,bonificado,notas,tramos}`. Cada tramo admite
`tipo`, referencias a chofer/vehículo/zona, dirección, fecha/hora, estado y notas.
La hora queda pendiente si no se conoce; no se copia la hora del grooming como
supuesta hora de entrega. No se permiten dos tramos del mismo tipo. Antes de
salir deben existir dirección, chofer y vehículo. No se salta de pendiente a
entregado ni se reescriben asignaciones de un tramo entregado.

Agenda admite `traslado_solicitud` en sus dos altas y en PUT. Las escrituras de
Agenda y las de la API de traslados usan la misma sincronización transaccional.
Los campos anteriores se mantienen como resumen. Un reintento del cobro con
los mismos datos devuelve el registro original; con otros datos devuelve 409.
Los bloqueos siguen el orden turno → solicitud para serializar cierres y cobros.

## Caja, dashboard e históricos

Caja suma únicamente cobros recibidos por el local, según fecha y medio de pago
del traslado. El bloque informativo suma cobros recibidos por choferes. La tarjeta
del dashboard usa cobros registrados en lugar de interpretar presupuestos como
dinero recibido. El ingreso de grooming conserva su cálculo; esta etapa no hace
la cuenta de resultados de Traslados.

Un turno histórico sin solicitud conserva el tratamiento de Etapa 0 y se cuenta
una sola vez. Editar notas no crea ni clasifica un traslado. Una operación nueva
reemplaza su resumen en los agregados: nunca se suman ambas fuentes. La posible
duplicación previa de ingresos de grooming entre agenda y services sigue fuera
del alcance de esta etapa.

**No se ejecuta backfill.** La consulta de diagnóstico está en
`traslados-historicos-diagnostico.sql`, solo lectura. Antes de importar se debe
mostrar al usuario su resultado por local y el INSERT exacto para otra aprobación.
No se conoce todavía cuántas filas reales serían elegibles. La propuesta futura
es una solicitud de origen histórico y un tramo ida_y_vuelta por turno, sin
inventar chofer, vehículo, zona, hora, estado ni fecha exacta de cobro. Los ceros
sin bonificación explícita necesitan revisión; no se convierten en bonificados
ni en recibos ficticios. Una solicitud cancelada conserva su historia y no se
reactiva por los campos antiguos del turno.

## Verificación

- `node --test tests/traslados-registros.test.js tests/traslados-api.test.js`:
  pruebas HTTP sobre PostgreSQL embebido (PGlite como dependencia de desarrollo).
  Incluyen todas las rutas nuevas, permisos, referencias cruzadas entre locales,
  reintentos concurrentes de cobro, rollback, versiones, caja e históricos.
- `npm run lint`, `npm test` y `npm run test:integration`.
- El backend no tiene script de build.

La base previa de npm test tiene cinco fallas (cuatro casos de empleados sin
credenciales y su contenedor), y una omisión. test:integration agrega las dos
fallas previas de fotos porque omite --experimental-test-module-mocks. Se
conservan y se informan; no se cambian tests ajenos para ocultarlas.
