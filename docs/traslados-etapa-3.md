# Bandimóviles — Etapa 3: resultados y simulador

## Despliegue y alcance

Aplicar **028_traslados_resultados.sql después de 027**, antes de desplegar el
backend; luego desplegar el frontend. Es una migración aditiva y repetible:
crea estructura e índices, sin reclasificar gastos, importar turnos ni modificar
importes, configuraciones originales o caja. No se ejecutó en producción.

La pantalla `/traslados/resultados` y su API son exclusivas del administrador.
El middleware de chofer sigue bloqueando todas las rutas financieras incluso
con tokens antiguos, filtros, IDs o URLs alterados. Todas las consultas y las
referencias nuevas usan el local; los FK compuestos lo refuerzan en PostgreSQL.

## Criterio de cálculo

Es una cuenta de gestión del período: **cobros registrados por fecha de cobro
menos remuneración calculada y gastos del período**. No es una liquidación de
sueldos ni un nuevo movimiento de caja. No se suman presupuestos como ingresos.
El dinero recibido por un chofer no implica que su remuneración sea ese importe.

- Precio único por solicitud: búsqueda y entrega no duplican el ingreso.
- Porcentaje: se aplica una vez al cobro, con la configuración versionada del
  viaje. Ninguno significa cero explícito; sin definir sigue siendo desconocido.
- Jornal: registro explícito por chofer y fecha, único aun si lleva varios perros
  o hace dos tramos. Se incluyen también jornadas cargadas sin cobros del día.
  Se advierten jornadas faltantes de tramos entregados con modelo jornal.
- Referencia: comparación alternativa que **reemplaza** el pago pactado. Por
  traslado completo se aplica una vez; por día se deduplica por chofer y fecha.
  Dos valores o unidades incompatibles en el mismo chofer/día dejan pendiente
  esa comparación. No se inventa un valor de referencia ni un objetivo de lucro.
- Categorías: el administrador elige sus IDs, no se adivina por el nombre
  «Traslados». Deben contener costos del vehículo, excluyendo remuneraciones
  ya calculadas. La selección afecta la clasificación de los reportes, no cambia
  las filas originales; revisar su efecto sobre meses anteriores al cambiarla.
- Gastos diarios: por su fecha; gastos fijos: cargo congelado del mes, nunca la
  plantilla actual ni paid_amount. Un período parcial prorratea cada cargo por
  días calendario. Los cargos con origen backfill siguen marcados como estimados.
- Costos pagados por socios/choferes: registro propio con pagador, fecha y móvil.
  No escribir aquí gastos que ya estén en Gastos del local. Las vinculaciones a
  gastos existentes no los copian ni duplican sus importes.
- Resultado completo solo con gastos revisados y sin datos materiales pendientes.
  La revisión guarda una huella del mes completo (categorías, fuentes e
  imputaciones); altas, ediciones, anulaciones o reasignaciones la invalidan.
  Confirmar también supone comprobar que no falten gastos no registrados.
  Es una revisión de datos, no un cierre contable irreversible.

Los cobros atrasados aparecen cuando se cobran; jornales y gastos conservan su
período. Por ello el cociente costo/actividad es un indicador del período, no el
costo histórico exacto de cada viaje. Los registros antiguos, importados o aún
sin importar, mantienen su importe anterior separado del ingreso verificado;
no tienen costos/fecha de cobro inventados ni habilitan un resultado completo.

## Vehículos, actividad y datos pendientes

Un móvil único recibe el 100%. Si intervienen varios, el importe queda en
**Sin distribuir** hasta que el administrador guarde porcentajes que sumen
100%. Se reparten centavos con residuo determinista para conservar el total.
Los costos/jornales pueden asignarse a un móvil o quedar sin distribuir. Los
importes sin atribución bloquean el resultado por móvil, conservando el total
conocido de la unidad. Si luego cambia una asignación operativa y el reparto
ya no corresponde a los móviles del viaje, vuelve a quedar sin distribuir.

La actividad cuenta una vez al viaje cuyos tramos activos están todos entregados,
por la fecha programada del último tramo, no por el cierre del grooming. No se
supone una fecha efectiva de entrega que el modelo anterior no guardaba. Los
viajes compartidos aportan fracciones equivalentes a cada móvil. Se muestran
bonificados, día de la semana, días con actividad, viajes por día activo,
ingreso promedio por viaje cobrado y costo por viaje completo realizado.
Los viajes parcialmente realizados dejan el costo completo pendiente.

Las condiciones originales nunca se recalculan al guardar otra configuración.
Para operaciones no históricas cuyo modelo era desconocido, hay una revisión
**individual y explícita**: muestra las condiciones que se asignarán y exige
confirmarlas. Guarda responsable, fecha y referencia a esa versión en una tabla
separada, sin sobrescribir la configuración original. Reintentos iguales son
idempotentes; no permite sustituir condiciones ya pactadas o revisadas.

## API (administrador del local)

- GET `/v2/traslados/resultados?from=YYYY-MM-DD&to=YYYY-MM-DD`: rango dentro del
  mismo mes; total, móviles, pendientes, actividad, operaciones, costos, jornales,
  revisión y resumen histórico. Lectura transaccional con snapshot consistente.
- PUT `/v2/traslados/resultados/categorias`: `{ids:[UUID]}`; vacío es una elección
  explícita, no una configuración inicial automática.
- POST `/v2/traslados/resultados/revision-gastos`: `{from,to,revision,confirmar:true}`;
  409 si cambió la huella revisada.
- PUT `/v2/traslados/resultados/gastos/:tipo/:id`: diario/fijo,
  `{vehiculo_id:UUID|null,revision:string|null}`; quitar móvil no borra el gasto.
- PUT `/v2/traslados/resultados/repartos/:id`: ID de solicitud,
  `{revision:string|null,items:[{vehiculo_id,porcentaje}]}`; items vacío quita
  el reparto manual. Los móviles deben pertenecer al viaje y al local.
- PUT `/v2/traslados/resultados/condiciones/:id`:
  `{configuracion_id:UUID,confirmar:true}`; solo condiciones aún desconocidas,
  nunca históricos. La configuración elegida debe tener pago definido.
- POST `/v2/traslados/resultados/costos-externos`:
  `{id:UUID,fecha,concepto,monto,pagado_por,vehiculo_id:UUID|null}`.
- POST `/v2/traslados/resultados/jornadas`:
  `{id:UUID,fecha,chofer_id,monto,vehiculo_id:UUID|null}`.
- PUT en esos dos últimos paths + `/:id`: mismos campos sin id, más
  `{revision:string,anulado:boolean}`. Conservan registros anulados para revisión
  o reactivación; la unicidad evita duplicar una jornada. Se admite registrar
  historia de choferes hoy inactivos, siempre dentro del local.

Los POST usan UUID del cliente estable durante el reintento. Cambiar datos con
el mismo ID devuelve 409. Las ediciones y asignaciones usan revisiones opacas de
PostgreSQL para rechazar escrituras concurrentes desactualizadas. No se acepta
un tenant o un responsable enviado por el cliente.

## Prueba manual

1. Configurar vehículos, pago y referencia; crear un viaje y completar ambos
   tramos. Registrar el cobro explícitamente.
2. En Resultados elegir el mes, guardar categorías y asignar móvil a sus gastos.
   Agregar un costo pagado por un socio; Caja debe conservar exactamente su total.
3. Revisar gastos y confirmar: comparar ingreso menos chofer menos gastos.
   Editar un gasto: la revisión debe volver a pendiente.
4. Probar dos móviles en un viaje, guardar reparto y verificar que suman el
   ingreso original, incluso con un precio como 100,01. No duplicar por tramos.
5. Con modelo jornal, hacer varios viajes del mismo chofer/día y registrar una
   sola jornada; anularla debe volver a mostrar el faltante.
6. Probar referencia diaria, bonificado y condiciones desconocidas. Un valor
   faltante no puede aparecer como costo cero o resultado completo.
7. Simular precio 8000, 20 días, fijo 200000, variable 1000 y jornal 15000:
   equilibrio 72 viajes/mes, 3,6 diarios en promedio o meta constante de 4.
   Con porcentaje 100% no debe prometer equilibrio por aumentar viajes.
8. Inicio muestra el mismo resultado del período (con prorrateo de fijos). Si
   falla la nueva API, conserva el resto del dashboard y muestra Pendiente.
9. Con una cuenta de chofer, entrar a la URL financiera redirige a Mis traslados;
   llamar directamente a cualquiera de sus endpoints devuelve 403.

## Validación

Pruebas HTTP contra PostgreSQL embebido incluyen todas las rutas, permisos,
local ajeno, idempotencia, conflictos, configuración versionada, gastos,
prorrateo, centavos, jornal y referencia diarios e incertidumbre histórica.
Navegador móvil 390px y escritorio con API real de prueba y datos descartables;
solo las fuentes anteriores de Inicio ajenas al módulo usan fixtures.

Completar `npm run lint`, `npm test`, `npm run test:integration` en backend y
lint, tests y build/PWA en frontend. Las fallas previas de empleados sin auth y
las dos suites de fotos sin el flag de mocks de módulos siguen documentadas.
No se modifican datos de producción ni se empieza la Etapa 4.
