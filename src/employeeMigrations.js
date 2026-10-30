import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const employeeMigrationNames=['035_cuentas_personales.sql','036_chat_equipo.sql'];

// Se ejecuta antes de escuchar tráfico en Railway, con la conexión de servidor
// existente. El lock serializa réplicas y el journal evita repetir el backfill
// en cada reinicio. Esquema y journal se confirman en una sola transacción.
export async function migrateEmployeeEcosystem(pool,{log=console.log}={}) {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='15s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    await client.query('SELECT pg_advisory_xact_lock(266426,35)');
    await client.query(`CREATE TABLE IF NOT EXISTS app_schema_migrations(
      name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`);
    await client.query('ALTER TABLE app_schema_migrations ENABLE ROW LEVEL SECURITY');
    await client.query('REVOKE ALL ON app_schema_migrations FROM PUBLIC');
    const applied=[];
    for(const name of employeeMigrationNames){
      const sql=await readFile(new URL(`../db/migrations/${name}`,import.meta.url),'utf8');
      const checksum=createHash('sha256').update(sql).digest('hex');
      const previous=(await client.query('SELECT checksum FROM app_schema_migrations WHERE name=$1',[name])).rows[0];
      if(previous){
        if(previous.checksum!==checksum) throw new Error(`La migración ${name} difiere de la aplicada. Usá una migración nueva.`);
        continue;
      }
      const statements=sql.replace(/^\s*BEGIN;\s*/i,'').replace(/\s*COMMIT;\s*$/i,'');
      await client.query(statements);
      await client.query('INSERT INTO app_schema_migrations(name,checksum) VALUES($1,$2)',[name,checksum]);
      applied.push(name);
    }
    await client.query('COMMIT');
    for(const name of applied)log(`[schema] Aplicada ${name}`);
    return applied;
  } catch(error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
