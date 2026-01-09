# Bandidos Backend

Backend Node.js (Express) para gestionar servicios de peluqueria canina.

## Requisitos
- Node 20+
- PostgreSQL (Supabase)

## Instalacion
```bash
npm install
```

## Configuracion
Crea un archivo `.env` en la raiz basado en `.env.example`:
```
DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/postgres
FRONTEND_ORIGIN=*
PORT=3000
JWT_SECRET=supersecret
PASSWORD_RESET_URL_BASE=https://miapp.com/reset-password
PASSWORD_RESET_TOKEN_TTL_MINUTES=60
EMAIL_PROVIDER=smtp
EMAIL_FROM=no-reply@miapp.com
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=usuario
SMTP_PASS=clave
SMTP_SECURE=false
```
Notas:
- Para proveedores como Supabase, suele venir `?sslmode=require` en `DATABASE_URL`.
- Si quieres verificar certificados, define `DATABASE_SSL_REJECT_UNAUTHORIZED=true`.
- Para certificados propios, define `DATABASE_SSL_CA=archivoCA.crt` (o usa el archivo incluido).

## Base de datos
Ejecuta el SQL de creacion en tu base (Supabase):
- `db/create_servicios.sql`
- `db/create_schema.sql` (incluye usuarios, tokens de reset y auditoria)

## Ejecutar en local
```bash
npm run dev
```

## Endpoints
- `GET /health` -> `{ ok: true }`
- `POST /auth/register` -> `{ token, user }`
- `POST /auth/login` -> `{ token, user }`
- `POST /auth/forgot-password` -> `{ ok: true }`
- `POST /auth/reset-password` -> `{ ok: true }`
- `GET /me` -> requiere `Authorization: Bearer <token>`
- `GET /reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD&include_fixed=true`
- `GET /reports/daily?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /reports/by-groomer?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /reports/by-customer?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /services` -> lista ordenada por `date` desc (tabla `services`)
- `GET /services?from=YYYY-MM-DD&to=YYYY-MM-DD&customer_id=UUID&pet_id=UUID&service_type_id=UUID&groomer_id=UUID`
- `POST /services`
- `PUT /services/:id`
- `DELETE /services/:id`
- `GET /v2/users`
- `GET /v2/users/:id`
- `POST /v2/users`
- `PUT /v2/users/:id`
- `DELETE /v2/users/:id`
- Nota: `/v2/users*` requiere token con rol `admin`.
- `GET /v2/employees`
- `GET /v2/employees/:id`
- `POST /v2/employees`
- `PUT /v2/employees/:id`
- `DELETE /v2/employees/:id`
- `GET /v2/customers`
- `GET /v2/customers?q=texto` -> filtra por nombre/email/tel
- `GET /v2/customers/:id`
- `POST /v2/customers`
- `PUT /v2/customers/:id`
- `DELETE /v2/customers/:id`
- `GET /v2/pets`
- `GET /v2/pets?customer_id=UUID&q=texto` -> filtra por cliente y nombre/raza
- `GET /v2/pets/:id`
- `POST /v2/pets`
- `PUT /v2/pets/:id`
- `DELETE /v2/pets/:id`
- `GET /v2/service-types`
- `GET /v2/service-types?q=texto`
- `GET /v2/service-types/:id`
- `POST /v2/service-types`
- `PUT /v2/service-types/:id`
- `DELETE /v2/service-types/:id`
- `GET /v2/payment-methods`
- `GET /v2/payment-methods?q=texto`
- `GET /v2/payment-methods/:id`
- `POST /v2/payment-methods`
- `PUT /v2/payment-methods/:id`
- `DELETE /v2/payment-methods/:id`
- `GET /v2/services`
- `GET /v2/services?from=YYYY-MM-DD&to=YYYY-MM-DD&customer_id=UUID&pet_id=UUID&service_type_id=UUID&groomer_id=UUID`
- `GET /v2/services/:id`
- `POST /v2/services`
- `PUT /v2/services/:id`
- `DELETE /v2/services/:id`
- `GET /v2/suppliers`
- `GET /v2/suppliers?q=texto&category=texto`
- `GET /v2/suppliers/:id`
- `POST /v2/suppliers`
- `PUT /v2/suppliers/:id`
- `DELETE /v2/suppliers/:id`
- `GET /v2/expense-categories`
- `GET /v2/expense-categories?q=texto`
- `GET /v2/expense-categories/:id`
- `POST /v2/expense-categories`
- `PUT /v2/expense-categories/:id`
- `DELETE /v2/expense-categories/:id`
- `GET /v2/daily-expenses`
- `GET /v2/daily-expenses?from=YYYY-MM-DD&to=YYYY-MM-DD&category_id=UUID`
- `GET /v2/daily-expenses/:id`
- `POST /v2/daily-expenses`
- `PUT /v2/daily-expenses/:id`
- `DELETE /v2/daily-expenses/:id`
- `GET /v2/fixed-expenses`
- `GET /v2/fixed-expenses?category_id=UUID&status=active`
- `GET /v2/fixed-expenses/:id`
- `POST /v2/fixed-expenses`
- `PUT /v2/fixed-expenses/:id`
- `DELETE /v2/fixed-expenses/:id`

## Deploy en Railway
1. Crea un nuevo proyecto en Railway y conecta el repo.
2. Configura las variables `DATABASE_URL`, `FRONTEND_ORIGIN`, `PORT`.
3. Comando de inicio: `npm start`.
