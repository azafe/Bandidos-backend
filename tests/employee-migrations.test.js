import assert from 'node:assert/strict';
import test from 'node:test';
import { createTrasladosDb } from './helpers/trasladosDb.js';
import { migrateEmployeeEcosystem, employeeMigrationNames } from '../src/employeeMigrations.js';

// pg admite un archivo SQL completo por query sin parámetros. PGlite ofrece
// ese protocolo simple como exec; las consultas con parámetros usan query.
function adapter(db,{failChat=false}={}) {
  return {connect:async()=>({release(){},async query(sql,params){
    if(failChat && sql.includes('CREATE TABLE IF NOT EXISTS team_chats'))throw new Error('Fallo de migración simulado');
    if(params===undefined && sql.includes(';'))return db.db.exec(sql);
    return db.query(sql,params);
  }})};
}

test('el arranque migra una vez, guarda checksum y rechaza cambios de una migración aplicada',async t=>{
  const db=await createTrasladosDb({realAuth:true,employeeSchema:false});t.after(()=>db.close());
  const connection=adapter(db);
  assert.deepEqual(await migrateEmployeeEcosystem(connection,{log(){}}),employeeMigrationNames);
  assert.deepEqual(await migrateEmployeeEcosystem(connection,{log(){}}),[]);
  const saved=(await db.query('SELECT name,checksum FROM app_schema_migrations ORDER BY name')).rows;
  assert.equal(saved.length,2);assert.equal(saved[0].checksum.length,64);
  const columns=(await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='employee_id'")).rows;
  assert.equal(columns.length,1);
  await db.query("UPDATE app_schema_migrations SET checksum='incorrecto' WHERE name=$1",[employeeMigrationNames[0]]);
  await assert.rejects(migrateEmployeeEcosystem(connection,{log(){}}),/difiere de la aplicada/);
});

test('si falla el chat se revierte toda la migración antes de servir tráfico',async t=>{
  const db=await createTrasladosDb({realAuth:true,employeeSchema:false});t.after(()=>db.close());
  await assert.rejects(migrateEmployeeEcosystem(adapter(db,{failChat:true}),{log(){}}),/Fallo de migración simulado/);
  assert.equal((await db.query("SELECT to_regclass('public.app_schema_migrations') AS name")).rows[0].name,null);
  assert.equal((await db.query("SELECT to_regclass('public.employee_payments') AS name")).rows[0].name,null);
  assert.equal((await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='employee_id'")).rows.length,0);
  assert.deepEqual(await migrateEmployeeEcosystem(adapter(db),{log(){}}),employeeMigrationNames);
});
