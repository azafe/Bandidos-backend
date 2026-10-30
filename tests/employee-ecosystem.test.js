import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { createTrasladosDb } from './helpers/trasladosDb.js';
process.env.NODE_ENV='test';
process.env.DATABASE_URL ||= 'postgresql://localhost:5432/unused';
process.env.JWT_SECRET ||= 'test-secret';
const {app}=await import('../src/index.js');
const {pool}=await import('../src/db.js');
const uid=()=>crypto.randomUUID();

test('cuentas personales, comisiones históricas, entregas y chat con PostgreSQL',async t=>{
  const db=await createTrasladosDb({realAuth:true}),original={query:pool.query,connect:pool.connect};
  pool.query=db.query;pool.connect=db.connect;
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(r=>server.close(r));Object.assign(pool,original);await db.close();});
  const migration=await readFile(new URL('../db/migrations/036_chat_equipo.sql',import.meta.url),'utf8');
  await db.db.exec(migration);await db.db.exec(migration);
  await db.db.exec(await readFile(new URL('../db/migrations/035_cuentas_personales.sql',import.meta.url),'utf8'));
  const A=uid(),B=uid();await db.query('INSERT INTO tenants(id) VALUES($1),($2)',[A,B]);
  const employees=[uid(),uid(),uid(),uid(),uid()];
  for(const [i,id] of employees.entries()) await db.query(`INSERT INTO employees(id,tenant_id,name,role,status,payroll_start_date,opening_balance)
    VALUES($1,$2,$3,'Groomer',$4,'2026-09-01',$5)`,[id,i===3?B:A,['Ana','Bea','Carla','Ajena','Inactiva'][i],i===4?'inactive':'active',i===0?500:0]);
  const users={};
  for(const [key,role,tenant] of [['admin','admin',A],['staff','staff',A],['other','admin',B]]){
    const id=uid();await db.query('INSERT INTO users(id,tenant_id,role,email) VALUES($1,$2,$3,$4)',[id,tenant,role,`${key}@test.com`]);
    users[key]={id,token:jwt.sign({sub:id,role,tenant_id:tenant},process.env.JWT_SECRET)};
  }
  async function req(path,method='GET',body,key='admin'){
    const r=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{'Content-Type':'application/json',...(users[key]?{Authorization:`Bearer ${users[key].token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  }
  const q='?from=2026-10-01&to=2026-10-31';
  const statement=(id=employees[0],key='admin')=>req(`/v2/employees/${id}/statement${q}`,'GET',undefined,key);
  let shared,work;
  await t.test('alta individual, cuenta única y validación de local y estado',async()=>{
    for(const [i,key] of ['ana','bea','carla'].entries()){
      const r=await req('/v2/users','POST',{email:`${key}@test.com`,password:'Prueba12345',role:'staff',employee_id:employees[i]});
      assert.equal(r.status,201,JSON.stringify(r.body));
      const login=await req('/auth/login','POST',{email:`${key}@test.com`,password:'Prueba12345'},'none');assert.equal(login.status,200);
      assert.equal(login.body.user.employee_id,employees[i]);users[key]={id:r.body.id,token:login.body.token};
    }
    for(const employee_id of [employees[0],employees[3],employees[4]]){
      const r=await req('/v2/users','POST',{email:`${uid()}@test.com`,password:'Prueba12345',role:'staff',employee_id});
      assert.ok([400,409].includes(r.status),JSON.stringify(r));
    }
    assert.equal((await req('/v2/users','POST',{email:'bad@test.com',password:'Prueba12345',role:'admin',employee_id:employees[1]})).status,400);
    assert.equal((await req(`/v2/users/${users.ana.id}`,'PUT',{role:'admin'})).status,409);
    const me=await req('/me','GET',undefined,'ana');assert.equal(me.body.employee_active,true);assert.equal(me.body.employee_name,'Ana');
  });
  await t.test('fuente única, redondeo compartido y porcentaje congelado',async()=>{
    const before=await req('/agenda','POST',{date:'2026-09-15',time:'10:00',pet_name:'Luna',owner_name:'Dueña',groomer_id:employees[0],price:10000,status:'finished'});
    assert.equal(before.status,201,JSON.stringify(before.body));
    const r=await req('/agenda','POST',{date:'2026-10-16',time:'10:00',pet_name:'Toby',owner_name:'Dueña',groomer_id:employees[0],second_groomer_id:employees[1],third_groomer_id:employees[2],price:10000.01,status:'finished'});
    assert.equal(r.status,201,JSON.stringify(r.body));shared=r.body.id;
    assert.equal(Number(r.body.commission_rate_snapshot),0.4);assert.equal(r.body.second_groomer_id,employees[1]);
    const amounts=[];
    for(const id of employees.slice(0,3)){const s=await statement(id);assert.equal(s.status,200,JSON.stringify(s.body));assert.equal(s.body.works.length,1);amounts.push(Number(s.body.works[0].earned));}
    assert.deepEqual(amounts,[1333.34,1333.33,1333.33]);assert.equal(amounts.reduce((s,v)=>s+Math.round(v*100),0),400000);
    await db.query('UPDATE employees SET commission_rate=0.9 WHERE id=$1',[employees[0]]);
    assert.equal(Number((await statement()).body.works[0].earned),1333.34);
    const edit=await req(`/agenda/${shared}`,'PUT',{notes:'Corregido'});assert.equal(edit.status,200);assert.equal(Number(edit.body.commission_rate_snapshot),0.4);
    const next=await req('/agenda','POST',{date:'2026-10-17',time:'11:00',pet_name:'Lola',owner_name:'Dueña',groomer_id:employees[0],price:1000,status:'finished'});
    assert.equal(next.status,201);work=next.body.id;assert.equal(Number(next.body.commission_rate_snapshot),0.9);
    assert.equal((await statement()).body.summary.earned,2233.34);
    const bad=await req(`/agenda/${work}`,'PUT',{second_groomer_id:employees[3]});assert.equal(bad.status,400);
    assert.equal((await req(`/agenda/${work}`,'PUT',{second_groomer_id:employees[0]})).status,400);
  });
  let advance;
  await t.test('saldo acumulado, anticipo idempotente, pago y anulación auditable',async()=>{
    const previous=await req(`/v2/employees/${employees[0]}/payments`,'POST',{id:uid(),kind:'pago',date:'2026-09-30',amount:1000,method:'efectivo'});assert.equal(previous.status,201,JSON.stringify(previous.body));
    advance={id:uid(),kind:'anticipo',date:'2026-10-16',amount:200,method:'transferencia',notes:'Adelanto'};
    const path=`/v2/employees/${employees[0]}/payments`;
    assert.equal((await req(path,'POST',advance)).status,201);
    assert.equal((await req(path,'POST',advance)).status,201);
    assert.equal((await req(path,'POST',{...advance,amount:300})).status,409);
    assert.equal((await req(path,'POST',{...advance,id:uid(),date:'2026-02-30'})).status,400);
    assert.equal((await req(path,'POST',{...advance,id:uid(),date:'2099-01-01'})).status,400);
    const s=(await statement()).body;assert.equal(s.summary.opening,3500);assert.equal(s.summary.advances,200);assert.equal(s.summary.advance_count,1);assert.equal(s.summary.balance,5533.34);
    const own=(await req(`/v2/me/employee${q}`,'GET',undefined,'ana')).body;assert.deepEqual(own,s);
    assert.equal((await req(`/v2/employees/${employees[0]}/payroll-config`,'PUT',{payroll_start_date:'2026-10-01',opening_balance:0})).status,409);
    assert.equal((await req(`${path}/${advance.id}/void`,'POST',{reason:'Transferencia no realizada'})).status,200);
    const after=(await statement()).body;assert.equal(after.summary.balance,5733.34);assert.equal(after.summary.advances,0);assert.ok(after.payments[0].voided_at);assert.equal(after.payments[0].void_reason,'Transferencia no realizada');
    assert.equal((await req(`${path}/${advance.id}/void`,'POST',{reason:'Otra vez'})).status,409);
  });
  await t.test('los permisos no se amplían cambiando un ID en el navegador',async()=>{
    for(const path of ['/v2/employees','/agenda','/v2/users',`/v2/employees/${employees[1]}/statement${q}`,'/v2/daily-expenses']) assert.equal((await req(path,'GET',undefined,'ana')).status,403,path);
    assert.equal((await req(`/v2/me/employee${q}&employee_id=${employees[1]}`,'GET',undefined,'ana')).status,400);
    assert.equal((await statement(employees[0],'other')).status,404);
    assert.equal((await statement(employees[0],'staff')).status,403);
    assert.equal((await req(`/v2/employees/${employees[0]}/payments`,'POST',advance,'ana')).status,403);
    assert.equal((await req(`/v2/me/employee${q}`,'GET',undefined,'none')).status,401);
  });
  let direct,group,message,photoMessage;
  await t.test('chat privado único e idempotente y aislamiento entre participantes/locales',async()=>{
    const create={id:uid(),kind:'directa',members:[users.bea.id]};
    const r=await req('/v2/chat','POST',create,'ana');assert.equal(r.status,201,JSON.stringify(r.body));direct=r.body.id;
    assert.equal((await req('/v2/chat','POST',create,'ana')).body.id,direct);
    assert.equal((await req('/v2/chat','POST',{id:uid(),kind:'directa',members:[users.ana.id]},'bea')).body.id,direct);
    assert.equal((await req('/v2/chat','POST',{id:uid(),kind:'directa',members:[users.other.id]},'ana')).status,400);
    for(const key of ['carla','other','admin']) for(const suffix of ['', '/messages']) assert.equal((await req(`/v2/chat/${direct}${suffix}`,'GET',undefined,key)).status,404);
    message={id:uid(),text:'Coordinamos el turno de Luna'};
    const sent=await req(`/v2/chat/${direct}/messages`,'POST',message,'ana');assert.equal(sent.status,201,JSON.stringify(sent.body));
    assert.equal((await req(`/v2/chat/${direct}/messages`,'POST',message,'ana')).body.seq,sent.body.seq);
    assert.equal((await req(`/v2/chat/${direct}/messages`,'POST',{...message,text:'Otro'},'ana')).status,409);
    assert.equal((await req('/v2/chat','GET',undefined,'bea')).body[0].unread,1);
    assert.equal((await req(`/v2/chat/${direct}/read`,'POST',{through:sent.body.seq},'bea')).status,200);
    assert.equal((await req('/v2/chat','GET',undefined,'bea')).body[0].unread,0);
    assert.equal((await req(`/v2/chat/${direct}/messages/${message.id}/reaction`,'PUT',{emoji:'👍'},'bea')).status,200);
    let messages=(await req(`/v2/chat/${direct}/messages`,'GET',undefined,'ana')).body.messages;assert.equal(messages[0].reactions[0].emoji,'👍');
    assert.equal((await req(`/v2/chat/${direct}/messages/${message.id}`,'PATCH',{text:'Turno confirmado'},'bea')).status,403);
    assert.equal((await req(`/v2/chat/${direct}/messages/${message.id}`,'PATCH',{text:'Turno confirmado'},'ana')).status,200);
    assert.equal((await req(`/v2/chat/${direct}/messages?search=confirmado`,'GET',undefined,'bea')).body.messages.length,1);
  });
  await t.test('fotos privadas, eliminación, caducidad y validación del formato',async()=>{
    const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=';
    photoMessage=uid();
    const sent=await req(`/v2/chat/${direct}/messages`,'POST',{id:photoMessage,photo:{type:'image/png',data:png}},'ana');assert.equal(sent.status,201,JSON.stringify(sent.body));
    const path=`/v2/chat/${direct}/messages/${photoMessage}/photo`;
    assert.equal((await req(path,'GET',undefined,'bea')).body.url,`data:image/png;base64,${png}`);
    assert.equal((await req(path,'GET',undefined,'carla')).status,404);
    assert.equal((await req(`/v2/chat/${direct}/messages`,'POST',{id:uid(),photo:{type:'image/jpeg',data:png}},'ana')).status,400);
    await db.query("UPDATE team_chat_messages SET created_at=now()-interval '181 days' WHERE id=$1",[photoMessage]);
    assert.equal((await req(path,'GET',undefined,'ana')).status,404);
    assert.equal((await req(`/v2/chat/${direct}/messages/${message.id}`,'DELETE',undefined,'ana')).status,200);
    const deleted=(await req(`/v2/chat/${direct}/messages`,'GET',undefined,'bea')).body.messages.find(m=>m.id===message.id);
    assert.ok(deleted.deleted_at);assert.equal(deleted.text,null);assert.deepEqual(deleted.reactions,[]);
  });
  await t.test('grupos: el nuevo participante no ve mensajes de antes de ingresar',async()=>{
    const made=await req('/v2/chat','POST',{id:uid(),kind:'grupo',name:'Peluquería',members:[users.bea.id]},'ana');assert.equal(made.status,201);group=made.body.id;
    const old=await req(`/v2/chat/${group}/messages`,'POST',{id:uid(),text:'Antes del ingreso'},'ana');assert.equal(old.status,201);
    assert.equal((await req(`/v2/chat/${group}/members`,'PUT',{members:[users.ana.id,users.bea.id,users.carla.id]},'bea')).status,403);
    assert.equal((await req(`/v2/chat/${group}/members`,'PUT',{members:[users.ana.id,users.bea.id,users.carla.id]},'ana')).status,200);
    assert.deepEqual((await req(`/v2/chat/${group}/messages`,'GET',undefined,'carla')).body.messages,[]);
    assert.equal((await req(`/v2/chat/${group}/read`,'POST',{through:old.body.seq},'carla')).status,400);
    assert.equal((await req(`/v2/chat/${group}/messages`,'POST',{id:uid(),text:'Bienvenida'},'bea')).status,201);
    assert.equal((await req(`/v2/chat/${group}/messages`,'GET',undefined,'carla')).body.messages.length,1);
    assert.equal((await req(`/v2/chat/${group}/members`,'PUT',{members:[users.ana.id,users.carla.id]},'ana')).status,200);
    assert.equal((await req(`/v2/chat/${group}/messages`,'GET',undefined,'bea')).status,404);
    assert.equal((await req(`/v2/chat/${group}/messages`,'POST',{id:uid(),text:'No permitido'},'bea')).status,404);
  });
  await t.test('paginación estable, lectura monotónica y favoritos/silencio por cuenta',async()=>{
    for(let i=0;i<55;i++)await db.query("INSERT INTO team_chat_messages(id,tenant_id,chat_id,author_id,text) VALUES($1,$2,$3,$4,$5)",[uid(),A,direct,users.ana.id,`Mensaje ${i}`]);
    const latest=(await req(`/v2/chat/${direct}/messages`,'GET',undefined,'bea')).body;assert.equal(latest.messages.length,50);assert.equal(latest.has_more,true);
    const older=(await req(`/v2/chat/${direct}/messages?before=${latest.before}`,'GET',undefined,'bea')).body;
    assert.equal(new Set([...older.messages,...latest.messages].map(m=>m.id)).size,57);
    const last=latest.messages.at(-1).seq;
    await req(`/v2/chat/${direct}/read`,'POST',{through:last},'bea');await req(`/v2/chat/${direct}/read`,'POST',{through:older.messages[0].seq},'bea');
    assert.equal((await req(`/v2/chat/${direct}`,'GET',undefined,'bea')).body.read_seq,last);
    assert.equal((await req(`/v2/chat/${direct}/preferences`,'PATCH',{favorite:true,muted:true},'bea')).status,200);
    assert.equal((await req('/v2/chat','GET',undefined,'bea')).body.find(c=>c.id===direct).favorite,true);
    assert.equal((await req('/v2/chat','GET',undefined,'ana')).body.find(c=>c.id===direct).favorite,false);
  });
  await t.test('historia conservada, backfill identificado y RLS sin acceso directo',async()=>{
    // Un trabajo del pasado que nunca guardó su porcentaje se marca estimado.
    const historical=uid();
    await db.query("INSERT INTO agenda_turnos(id,tenant_id,date,time,pet_name,groomer_id,price,status) VALUES($1,$2,'2026-08-01','10:00','Histórico',$3,1000,'finished')",[historical,A,employees[1]]);
    await db.db.exec('ALTER TABLE agenda_turnos DISABLE TRIGGER agenda_commission_snapshot');
    await db.query('UPDATE agenda_turnos SET commission_rate_snapshot=NULL WHERE id=$1',[historical]);
    await db.db.exec('ALTER TABLE agenda_turnos ENABLE TRIGGER agenda_commission_snapshot');
    await db.db.exec(await readFile(new URL('../db/migrations/035_cuentas_personales.sql',import.meta.url),'utf8'));
    const old=await req(`/v2/employees/${employees[1]}/statement?from=2026-08-01&to=2026-08-31`);
    assert.equal(old.status,200);assert.equal(old.body.works[0].commission_historical_estimate,true);assert.equal(old.body.summary.earned,0);
    await assert.rejects(db.query('DELETE FROM employees WHERE id=$1',[employees[1]]),e=>e.code==='23503');
    const list=await req('/v2/employees','GET',undefined,'staff');
    assert.equal(list.status,200);assert.equal(Object.hasOwn(list.body[0],'opening_balance'),false);
    await db.db.exec('CREATE ROLE portal_browser NOLOGIN; GRANT SELECT ON team_chat_messages,employee_payments TO portal_browser; SET ROLE portal_browser;');
    try {
      assert.equal((await db.query('SELECT id FROM team_chat_messages')).rows.length,0);
      assert.equal((await db.query('SELECT id FROM employee_payments')).rows.length,0);
    } finally { await db.db.exec('RESET ROLE'); }
  });
  await t.test('baja efectiva con el token anterior y cambio de vínculo sin esperar su vencimiento',async()=>{
    await db.query("UPDATE employees SET status='inactive' WHERE id=$1",[employees[1]]);
    assert.equal((await req('/me','GET',undefined,'bea')).body.employee_active,false);
    assert.equal((await req('/v2/chat','GET',undefined,'bea')).status,403);
    assert.equal((await req('/v2/chat/people','GET',undefined,'ana')).body.some(p=>p.id===users.bea.id),false);
    await req(`/v2/users/${users.carla.id}/employee`,'PUT',{employee_id:null});
    const me=await req('/me','GET',undefined,'carla');assert.equal(me.body.employee_id,null);
    await db.query('UPDATE employees SET is_driver=true WHERE id=$1',[employees[2]]);
    assert.equal((await req(`/v2/users/${users.carla.id}/employee`,'PUT',{employee_id:employees[2]})).status,200);
    assert.equal((await req('/me','GET',undefined,'carla')).body.chofer_id,employees[2]);
    assert.equal((await req('/agenda','GET',undefined,'carla')).status,403);
    assert.equal((await req('/v2/traslados/hoja-de-ruta?fecha=2026-10-16','GET',undefined,'carla')).status,200);
  });
});
