# Traslados — Etapa 0

Los cobros de traslados pertenecen a los choferes. La caja deja de devolver el
concepto `traslados` en `GET /v2/daily-incomes/system-totals`; el formato de la
respuesta y los conceptos restantes se conservan. La posible duplicación de
servicios entre agenda y `services` queda fuera de esta etapa.

`GET /v2/daily-incomes/traslados-summary?date=YYYY-MM-DD` requiere autenticación
y devuelve `{ "amount": 13000 }`: suma de `traslado_amount` de los turnos
finalizados con traslado del local autenticado y la fecha indicada. Incluye
turnos sin medio de pago porque el medio de pago del servicio no identifica
cómo cobró el chofer. Sin cobros devuelve `{ "amount": 0 }`.

## Migración y despliegue

1. Revisá y aplicá `db/migrations/024_traslado_bonificado.sql` en la base del
   entorno a desplegar, antes del backend. Solo agrega una columna nullable;
   es repetible y no ejecuta UPDATE, DELETE ni reclasifica datos anteriores.
2. Desplegá este backend y después el frontend de la misma etapa.
3. Comprobá los cierres y la rendición con un usuario del entorno de prueba.

La migración se validó en una base descartable de PostgreSQL embebido (PGlite),
con filas anteriores a la columna nueva. No se ejecutó en producción.

`traslado_bonificado = NULL` conserva un histórico sin decisión registrada;
`false` y `true` son decisiones explícitas. Las altas por `/agenda` y
`/v2/agenda/with-new-pet` guardan `false` si se omite el campo. Los INSERT
externos que no usan estas rutas pueden seguir dejando NULL.

## Reglas de cierre

- Con traslado, monto mayor a cero o bonificación explícita con monto cero.
- Sin traslado, no se exige importe de traslado.
- En reserva se permite dejar el importe para el cierre.
- Se valida tanto crear ya finalizado como finalizar por PUT, agregar traslado
  a un finalizado y modificar sus datos de traslado.
- Los PUT parciales se validan contra la fila del mismo local y dentro de una
  transacción con bloqueo. Los campos antiguos siguen presentes.
- Editar notas u otros datos de un histórico, o reenviar los mismos datos de
  traslado, no obliga a reclasificarlo. Modificar el traslado sí exige resolver
  el monto o la bonificación. Un local ajeno recibe 404 al intentar editarlo.

## Cómo probar

- `node --test tests/traslados-api.test.js`: cubre cierres, errores de escritura,
  altas, históricos, resúmenes, autenticación y aislamiento entre locales.
- `npm run lint`.
- `npm test` y `npm run test:integration`.

La base previa de `npm test` falla en los cuatro casos de empleados que llaman
rutas protegidas sin autenticación (más el test contenedor); no es una regresión.
El comando `test:integration` además omite `--experimental-test-module-mocks`,
que requieren los tests existentes de fotos. Esas fallas quedan informadas sin
modificar tests ajenos ni el comando para ocultarlas. El backend no tiene build.

Prueba funcional en un entorno de prueba: finalizá con traslado sin monto
(debe dar 400), repetí con importe positivo, y luego con `Bonificado` y cero.
Probá editar el traslado de otro local y comparar ambos resúmenes con usuarios
de locales diferentes. No uses producción para generar estos datos de prueba.
