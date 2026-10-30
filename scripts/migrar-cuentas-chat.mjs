import 'dotenv/config';
import { pool } from '../src/db.js';
import { migrateEmployeeEcosystem } from '../src/employeeMigrations.js';

// Ejecutar con la misma conexión propietaria que usa el backend. No imprime
// DATABASE_URL ni otras credenciales. Cada archivo es transaccional e idempotente.
try {
  const applied=await migrateEmployeeEcosystem(pool);
  if(!applied.length)console.log('Las migraciones de cuentas y chat ya están aplicadas.');
}catch(error){
  console.error('La migración falló:',error.message);
  process.exitCode=1;
}finally{
  await pool.end();
}
