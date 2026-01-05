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
```

## Base de datos
Ejecuta el SQL de creacion en tu base (Supabase):
- `db/create_servicios.sql`

## Ejecutar en local
```bash
npm run dev
```

## Endpoints
- `GET /health` -> `{ ok: true }`
- `GET /services` -> lista ordenada por `date` desc
- `POST /services`
- `PUT /services/:id`
- `DELETE /services/:id`

## Deploy en Railway
1. Crea un nuevo proyecto en Railway y conecta el repo.
2. Configura las variables `DATABASE_URL`, `FRONTEND_ORIGIN`, `PORT`.
3. Comando de inicio: `npm start`.
