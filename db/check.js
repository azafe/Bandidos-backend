import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

try {
  const result = await pool.query("select now() as now");
  console.log("DB ok:", result.rows[0]);
} catch (err) {
  console.error("DB error:", err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
