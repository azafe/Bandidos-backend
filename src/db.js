import pg from "pg";
import { buildPoolConfig } from "./dbConfig.js";

const { Pool } = pg;

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
