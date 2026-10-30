import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { pool } from '../src/db.js';

// Ejecutar con la misma conexión propietaria que usa el backend. No imprime
// DATABASE_URL ni otras credenciales. Cada archivo es transaccional e idempotente.
const client=await pool.connect();
try {
  for(const name of ['035_cuentas_personales.sql','036_chat_equipo.sql']){
    await client.query(await readFile(new URL(`../db/migrations/${name}`,import.meta.url),'utf8'));
    console.log(`Aplicada ${name}`);
  }
}catch(error){
  await client.query('ROLLBACK');
  console.error('La migración falló:',error.message);
  process.exitCode=1;
}finally{
  client.release();
  await pool.end();
}
