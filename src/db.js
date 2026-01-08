import pg from "pg";
import { buildPoolConfig } from "./dbConfig.js";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

export const pool = new Pool(buildPoolConfig(process.env.DATABASE_URL));
