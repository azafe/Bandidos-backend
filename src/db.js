import pg from "pg";
import { buildPoolConfig } from "./dbConfig.js";

const { Pool, types } = pg;

// Por defecto "pg" parsea las columnas `date` como objetos Date en UTC medianoche,
// y JSON.stringify (res.json) los serializa como "2024-05-14T00:00:00.000Z". Si ese
// valor vuelve tal cual en un PUT, rompe los schemas de Zod que validan
// `/^\d{4}-\d{2}-\d{2}$/` (ej: birth_date de mascotas, date de turnos) con
// "Invalid request body". Devolvemos el string crudo ("2024-05-14") tal como lo
// manda Postgres, sin pasar por Date.
types.setTypeParser(1082, (value) => value);

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

export const pool = new Pool(buildPoolConfig(process.env.DATABASE_URL));

// Sin este listener, un error en un cliente ocioso del pool (la DB se
// reinicia, un blip de red) es una excepción no capturada que tira abajo
// todo el proceso -no solo el pedido en curso. `pg` emite "error" en el
// Pool específicamente para que se maneje así.
pool.on("error", (err) => {
  console.error("[db] Unexpected error on idle client", err);
});
