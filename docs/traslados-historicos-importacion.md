# Incorporación del legado hasta el 15/10/2026

El corte autorizado es **2026-10-15 inclusive**. Todo turno del 16/10/2026 en
adelante queda fuera, sin importar cuándo se ejecute la operación. No es una
importación automática al desplegar ni una conversión a viajes pendientes.

## Preparación y revisión

1. Aplicar `027_traslados_historicos.sql` después de 026. Solo crea la tabla de
   copias originales e índices: no importa ni actualiza datos del negocio.
2. Desplegar backend y frontend. **027 debe estar aplicada antes del backend**:
   los agregados y la hoja de ruta consultan la tabla nueva aunque esté vacía.
3. Con cuenta de administrador abrir Traslados del día y **Revisar históricos
   hasta el 15/10**. Se muestran cantidad, registros, importes ya incluidos en
   informes, SQL exacto y sus parámetros del local autenticado.
4. Revisar esos datos y marcar la confirmación expresa. Solo entonces el botón
   de importación hace escrituras. Si los datos cambiaron, se rechaza con 409 y
   se solicita una revisión nueva. Un error de red permite reintentar la misma
   revisión sin duplicar registros.

No se conoce la cantidad real desde este entorno: no hay acceso a producción.
El número 6 informado por el usuario pertenecía al día 16, que queda excluido.
No se ejecutó ni la migración 027 ni el backfill en producción desde este trabajo.

## Qué se conserva

Por cada turno elegible se agregan una solicitud de origen `historico`, un
tramo `ida_y_vuelta` y una copia en `traslado_historicos`. Se conserva literalmente
en la copia el importe, la bonificación (incluido NULL), dirección, nombres,
fecha y estado del turno. Se registra responsable y revisión de importación.
Los turnos originales no se modifican, ni se duplican solicitudes existentes.

No se sabe el chofer, móvil, zona, hora, estado operativo ni fecha exacta del
cobro: no se inventan. El tramo guarda estado NULL y la fecha del turno como
referencia; la interfaz explica esa diferencia. No se generan `traslado_cobros`.

Un cero sin bonificación explícita se conserva como cero sin clasificar. Los
datos crudos de `traslado_historicos` son la fuente de lectura histórica. La
solicitud mantiene las restricciones del modelo operativo (precio positivo,
bonificación explícita o precio NULL), sin reinterpretar la copia original.
También se preservan datos inconsistentes anteriores, como montos negativos o
bonificación con importe positivo, sin reclasificarlos ni habilitar cobros.

## Totales e historial

Antes de importar, los informes usan `agenda_turnos` para el legado sin
solicitud. Después usan exclusivamente su copia histórica, manteniendo el
mismo criterio de turno finalizado, importe y fecha de referencia. No suma
ambas fuentes ni traslada ese dinero a Caja. Los cobros nuevos de operaciones
actuales mantienen su fecha y destinatario propios.

Los históricos aparecen separados de las paradas operativas al consultar su
día. Se bloquean cobros, cancelaciones, cambios de estado y modificaciones de
los datos originales de traslado/fecha/estado del turno. Las notas del grooming
pueden corregirse sin alterar la copia. Las correcciones históricas requieren
un flujo posterior revisado; no se convierten en una operación nueva editable.

## API y SQL

- `GET /v2/traslados/historicos/revision?hasta=2026-10-15`: administrador;
  revisión de solo lectura con resumen, items, hash, SQL y parámetros. No acepta
  otros cortes ni un local indicado por el cliente.
- `POST /v2/traslados/historicos/importar`:
  `{hasta:"2026-10-15",revision,cantidad,confirmar:true}`, administrador.
  Bloquea el local y los turnos revisados; verifica de nuevo cantidad y datos.
  La operación usa los IDs exactos revisados para excluir filas concurrentes
  que todavía no se mostraron al usuario. Reintento por la misma revisión
  devuelve la importación previa. Una FK o un conteo distinto revierte todo.
- `db/operations/importar_traslados_historicos.sql`: INSERT exacto parametrizado,
  ejecutado dentro de la transacción del endpoint; separado de migraciones.
- `docs/traslados-historicos-diagnostico.sql`: alternativa de solo lectura con
  local explícito y el mismo corte. Sin UUID real no sirve como conteo previo.
- Las cuentas restringidas de chofer no acceden a revisión, confirmación ni
  historial ajeno. Todas las referencias incluyen el local.

## Pruebas

`node --test tests/traslados-historicos.test.js` usa PostgreSQL embebido con
autenticación consultada en la base. Cubre cantidades/SQL, corte, otro local,
permisos, revisión desactualizada, concurrencia, reintentos, rollback por FK,
datos originales, ceros desconocidos, totales antes/después y restricciones.
El helper aplica 027 dos veces para verificar repetibilidad.

El navegador móvil confirma revisión sin escrituras, confirmación explícita,
historial separado, datos originales y totales iguales, seis turnos del día 16
intactos, ausencia de recibos nuevos y acceso exclusivo del chofer. Los datos
de estas pruebas son descartables, no los registros reales del local.
