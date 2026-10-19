# Bandimóviles — Rendición de choferes y socios

## Publicación

Aplicar **029_traslados_rendiciones.sql después de 028**, antes de publicar el
backend, y luego publicar el frontend. La protección de gastos/jornales de
Etapa 3 consulta las tablas nuevas: la migración es necesaria antes del backend.
Es aditiva y repetible: crea tablas e índices, sin importar saldos, asociar
nombres escritos, cambiar cobros, completar porcentajes ni tocar turnos viejos.
No se ejecutó en producción. La Etapa 4 de rutas/reservas/GPS queda aparte.

## Qué se rinde

Cada integrante del local (también un socio sin ser chofer) puede tener una
rendición. Solo el administrador consulta, prepara, confirma, registra dinero
y corrige. Las cuentas de chofer conservan su acceso exclusivo a sus tramos;
ni cambiando URL o IDs acceden a estas rutas o a sus datos financieros.

Las fuentes son cobros explícitos de la tabla propia, remuneraciones pactadas,
jornales registrados y gastos externos revisados. Los históricos sin recibo o
cobrador conocido no se asignan ni generan deuda por su monto anterior.
La revisión toma un período de hasta un año, con fechas hasta hoy de Argentina.

Por persona:

    Saldo inicial = cobrado a clientes − remuneración − reintegros aprobados
    Saldo pendiente = saldo inicial − entregas al local + pagos a la persona

Positivo: la persona debe entregar al local. Negativo: el local debe pagarle.
La referencia de un chofer hipotético de Etapa 3 no genera una remuneración real.
El saldo de rendiciones ya confirmadas se muestra separado de los conceptos
por confirmar, e incluye todos los períodos para conservar pendientes anteriores.

- Cobro por chofer: se atribuye a quien efectivamente cobró. Un cobro recibido
  por el local no significa dinero en poder del chofer.
- Porcentaje pactado: remuneración total calculada una vez por viaje completo,
  repartida explícitamente entre personas del local. No hay un 50/50 o 100% por
  defecto, aunque participe una sola persona. Se conservan todos los centavos.
  Resultados y Rendiciones comparten el redondeo porcentual entero para evitar
  diferencias de un centavo por coma flotante en importes grandes.
- Jornal: una fuente por registro de chofer/fecha, sin multiplicarla por tramos
  ni mascotas. Se detectan días trabajados con modelo jornal sin registro.
- Gasto externo: se elige una persona por ID y se decide si es reintegrable.
  El texto anterior del pagador se conserva como referencia y no se interpreta
  automáticamente. Un gasto a cargo de la persona se conserva como concepto
  de importe rendible cero, con el importe original en su copia de respaldo.
  Cambiar un gasto aún no rendido invalida la aprobación anterior.
- Condiciones de pago desconocidas, repartos o gastos pendientes impiden
  confirmar rendiciones del período. Las condiciones/jornales se completan en
  Resultados; en Rendiciones se revisan reintegros y repartos entre personas.
  El reparto entre vehículos es independiente del reparto de remuneraciones.

Si hubo dinero entregado o pagado antes de usar esta pantalla, se registra con
su fecha real en la rendición correspondiente. No se presume un saldo inicial
ni se crean movimientos históricos sin una decisión y datos verificables.

## Confirmación, movimientos y correcciones

Revisar es solo lectura. Confirmar requiere el identificador estable del cliente,
una huella de los datos revisados y confirmación explícita. Se guardan persona,
período, importes, fuentes y copias de respaldo, incluyendo quién aprobó gastos
reintegrables y repartos. Un concepto no puede incluirse en dos rendiciones
vigentes de la misma persona, aunque se superpongan los períodos.

La confirmación toma un bloqueo por local y bloqueos de las fuentes económicas.
Recalcula la revisión y rechaza datos nuevos o cambiados antes de escribir.
Mantiene READ COMMITTED durante la escritura para que un reintento concurrente
con el mismo ID vea el resultado confirmado por el primero. Las consultas de
revisión, lista y detalle usan snapshots de lectura consistentes.

Confirmar **no paga ni entrega dinero**. Después se registran movimientos reales
con fecha, medio e importe, admitiendo pagos parciales hasta el saldo pendiente.
Se rechaza el sentido incorrecto, un exceso o un movimiento nuevo sobre saldo
cero. El bloqueo de la rendición serializa pagos simultáneos. Los movimientos
no son editables, y los UUID estables evitan duplicar cobros al reintentar.

El importe, el jornal y la decisión de reintegro quedan protegidos al rendirlos.
El reparto completo de un cobro queda protegido cuando se confirma cualquiera
de sus conceptos, incluso si el cobrador no recibe remuneración. El detalle
confirmado conserva sus nombres y conceptos aunque el catálogo cambie después.

Para corregir, se registra una reversión completa de cada movimiento afectado,
con fecha, motivo y medio (puede diferir si el dinero se devolvió por otro medio).
La reversión es un nuevo registro de efecto contrario; conserva el original,
no puede antecederlo ni puede revertirse dos veces o encadenarse sobre otra
reversión. Solo después de revertir todos los movimientos se permite anular la
rendición. Se conserva el historial y sus conceptos quedan disponibles para
otra revisión; no se borran registros ni se produce un nuevo movimiento de dinero
al anular. Una rendición sin movimientos puede anularse directamente.

## Caja y resultados

La sección nueva de Rendición de Caja muestra entradas, salidas y reversiones
por fecha y medio, separadas de la facturación. Los totales originales de
system-totals y los resultados de la unidad no suman otra vez estos movimientos:
el ingreso de clientes, la remuneración y el gasto ya tienen su fuente propia.
El fallo de este bloque no impide consultar los ingresos existentes de Caja.

## API (solo administrador, siempre con local)

Base `/v2/traslados/rendiciones`:

- GET `/revision?from=YYYY-MM-DD&to=YYYY-MM-DD`: personas, conceptos nuevos,
  pendientes, revisión de gastos y reparto de remuneraciones; ninguna escritura.
- PUT `/gastos/:id`: `{persona_id,reintegrable,revision}`; ID del costo externo.
- PUT `/repartos/:id`: `{revision,items:[{persona_id,porcentaje}]}`; ID del cobro,
  suma 100% sin repetidos y personas del mismo local.
- POST base: `{id,persona_id,from,to,revision,confirmar:true}`; confirma conceptos
  nuevos de esa persona. 409 si cambió la revisión, faltan datos o no hay conceptos.
- GET base: `persona_id` opcional, `limit` 1–100 y `offset`; historial de todos
  los períodos, con saldos pendientes y sus copias de respaldo.
- GET `/:id`: detalle confirmado, conceptos, movimientos y saldo actual.
- POST `/:id/movimientos`: `{id,tipo,monto,fecha,payment_method_id,referencia}`;
  tipo `entrega_local` o `pago_persona`, acorde al signo del saldo.
- POST `/:id/reversiones`:
  `{id,movimiento_id,fecha,payment_method_id?,motivo,confirmar:true}`; sin medio
  explícito conserva el original, sin cambiarlo retrospectivamente.
- POST `/:id/anulacion`: `{motivo,confirmar:true}`; requiere todos sus movimientos
  revertidos. Idempotente con el mismo motivo; conserva fuentes e historial.
- GET `/caja?fecha=YYYY-MM-DD`: entradas y salidas del día más detalle, fuera de
  los ingresos operativos. Se registra una reversión con signo contrario.

Los POST con dinero y confirmaciones conservan el ID al reintentar; cambiar los
valores con el mismo ID devuelve 409. No se acepta tenant o responsable en el
body. Cada FK de persona, fuente, rendición, medio y usuario incluye tenant_id.
La relación de items refuerza también que la persona coincida con su cabecera.

## Prueba manual

1. Crear un viaje de $10.000 con 25% de remuneración, cobrado por Jorge.
2. Registrar $2.000 de nafta pagada por Jorge y aprobar su reintegro; un gasto
   de $500 de César marcado no reintegrable y un jornal de $3.000 de César.
3. En Rendiciones, repartir remuneración 60% Jorge y 40% César: Jorge debe
   entregar $6.500 y el local debe pagar a César $4.000. Revisar y confirmar
   individualmente: no debe generarse todavía movimiento de dinero.
4. Registrar entregas de Jorge de $2.500 y $4.000: saldo cero. Registrar pago
   parcial a César de $1.500: quedan $2.500 a su favor. Caja los muestra aparte;
   los ingresos originales y los resultados de la unidad conservan sus importes.
5. Reintentar el mismo movimiento, exceder el saldo, repetir conceptos en otro
   período y editar fuentes rendidas: no debe duplicar ni reescribir importes.
6. Revertir una entrega con motivo/fecha/medio; comprobar saldo y original.
   Revertir todas y anular: los conceptos reaparecen y el historial se conserva.
7. Cambiar persona/período y probar en teléfono y escritorio. Con cuenta de
   chofer, la URL redirige a Mis traslados y toda llamada financiera devuelve 403.
