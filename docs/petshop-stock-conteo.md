# PetShop: stock con conteo

Adaptado del módulo de stock de la ONG. Aplicar **030_petshop_stock_conteo.sql
antes de desplegar el backend**: es aditiva y repetible, no cambia el stock,
los importes ni las ventas existentes. Los movimientos anteriores conservan su
tipo (`in` → ingreso, `out` → merma, `adjust` → ajuste) sin inventar la
diferencia ni el saldo que no se guardaron.

## Qué registra

Cada cambio de stock deja un movimiento con tipo, diferencia aplicada, saldo
resultante, usuario y fecha:

- **inicial**: stock con el que se crea un producto (no cuenta como conteo).
- **ingreso** (con costo unitario opcional) y **merma** (con motivo obligatorio).
- **venta** / **devolucion**: alta, edición y borrado de ventas del PetShop.
- **ajuste**: stock editado desde el producto o el endpoint anterior.
- **conteo**: lo que hay en el estante. Si no coincide con el sistema exige
  motivo (422 con el saldo actual). Marca `last_counted_at` del producto.

La columna `type` sigue completándose con el mismo sentido de antes. Un
`client_id` hace idempotente el reintento; el mismo id con otros datos es 409.
Borrar un producto sin ventas borra su historial; con ventas responde 409.

## API (cualquier usuario del local)

- GET `/v2/petshop/stock`: productos con saldo, mínimo, último conteo, último
  costo de ingreso y unidades vendidas en 30 días.
- GET `/v2/petshop/stock/movements?product_id&kind=a,b&from&to&limit`.
- POST `/v2/petshop/stock/movements`:
  `{client_id?, product_id, kind: ingreso|merma|conteo, quantity, unit_cost?, note?}`.
- GET `/v2/petshop/stock/review`: negativos, nunca contados, para recontar
  (más de 30 días), bajo mínimo y diferencias de conteos de 30 días valuadas
  al costo del producto.

## Validación

`tests/petshop-stock.test.js` corre contra PostgreSQL embebido: migración sobre
datos anteriores y repetida, historial completo, conteo con y sin motivo,
idempotencia, ventas, ajuste, endpoint anterior, revisión y aislamiento por
local. Las fallas previas de empleados sin auth siguen igual que en main.
