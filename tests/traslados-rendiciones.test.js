import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import jwt from "jsonwebtoken";
import { createTrasladosDb } from "./helpers/trasladosDb.js";

process.env.NODE_ENV="test";
process.env.DATABASE_URL||="postgresql://localhost:5432/unused";
process.env.JWT_SECRET||="test-secret";
const { app }=await import("../src/index.js");
const { pool }=await import("../src/db.js");
const uid=()=>crypto.randomUUID(),base="/v2/traslados/rendiciones",q={from:"2026-10-01",to:"2026-10-15"},date="2026-10-10";

test("rendiciones: fuentes únicas, saldos por persona y movimientos auditables",async(t)=>{
  const db=await createTrasladosDb({realAuth:true}),old={query:pool.query,connect:pool.connect};pool.query=db.query;pool.connect=db.connect;
  const A=uid(),B=uid(),jorge=uid(),cesar=uid(),socio=uid(),foreign=uid(),pm=uid(),bankPM=uid(),foreignPM=uid(),cfg=uid(),vehicle=uid();
  await db.query("INSERT INTO tenants(id) VALUES($1),($2)",[A,B]);
  await db.query("INSERT INTO employees(id,tenant_id,name,is_driver) VALUES($1,$2,'Jorge',true),($3,$2,'César',true),($4,$2,'Socio',false),($5,$6,'Ajeno',true)",[jorge,A,cesar,socio,foreign,B]);
  await db.query("INSERT INTO vehiculos(id,tenant_id,nombre,patente) VALUES($1,$2,'Móvil','AA')",[vehicle,A]);
  await db.query("INSERT INTO payment_methods(id,tenant_id,name) VALUES($1,$2,'Efectivo'),($3,$4,'Ajeno')",[pm,A,foreignPM,B]);
  await db.query("INSERT INTO payment_methods(id,tenant_id,name) VALUES($1,$2,'Transferencia')",[bankPM,A]);
  await db.query("INSERT INTO traslado_configuracion(id,tenant_id,version,modelo_pago,valor_pago) VALUES($1,$2,1,'porcentaje',25)",[cfg,A]);
  const tokens={},users={};
  for(const [key,role,tenant,driver]of[["admin","admin",A,null],["staff","staff",A,null],["driver","staff",A,jorge],["other","admin",B,null]]){
    const id=uid();users[key]=id;await db.query("INSERT INTO users(id,tenant_id,role,chofer_id) VALUES($1,$2,$3,$4)",[id,tenant,role,driver]);tokens[key]=jwt.sign({sub:id,role,tenant_id:tenant},process.env.JWT_SECRET);
  }
  const server=app.listen(0);await once(server,"listening");
  t.after(async()=>{await new Promise(r=>server.close(r));Object.assign(pool,old);await db.close();});
  async function request(path="",method="GET",body,key="admin",absolute=false){const r=await fetch(`http://127.0.0.1:${server.address().port}${absolute?path:base+path}`,{method,headers:{"Content-Type":"application/json",...(tokens[key]?{Authorization:`Bearer ${tokens[key]}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,body:await r.json()};}
  const review=(key="admin",range=q)=>request(`/revision?${new URLSearchParams(range)}`,"GET",undefined,key);
  const confirm=async(persona,id=uid(),revision)=>{const r=revision||(await review()).body.revision;return request("","POST",{id,persona_id:persona,...q,revision:r,confirmar:true});};
  async function receipt(amount=10000,config=cfg,when=date){
    const turn=uid(),sid=uid(),id=uid();await db.query("INSERT INTO agenda_turnos(id,tenant_id,date,time,pet_name,status,traslado,traslado_amount) VALUES($1,$2,$3,'10:00','Luna','finished',true,$4)",[turn,A,when,amount]);
    await db.query("INSERT INTO traslado_solicitudes(id,tenant_id,turno_id,precio_total,configuracion_id) VALUES($1,$2,$3,$4,$5)",[sid,A,turn,amount,config]);
    for(const tipo of ["busqueda","entrega"])await db.query("INSERT INTO traslados(tenant_id,solicitud_id,tipo,chofer_id,vehiculo_id,fecha_programada,estado) VALUES($1,$2,$3,$4,$5,$6,'entregado')",[A,sid,tipo,jorge,vehicle,when]);
    await db.query("INSERT INTO traslado_cobros(id,tenant_id,solicitud_id,monto,fecha,cobrado_por,chofer_id,payment_method_id,registrado_por) VALUES($1,$2,$3,$4,$5,'chofer',$6,$7,$8)",[id,A,sid,amount,when,jorge,pm,users.admin]);return id;
  }
  const cobro=await receipt();const costs=[];
  for(const[concepto,monto,pagador]of[["Nafta",2000,"Jorge"],["Lavado",500,"César"],["Seguro",300,"Socio"]]){const id=uid();await db.query("INSERT INTO traslado_costos_externos(id,tenant_id,fecha,concepto,monto,pagado_por,registrado_por) VALUES($1,$2,$3,$4,$5,$6,$7)",[id,A,date,concepto,monto,pagador,users.admin]);costs.push(id);}
  const journal=uid();await db.query("INSERT INTO traslado_jornadas(id,tenant_id,fecha,chofer_id,monto,registrado_por) VALUES($1,$2,$3,$4,3000,$5)",[journal,A,date,cesar,users.admin]);
  let preview,jorgeStatement,cesarStatement,firstMovement,secondMovement;
  await t.test("revisión sin escrituras, sin asociar nombres automáticamente y permisos de todas las rutas",async()=>{
    preview=(await review()).body;assert.equal(preview.gastos.length,3);assert.ok(preview.gastos.every(g=>g.persona_id===null));assert.equal(preview.viajes[0].remuneracion,2500);assert.equal(preview.pendientes.length,4);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM traslado_reintegros")).rows[0].n,0);
    for(const key of ["staff","driver","missing"]){for(const[path,method]of[[`/revision?${new URLSearchParams(q)}`,"GET"],["","GET"],[`/${uid()}`,"GET"],["/caja?fecha="+date,"GET"],["","POST"],[`/gastos/${costs[0]}`,"PUT"],[`/repartos/${cobro}`,"PUT"],[`/${uid()}/movimientos`,"POST"],[`/${uid()}/reversiones`,"POST"],[`/${uid()}/anulacion`,"POST"]])assert.equal((await request(path,method,method==="GET"?undefined:{},key)).status,key==="missing"?401:403,`${key} ${method} ${path}`);}
    assert.deepEqual((await review("other")).body.gastos,[]);
    assert.equal((await request("/revision?from=2026-02-30&to=2026-02-30")).status,400);
    assert.equal((await review("admin",{from:"2026-10-01",to:"2099-12-31"})).status,400);
    assert.equal((await confirm(jorge)).status,409);
  });
  await t.test("reintegro por gasto y reparto explícito, validación de porcentajes y local",async()=>{
    const payout=preview.viajes[0];
    assert.equal((await request(`/repartos/${cobro}`,"PUT",{revision:payout.revision,items:[{persona_id:jorge,porcentaje:60}]})).status,400);
    assert.equal((await request(`/repartos/${cobro}`,"PUT",{revision:payout.revision,items:[{persona_id:foreign,porcentaje:100}]})).status,404);
    assert.equal((await request(`/repartos/${cobro}`,"PUT",{revision:payout.revision,items:[{persona_id:jorge,porcentaje:100}]},"other")).status,404);
    assert.equal((await request(`/repartos/${cobro}`,"PUT",{revision:payout.revision,items:[{persona_id:jorge,porcentaje:60},{persona_id:cesar,porcentaje:40}]})).status,200);
    assert.equal((await request(`/repartos/${cobro}`,"PUT",{revision:payout.revision,items:[{persona_id:jorge,porcentaje:100}]})).status,409);
    for(const[id,persona,reintegrable]of[[costs[0],jorge,true],[costs[1],cesar,false],[costs[2],socio,true]]){
      const p=(await review()).body.gastos.find(g=>g.id===id),body={persona_id:persona,reintegrable,revision:p.revision};
      assert.equal((await request(`/gastos/${id}`,"PUT",body,"other")).status,404);
      assert.equal((await request(`/gastos/${id}`,"PUT",{...body,persona_id:foreign})).status,404);
      assert.equal((await request(`/gastos/${id}`,"PUT",body)).status,200);
      assert.equal((await request(`/gastos/${id}`,"PUT",body)).status,409);
    }
    const p=(await review()).body;assert.deepEqual(p.pendientes,[]);
    assert.equal(p.personas.find(v=>v.id===jorge).saldo_por_confirmar,6500);
    assert.equal(p.personas.find(v=>v.id===cesar).saldo_por_confirmar,-4000);
    assert.equal(p.personas.find(v=>v.id===socio).saldo_por_confirmar,-300);
    assert.equal((await confirm(jorge,uid(),preview.revision)).status,409);
  });
  await t.test("confirmación atómica y reintento: una fuente no puede rendirse dos veces",async()=>{
    preview=(await review()).body;const id=uid(),body={id,persona_id:jorge,...q,revision:preview.revision,confirmar:true};
    const results=await Promise.all([request("","POST",body),request("","POST",body)]);assert.ok(results.every(r=>r.status===201),JSON.stringify(results));jorgeStatement=results[0].body;
    assert.equal(jorgeStatement.saldo_pendiente,6500);assert.equal(jorgeStatement.items.length,3);
    assert.equal((await request("","POST",{...body,persona_id:cesar})).status,409);
    assert.equal((await confirm(jorge)).status,409);
    assert.equal((await request(`/${id}`,"GET",undefined,"other")).status,404);
    const share=(await review()).body.viajes[0];assert.equal(share.congelado,true);
    assert.equal((await request(`/repartos/${cobro}`,"PUT",{revision:share.revision,items:[{persona_id:jorge,porcentaje:100}]})).status,409);
    const source=(await db.query("SELECT *,xmin::text AS revision FROM traslado_costos_externos WHERE id=$1",[costs[0]])).rows[0];
    assert.equal((await request(`/v2/traslados/resultados/costos-externos/${source.id}`,"PUT",{fecha:date,monto:2100,concepto:source.concepto,pagado_por:source.pagado_por,vehiculo_id:null,anulado:false,revision:source.revision},"admin",true)).status,409);
    assert.equal((await db.query("SELECT monto FROM traslado_costos_externos WHERE id=$1",[source.id])).rows[0].monto,"2000.00");
    const p=(await review()).body;assert.equal(p.personas.find(v=>v.id===jorge).saldo_confirmado_pendiente,6500);assert.equal(p.personas.find(v=>v.id===jorge).cantidad,0);
    const journalBefore=(await db.query("SELECT *,xmin::text AS revision FROM traslado_jornadas WHERE id=$1",[journal])).rows[0];
    cesarStatement=(await confirm(cesar)).body;assert.equal(cesarStatement.saldo_inicial,-4000);
    assert.equal((await request(`/v2/traslados/resultados/jornadas/${journal}`,"PUT",{fecha:date,chofer_id:cesar,monto:3000,vehiculo_id:null,anulado:true,revision:journalBefore.revision},"admin",true)).status,409);
    const nonReimbursed=cesarStatement.items.find(i=>i.tipo==="gasto");assert.equal(nonReimbursed.monto,"0.00");assert.equal(nonReimbursed.detalle.reintegrable,false);
    const detail=await request(`/${jorgeStatement.id}`);assert.equal(detail.status,200);
    assert.equal((await request(`?persona_id=${foreign}`)).status,404);
    assert.equal((await request("","GET",undefined,"other")).body.items.length,0);
  });
  await t.test("pagos parciales, sentido del saldo, reintentos y movimientos separados de ingresos",async()=>{
    const sysBefore=(await request(`/v2/daily-incomes/system-totals?date=${date}`,"GET",undefined,"admin",true)).body;
    const resultsBefore=(await request(`/v2/traslados/resultados?${new URLSearchParams(q)}`,"GET",undefined,"admin",true)).body.total;
    const id=jorgeStatement.id,body={id:uid(),tipo:"entrega_local",monto:2500,fecha:date,payment_method_id:pm,referencia:"Entrega parcial"};firstMovement=body.id;
    assert.equal((await request(`/${id}/movimientos`,"POST",body,"other")).status,404);
    assert.equal((await request(`/${id}/movimientos`,"POST",{...body,payment_method_id:foreignPM})).status,400);
    assert.equal((await request(`/${id}/movimientos`,"POST",{...body,tipo:"pago_persona"})).status,409);
    const a=await request(`/${id}/movimientos`,"POST",body);assert.equal(a.status,201);assert.equal(a.body.saldo_pendiente,4000);
    assert.equal((await request(`/${id}/movimientos`,"POST",body)).body.movimientos.length,1);
    assert.equal((await request(`/${id}/movimientos`,"POST",{...body,monto:2501})).status,409);
    const over={...body,id:uid(),monto:5000};assert.equal((await request(`/${id}/movimientos`,"POST",over)).status,409);
    const second={...body,id:uid(),monto:4000};secondMovement=second.id;
    const concurrent=await Promise.all([request(`/${id}/movimientos`,"POST",second),request(`/${id}/movimientos`,"POST",{...second,id:uid()})]);assert.deepEqual(concurrent.map(r=>r.status).sort(),[201,409]);
    assert.equal((await request(`/${id}`)).body.saldo_pendiente,0);
    const caja=(await request(`/caja?fecha=${date}`)).body;assert.equal(caja.entradas,6500);assert.equal(caja.salidas,0);
    assert.deepEqual((await request(`/v2/daily-incomes/system-totals?date=${date}`,"GET",undefined,"admin",true)).body,sysBefore);
    assert.deepEqual((await request(`/v2/traslados/resultados?${new URLSearchParams(q)}`,"GET",undefined,"admin",true)).body.total,resultsBefore);
    assert.deepEqual((await request(`/caja?fecha=${date}`,"GET",undefined,"other")).body.items,[]);
    assert.equal((await request(`/${id}/anulacion`,"POST",{motivo:"Corrección",confirmar:true})).status,409);
    const negative=await request(`/${cesarStatement.id}/movimientos`,"POST",{...body,id:uid(),tipo:"pago_persona",monto:1500});assert.equal(negative.status,201);assert.equal(negative.body.saldo_pendiente,-2500);
  });
  await t.test("reversiones conservan el original y la anulación libera fuentes sin borrar historia",async()=>{
    const id=jorgeStatement.id,input={id:uid(),movimiento_id:firstMovement,fecha:date,payment_method_id:bankPM,motivo:"Dinero devuelto para corregir la rendición",confirmar:true};
    assert.equal((await request(`/${id}/reversiones`,"POST",input,"other")).status,404);
    assert.equal((await request(`/${id}/reversiones`,"POST",{...input,payment_method_id:foreignPM})).status,400);
    assert.equal((await request(`/${id}/reversiones`,"POST",{...input,fecha:"2026-10-09"})).status,400);
    const a=await request(`/${id}/reversiones`,"POST",input);assert.equal(a.status,201);assert.equal(a.body.saldo_pendiente,2500);
    assert.equal(a.body.movimientos.find(m=>m.id===input.id).payment_method_id,bankPM);
    assert.equal((await request(`/${id}/reversiones`,"POST",input)).body.movimientos.length,3);
    assert.equal((await request(`/${id}/reversiones`,"POST",{...input,id:uid()})).status,409);
    assert.equal((await request(`/${id}/reversiones`,"POST",{...input,id:uid(),movimiento_id:input.id})).status,404);
    assert.equal((await request(`/${id}/reversiones`,"POST",{...input,id:uid(),movimiento_id:secondMovement})).status,201);
    const annul={motivo:"Revisión de comprobantes",confirmar:true};assert.equal((await request(`/${id}/anulacion`,"POST",annul)).status,200);
    const d=(await request(`/${id}`)).body;assert.equal(d.anulada,true);assert.equal(d.items.length,3);assert.equal(d.movimientos.length,4);assert.ok(d.items.every(i=>!i.vigente));
    assert.equal((await request(`/${id}/anulacion`,"POST",annul)).status,200);
    assert.equal((await request(`/${id}/anulacion`,"POST",{...annul,motivo:"Otro"})).status,409);
    assert.equal((await request(`/${id}/movimientos`,"POST",{id:uid(),tipo:"entrega_local",monto:1,fecha:date,payment_method_id:pm})).status,409);
    const again=await confirm(jorge);assert.equal(again.status,201);assert.equal(again.body.saldo_inicial,6500);assert.notEqual(again.body.id,id);
    const caja=(await request(`/caja?fecha=${date}`)).body;assert.equal(caja.entradas-caja.salidas,-1500);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM traslado_rendiciones WHERE id=$1",[id])).rows[0].n,1);
  });
  await t.test("un gasto editado invalida su reintegro y los centavos del porcentaje se conservan",async()=>{
    const c=await receipt(100.04);let p=(await review()).body;const trip=p.viajes.find(v=>v.cobro_id===c);
    assert.equal((await request(`/repartos/${c}`,"PUT",{revision:trip.revision,items:[{persona_id:jorge,porcentaje:50},{persona_id:cesar,porcentaje:50}]})).status,200);
    p=(await review()).body;const remuneration=p.items.filter(i=>i.tipo==="remuneracion"&&i.fuente_id===c);assert.equal(Math.round(remuneration.reduce((s,i)=>s+i.monto,0)*100),2501);
    const unclosed=costs[2];await db.query("UPDATE traslado_costos_externos SET monto=301 WHERE id=$1",[unclosed]);
    p=(await review()).body;assert.ok(p.pendientes.some(v=>v.id===unclosed));assert.equal(p.gastos.find(g=>g.id===unclosed).reintegrable,null);assert.equal((await confirm(socio)).status,409);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM traslado_cobros WHERE id=$1",[cobro])).rows[0].n,1);
  });
  await t.test("confirmar al cobrador también congela el reparto aunque su remuneración sea cero",async()=>{
    const range={from:"2026-09-01",to:"2026-09-30"},c=await receipt(10000,cfg,"2026-09-10");
    let p=(await review("admin",range)).body,trip=p.viajes.find(v=>v.cobro_id===c);
    assert.equal((await request(`/repartos/${c}`,"PUT",{revision:trip.revision,items:[{persona_id:cesar,porcentaje:100}]})).status,200);
    p=(await review("admin",range)).body;
    const closed=await request("","POST",{id:uid(),persona_id:jorge,...range,revision:p.revision,confirmar:true});assert.equal(closed.status,201);assert.equal(closed.body.remuneracion,0);
    p=(await review("admin",range)).body;trip=p.viajes.find(v=>v.cobro_id===c);assert.equal(trip.congelado,true);
    assert.equal((await request(`/repartos/${c}`,"PUT",{revision:trip.revision,items:[{persona_id:jorge,porcentaje:100}]})).status,409);
    assert.equal(p.personas.find(v=>v.id===jorge).saldo_confirmado_pendiente,16500);
    assert.equal(p.personas.find(v=>v.id===cesar).saldo_por_confirmar,-2500);
  });
  await t.test("Resultados y Rendiciones coinciden al redondear porcentajes grandes a centavos",async()=>{
    const config=uid(),range={from:"2026-08-01",to:"2026-08-31"};
    await db.query("INSERT INTO traslado_configuracion(id,tenant_id,version,modelo_pago,valor_pago) VALUES($1,$2,2,'porcentaje',70.93)",[config,A]);
    const c=await receipt(9999990000.43,config,"2026-08-10");let p=(await review("admin",range)).body;
    const trip=p.viajes.find(v=>v.cobro_id===c);assert.equal(trip.remuneracion,7092992907.30);
    assert.equal((await request(`/repartos/${c}`,"PUT",{revision:trip.revision,items:[{persona_id:socio,porcentaje:100}]})).status,200);
    p=(await review("admin",range)).body;assert.equal(p.personas.find(v=>v.id===socio).remuneracion,7092992907.30);
    const result=(await request(`/v2/traslados/resultados?${new URLSearchParams(range)}`,"GET",undefined,"admin",true)).body;
    assert.equal(result.total.pago_choferes,trip.remuneracion);
  });
});
