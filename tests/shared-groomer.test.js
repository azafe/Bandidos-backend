import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createTrasladosDb } from './helpers/trasladosDb.js';
import { signTokenFor } from './helpers/authRevalidation.js';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgresql://localhost/postgres';
process.env.JWT_SECRET ||= 'test-secret';
const { app } = await import('../src/index.js');
const { pool } = await import('../src/db.js');

test('shared grooming: persistence, validation, tenant isolation, reports and single billing', async (t) => {
  const db = await createTrasladosDb();
  t.after(async () => { await db.close(); });
  try {
  await db.db.exec(`ALTER TABLE services ADD COLUMN id uuid DEFAULT gen_random_uuid(), ADD COLUMN pet_id uuid, ADD COLUMN customer_id uuid, ADD COLUMN service_type_id uuid, ADD COLUMN groomer_id uuid, ADD COLUMN notes text, ADD COLUMN created_at timestamptz DEFAULT now();`);
  await db.db.exec(await readFile(new URL('../db/migrations/033_shared_groomer.sql', import.meta.url), 'utf8'));
  await db.db.exec(await readFile(new URL('../db/migrations/034_third_groomer.sql', import.meta.url), 'utf8'));
  await db.db.exec(await readFile(new URL('../db/migrations/034_third_groomer.sql', import.meta.url), 'utf8'));
  const [tenant, other, primary, second, outsider, driver, turno, pet, customer, type, payment] = Array.from({length:11}, () => randomUUID());
  await db.query('INSERT INTO tenants(id) VALUES($1),($2)', [tenant,other]);
  for (const [id, tenantId, isDriver] of [[primary,tenant,false],[second,tenant,false],[outsider,other,false],[driver,tenant,true]]) {
    await db.query('INSERT INTO employees(id,tenant_id,name,is_driver) VALUES($1,$2,$3,$4)',[id,tenantId,id,isDriver]);
  }
  await db.query("INSERT INTO agenda_turnos(id,tenant_id,date,time,pet_name,groomer_id) VALUES($1,$2,'2026-10-28','10:00','Luna',$3)",[turno,tenant,primary]);
  const originalQuery=pool.query, originalConnect=pool.connect;
  pool.query=(...args)=>db.query(...args);
  pool.connect=(...args)=>db.connect(...args);
  const server=app.listen(0); await once(server,'listening');
  t.after(async()=>{pool.query=originalQuery;pool.connect=originalConnect; await new Promise(resolve=>server.close(resolve)); });
  const token=signTokenFor({role:'admin',tenant_id:tenant}).token;
  async function request(path, method='GET', body) {
    const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
    return {status:response.status,body:await response.json()};
  }
  for (const invalid of [primary, outsider, driver]) {
    const result=await request(`/agenda/${turno}`,'PUT',{status:'finished',second_groomer_id:invalid});
    assert.equal(result.status,400,JSON.stringify(result));
  }
  let result=await request(`/agenda/${turno}`,'PUT',{status:'finished',groomer_id:primary,second_groomer_id:second,price:20000});
  assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(result.body.second_groomer_id,second);
  // Agenda list survives reload and contains both participants.
  const list=await request('/agenda?from=2026-10-28&to=2026-10-28');
  assert.equal(list.body.find(row=>row.id===turno).second_groomer_id,second);
  const service={date:'2026-10-28',pet_id:pet,customer_id:customer,service_type_id:type,payment_method_id:payment,groomer_id:primary,second_groomer_id:second,price:20000};
  result=await request('/v2/services','POST',service);
  assert.equal(result.status,201,JSON.stringify(result));
  assert.equal(result.body.second_groomer_id,second);
  const count=await db.query('SELECT COUNT(*)::int AS count, SUM(price) AS total FROM services');
  assert.equal(count.rows[0].count,1); assert.equal(Number(count.rows[0].total),20000);
  result=await request('/reports/by-groomer');
  assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(result.body.length,2);
  assert.deepEqual(result.body.map(row=>Number(row.total)),[10000,10000]);
  assert.equal(result.body.reduce((sum,row)=>sum+Number(row.services_count),0),1);
  result=await request(`/v2/services?groomer_id=${second}`);
  assert.equal(result.body.length,1);
  for (const invalid of [primary,outsider,driver]) {
    result=await request('/v2/services','POST',{...service,second_groomer_id:invalid});
    assert.equal(result.status,400,JSON.stringify(result));
  }
  const third = randomUUID();
  await db.query('INSERT INTO employees(id,tenant_id,name,is_driver) VALUES($1,$2,$3,false)', [third,tenant,'Third']);
  for (const invalid of [primary,second,outsider,driver]) {
    result = await request(`/agenda/${turno}`, 'PUT', {third_groomer_id:invalid});
    assert.equal(result.status,400,JSON.stringify(result));
    result = await request('/v2/services','POST',{...service,third_groomer_id:invalid});
    assert.equal(result.status,400,JSON.stringify(result));
  }
  result = await request(`/agenda/${turno}`, 'PUT', {third_groomer_id:third,price:30000});
  assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(result.body.third_groomer_id,third);
  const reloaded = await request('/agenda?from=2026-10-28&to=2026-10-28');
  assert.equal(reloaded.body.find(row=>row.id===turno).third_groomer_id,third);
  result = await request(`/agenda/${turno}`, 'PUT', {second_groomer_id:null});
  assert.equal(result.status,400);
  for (const path of ['/services','/v2/services']) {
    result = await request(path,'POST',{...service,price:30000,third_groomer_id:third});
    assert.equal(result.status,201,JSON.stringify(result));
    assert.equal(result.body.third_groomer_id,third);
    result = await request(`${path}?groomer_id=${third}`);
    assert.equal(result.body.length, path === '/services' ? 1 : 2);
  }
  result = await request('/reports/by-groomer');
  assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(result.body.length,3);
  assert.equal(result.body.reduce((sum,row)=>sum+Number(row.total),0),80000);
  const thirdReport = result.body.find(row=>row.groomer_id===third);
  assert.equal(Number(thirdReport.total),20000);
  result = await request(`/agenda/${turno}`, 'PUT', {third_groomer_id:null});
  assert.equal(result.status,200);
  result=await request(`/agenda/${turno}`,'PUT',{second_groomer_id:null});
  assert.equal(result.status,200); assert.equal(result.body.second_groomer_id,null);
  // Legacy single-groomer completion still works.
  result=await request(`/agenda/${turno}`,'PUT',{status:'finished',groomer_id:primary});
  assert.equal(result.status,200);
  } catch (error) { console.error(error); throw error; }
});
