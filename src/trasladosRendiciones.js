import crypto from "node:crypto";
import { z } from "zod";
import { TrasladoError, sendTrasladoError, transaction } from "./traslados.js";
import { porcentajeCentavos } from "./trasladosDinero.js";

const uuid = z.string().uuid();
const date = z.string().date();
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const money = z.number().finite().min(0).max(9999999999.99).refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 0.0001);
const reason = z.string().trim().min(1).max(1000);
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const rangeSchema = z.object({ from: date, to: date }).strict().refine((q) => q.from <= q.to && Date.parse(q.to) - Date.parse(q.from) <= 366 * 86400000 && q.to <= today());
const hash = (v) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
const cent = (v) => Math.round(Number(v || 0) * 100);
const pesos = (v) => v / 100;
const fail = (status, message) => { throw new TrasladoError(status, message); };
const parse = (schema, value) => {
  const p = schema.safeParse(value);
  if (!p.success) fail(400, "Revisá los datos. Elegí fechas hasta hoy y un período de hasta un año.");
  return p.data;
};
function split(amount, items) {
  const rows = items.map((i) => { const n = BigInt(amount) * BigInt(Math.round(Number(i.porcentaje) * 100)); return { ...i, centavos: Number(n / 10000n), resto: Number(n % 10000n) }; });
  let rest = amount - rows.reduce((s, r) => s + r.centavos, 0);
  for (const r of [...rows].sort((a, b) => b.resto - a.resto || a.persona_id.localeCompare(b.persona_id))) if (rest-- > 0) r.centavos++;
  return rows;
}
async function person(db, tenant, id) {
  const r = await db.query("SELECT id,name,status,is_driver FROM employees WHERE tenant_id=$1 AND id=$2", [tenant, id]);
  if (!r.rows.length) fail(404, "Persona no encontrada en este local.");
  return r.rows[0];
}
export async function assertRendicionSourceEditable(db, tenant, kind, id) {
  const r = await db.query("SELECT id FROM traslado_rendicion_items WHERE tenant_id=$1 AND tipo=$2 AND fuente_id=$3 AND vigente LIMIT 1", [tenant, kind, id]);
  if (r.rows.length) fail(409, "Este registro pertenece a una rendición confirmada. Revertí sus movimientos y anulá la rendición antes de corregirlo.");
}
async function receiptSources(db, tenant, from, to) {
  return (await db.query(`SELECT c.id,c.solicitud_id,c.fecha::text,c.monto,c.cobrado_por,c.chofer_id,a.pet_name,
    cfg.id AS configuracion_id,cfg.modelo_pago,cfg.valor_pago
    FROM traslado_cobros c JOIN traslado_solicitudes s ON s.tenant_id=c.tenant_id AND s.id=c.solicitud_id
    JOIN agenda_turnos a ON a.tenant_id=s.tenant_id AND a.id=s.turno_id
    LEFT JOIN traslado_condiciones_revisadas cr ON cr.tenant_id=s.tenant_id AND cr.solicitud_id=s.id
    LEFT JOIN traslado_configuracion cfg ON cfg.tenant_id=s.tenant_id AND cfg.id=COALESCE(cr.configuracion_id,s.configuracion_id)
    WHERE c.tenant_id=$1 AND c.fecha BETWEEN $2 AND $3 ORDER BY c.id`, [tenant, from, to])).rows;
}
const receiptBase = (c) => hash([c.id,c.solicitud_id,c.monto,c.configuracion_id,c.modelo_pago,c.valor_pago]);
const costBase = (c) => hash([c.id,c.fecha,c.monto,c.pagado_por,c.concepto,c.anulado]);

async function preview(db, tenant, q) {
  const [receipts, costs, decisions, payments, shares, journals, used, people, missingJournals, balances] = await Promise.all([
    receiptSources(db, tenant, q.from, q.to),
    db.query("SELECT *,fecha::text FROM traslado_costos_externos WHERE tenant_id=$1 AND fecha BETWEEN $2 AND $3 AND NOT anulado ORDER BY id", [tenant, q.from, q.to]),
    db.query("SELECT *,xmin::text AS revision FROM traslado_reintegros WHERE tenant_id=$1 ORDER BY costo_id", [tenant]),
    db.query("SELECT *,xmin::text AS revision FROM traslado_remuneracion_repartos WHERE tenant_id=$1 ORDER BY cobro_id", [tenant]),
    db.query("SELECT * FROM traslado_remuneracion_items WHERE tenant_id=$1 ORDER BY reparto_id,persona_id", [tenant]),
    db.query("SELECT *,fecha::text FROM traslado_jornadas WHERE tenant_id=$1 AND fecha BETWEEN $2 AND $3 AND NOT anulado ORDER BY id", [tenant, q.from, q.to]),
    db.query("SELECT tipo,fuente_id,persona_id,cobro_id,costo_id,jornada_id FROM traslado_rendicion_items WHERE tenant_id=$1 AND vigente ORDER BY tipo,fuente_id,persona_id", [tenant]),
    db.query("SELECT id,name,status,is_driver FROM employees WHERE tenant_id=$1 ORDER BY name,id", [tenant]),
    db.query(`SELECT DISTINCT t.chofer_id,t.fecha_programada::text AS fecha FROM traslados t
      JOIN traslado_solicitudes s ON s.tenant_id=t.tenant_id AND s.id=t.solicitud_id
      LEFT JOIN traslado_condiciones_revisadas cr ON cr.tenant_id=s.tenant_id AND cr.solicitud_id=s.id
      JOIN traslado_configuracion cfg ON cfg.tenant_id=s.tenant_id AND cfg.id=COALESCE(cr.configuracion_id,s.configuracion_id)
      WHERE t.tenant_id=$1 AND t.fecha_programada BETWEEN $2 AND $3 AND t.estado='entregado' AND cfg.modelo_pago='jornal'
      AND NOT EXISTS(SELECT 1 FROM traslado_jornadas j WHERE j.tenant_id=t.tenant_id AND j.chofer_id=t.chofer_id AND j.fecha=t.fecha_programada AND NOT j.anulado)
      ORDER BY fecha,t.chofer_id`, [tenant, q.from, q.to]),
    db.query(`SELECT r.persona_id, SUM(r.saldo_inicial-COALESCE(m.efecto,0)) AS saldo
      FROM traslado_rendiciones r LEFT JOIN (
        SELECT tenant_id,rendicion_id,SUM(monto*(CASE WHEN tipo='entrega_local' THEN 1 ELSE -1 END)*(CASE WHEN reversion_de IS NULL THEN 1 ELSE -1 END)) AS efecto
        FROM traslado_rendicion_movimientos WHERE tenant_id=$1 GROUP BY tenant_id,rendicion_id
      ) m ON m.tenant_id=r.tenant_id AND m.rendicion_id=r.id WHERE r.tenant_id=$1 AND NOT r.anulada GROUP BY r.persona_id`, [tenant]),
  ]);
  const usedKeys = new Set(used.rows.map((i) => `${i.tipo}:${i.fuente_id}:${i.persona_id}`));
  const isUsed = (kind, id) => used.rows.some((i) => i.tipo === kind && i.fuente_id === id);
  const items = [], pending = [], expenses = [], trips = [];
  const add = (tipo, source, persona_id, fecha, amount, concepto, detalle) => {
    if (!usedKeys.has(`${tipo}:${source}:${persona_id}`)) items.push({ tipo, fuente_id: source, persona_id, fecha, monto: pesos(amount), concepto, detalle });
  };
  for (const c of receipts) {
    if (c.cobrado_por === "chofer") add("cobro", c.id, c.chofer_id, c.fecha, cent(c.monto), `Cobro de ${c.pet_name || "traslado"}`, c);
    const p = payments.rows.find((r) => r.cobro_id === c.id);
    const parts = shares.rows.filter((r) => r.reparto_id === p?.id);
    const base = receiptBase(c);
    const valid = p?.fuente_revision === base && parts.length > 0 && parts.reduce((sum, r) => sum + Math.round(Number(r.porcentaje) * 100), 0) === 10000;
    const amount = c.modelo_pago === "porcentaje" ? porcentajeCentavos(cent(c.monto), c.valor_pago) : 0;
    const frozen = used.rows.some((i) => i.cobro_id === c.id);
    const rev = hash([base,p || null,parts]);
    if (!c.modelo_pago) pending.push({ tipo: "condiciones", id: c.solicitud_id, descripcion: `${c.pet_name || "Traslado"}: falta definir el pago al chofer.` });
    else if (amount > 0 && !valid) pending.push({ tipo: "reparto", id: c.id, descripcion: `${c.pet_name || "Traslado"}: falta repartir la remuneración entre personas.` });
    if (amount > 0 && valid) for (const s of split(amount, parts)) add("remuneracion", c.id, s.persona_id, c.fecha, s.centavos, `Remuneración de ${c.pet_name || "traslado"}`, { ...c, porcentaje_persona: Number(s.porcentaje), reparto_id:p.id, reparto_registrado_por:p.registrado_por, reparto_fecha:p.updated_at });
    if (amount > 0) trips.push({ cobro_id: c.id, solicitud_id: c.solicitud_id, mascota: c.pet_name, fecha: c.fecha, cobrado: Number(c.monto), remuneracion: pesos(amount), revision: rev, repartido: valid, congelado: frozen, items: parts.map((i) => ({ persona_id: i.persona_id, porcentaje: Number(i.porcentaje) })) });
  }
  for (const c of costs.rows) {
    const d = decisions.rows.find((r) => r.costo_id === c.id), base = costBase(c);
    const valid = d?.fuente_revision === base;
    const frozen = isUsed("gasto", c.id);
    if (!valid) pending.push({ tipo: "gasto", id: c.id, descripcion: `${c.concepto}: identificá quién lo pagó y si corresponde reintegrarlo.` });
    else add("gasto", c.id, d.persona_id, c.fecha, d.reintegrable ? cent(c.monto) : 0, `${c.concepto}${d.reintegrable ? " · reintegrable" : " · a cargo de la persona"}`, { ...c, reintegrable: d.reintegrable, aprobacion_reintegro:d });
    expenses.push({ id: c.id, concepto: c.concepto, fecha: c.fecha, monto: Number(c.monto), pagado_por: c.pagado_por, persona_id: d?.persona_id || null, reintegrable: valid ? d.reintegrable : null, revisado: valid, congelado: frozen, revision: hash([base,d || null]) });
  }
  for (const j of journals.rows) add("jornal", j.id, j.chofer_id, j.fecha, cent(j.monto), "Jornal registrado", j);
  for (const j of missingJournals.rows) pending.push({ tipo: "jornal", id: j.chofer_id, descripcion: `${j.fecha}: falta registrar un jornal${j.chofer_id ? " del chofer" : " y asignar su chofer"}.` });
  items.sort((a, b) => `${a.tipo}:${a.fuente_id}:${a.persona_id}`.localeCompare(`${b.tipo}:${b.fuente_id}:${b.persona_id}`));
  const summaries = people.rows.map((p) => {
    const list = items.filter((i) => i.persona_id === p.id);
    const sum = (kind) => list.filter((i) => kind.includes(i.tipo)).reduce((s, i) => s + cent(i.monto), 0);
    const cobrado = sum(["cobro"]), remuneracion = sum(["remuneracion","jornal"]), reintegros = sum(["gasto"]);
    return { ...p, cantidad: list.length, cobrado: pesos(cobrado), remuneracion: pesos(remuneracion), reintegros: pesos(reintegros), saldo_por_confirmar: pending.length ? null : pesos(cobrado-remuneracion-reintegros), saldo_confirmado_pendiente: Number(balances.rows.find((r) => r.persona_id === p.id)?.saldo || 0) };
  });
  return { ...q, revision: hash([q,items,pending,expenses,trips]), personas: summaries, items, gastos: expenses, viajes: trips, pendientes: pending };
}

async function detail(db, tenant, id, lock = false) {
  const r = await db.query(`SELECT *,desde::text,hasta::text FROM traslado_rendiciones WHERE tenant_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`, [tenant,id]);
  if (!r.rows.length) fail(404, "Rendición no encontrada.");
  const [items,movements] = await Promise.all([
    db.query("SELECT i.*,i.fecha::text FROM traslado_rendicion_items i WHERE i.tenant_id=$1 AND i.rendicion_id=$2 ORDER BY i.fecha,i.tipo,i.id", [tenant,id]),
    db.query(`SELECT m.*,m.fecha::text,p.name AS medio_pago FROM traslado_rendicion_movimientos m
      JOIN payment_methods p ON p.tenant_id=m.tenant_id AND p.id=m.payment_method_id
      WHERE m.tenant_id=$1 AND m.rendicion_id=$2 ORDER BY m.created_at,m.id`, [tenant,id]),
  ]);
  const effect = movements.rows.reduce((s,m) => s + cent(m.monto)*(m.tipo === "entrega_local" ? 1 : -1)*(m.reversion_de ? -1 : 1),0);
  const row = r.rows[0];
  return { ...row, cobrado:Number(row.cobrado), remuneracion:Number(row.remuneracion), reintegros:Number(row.reintegros), saldo_inicial:Number(row.saldo_inicial), saldo_pendiente: row.anulada ? 0 : pesos(cent(row.saldo_inicial)-effect), items:items.rows, movimientos:movements.rows };
}
const lockTenant = (db, tenant) => db.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [tenant]);
const readSnapshot = (pool, fn) => transaction(pool, async(db) => {
  await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  return fn(db);
});

export function registerTrasladosRendicionesRoutes(app,pool,requireRole) {
  const route = (fn) => [requireRole("admin"), async(req,res) => {
    try { if (!req.tenantId) fail(403,"No tenant context"); await fn(req,res); }
    catch(e) {
      if (["40001","40P01"].includes(e.code)) return res.status(409).json({ message:"Los datos cambiaron durante la revisión. Volvé a cargar y revisá de nuevo." });
      if (!sendTrasladoError(res,e)) { console.error(e); res.status(500).json({message:"No se pudo consultar o guardar la rendición."}); }
    }
  }];
  const base = "/v2/traslados/rendiciones";
  app.get(`${base}/revision`,...route(async(req,res) => {
    const q = parse(rangeSchema,req.query);
    const data = await readSnapshot(pool,(db)=>preview(db,req.tenantId,q));
    res.json(data);
  }));
  app.put(`${base}/gastos/:id`,...route(async(req,res) => {
    const id = parse(uuid,req.params.id), input = parse(z.object({ persona_id:uuid,reintegrable:z.boolean(),revision:hashSchema }).strict(),req.body);
    await transaction(pool,async(db) => {
      await lockTenant(db,req.tenantId);
      const r = await db.query("SELECT *,fecha::text FROM traslado_costos_externos WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[req.tenantId,id]);
      if (!r.rows.length) fail(404,"Gasto no encontrado.");
      const c = r.rows[0]; if (c.anulado) fail(409,"El gasto está anulado.");
      await assertRendicionSourceEditable(db,req.tenantId,"gasto",id);
      await person(db,req.tenantId,input.persona_id);
      const decision = await db.query("SELECT *,xmin::text AS revision FROM traslado_reintegros WHERE tenant_id=$1 AND costo_id=$2",[req.tenantId,id]);
      if (hash([costBase(c),decision.rows[0] || null]) !== input.revision) fail(409,"El gasto o su aprobación cambiaron. Volvé a revisar.");
      await db.query(`INSERT INTO traslado_reintegros(tenant_id,costo_id,persona_id,reintegrable,fuente_revision,registrado_por) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(tenant_id,costo_id) DO UPDATE SET persona_id=EXCLUDED.persona_id,reintegrable=EXCLUDED.reintegrable,fuente_revision=EXCLUDED.fuente_revision,registrado_por=EXCLUDED.registrado_por,updated_at=now()`,[req.tenantId,id,input.persona_id,input.reintegrable,costBase(c),req.user.sub]);
    }); res.json({guardado:true});
  }));
  app.put(`${base}/repartos/:id`,...route(async(req,res) => {
    const id = parse(uuid,req.params.id), input = parse(z.object({revision:hashSchema,items:z.array(z.object({persona_id:uuid,porcentaje:money.refine((v)=>v>0&&v<=100)}).strict()).min(1).max(20)}).strict(),req.body);
    if (new Set(input.items.map((i)=>i.persona_id)).size !== input.items.length || input.items.reduce((s,i)=>s+Math.round(i.porcentaje*100),0)!==10000) fail(400,"El reparto debe sumar 100% sin repetir personas.");
    await transaction(pool,async(db) => {
      await lockTenant(db,req.tenantId);
      const r = await db.query("SELECT fecha::text FROM traslado_cobros WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[req.tenantId,id]);
      if (!r.rows.length) fail(404,"Cobro no encontrado.");
      const c = (await receiptSources(db,req.tenantId,r.rows[0].fecha,r.rows[0].fecha)).find((v)=>v.id===id);
      if (c.modelo_pago!=="porcentaje" || !(Number(c.valor_pago)>0)) fail(409,"Este cobro no tiene una remuneración porcentual para repartir.");
      const frozen = await db.query("SELECT id FROM traslado_rendicion_items WHERE tenant_id=$1 AND cobro_id=$2 AND vigente LIMIT 1",[req.tenantId,id]);
      if (frozen.rows.length) fail(409,"El reparto ya pertenece a una rendición confirmada.");
      const p = (await db.query("SELECT *,xmin::text AS revision FROM traslado_remuneracion_repartos WHERE tenant_id=$1 AND cobro_id=$2",[req.tenantId,id])).rows[0];
      const parts = (await db.query("SELECT * FROM traslado_remuneracion_items WHERE tenant_id=$1 AND reparto_id=$2 ORDER BY reparto_id,persona_id",[req.tenantId,p?.id || null])).rows;
      if (hash([receiptBase(c),p||null,parts])!==input.revision) fail(409,"El cobro o el reparto cambiaron. Volvé a revisar.");
      for (const i of input.items) await person(db,req.tenantId,i.persona_id);
      if (p) await db.query("DELETE FROM traslado_remuneracion_repartos WHERE tenant_id=$1 AND id=$2",[req.tenantId,p.id]);
      const saved = await db.query("INSERT INTO traslado_remuneracion_repartos(tenant_id,cobro_id,fuente_revision,registrado_por) VALUES($1,$2,$3,$4) RETURNING id",[req.tenantId,id,receiptBase(c),req.user.sub]);
      for (const i of input.items) await db.query("INSERT INTO traslado_remuneracion_items(tenant_id,reparto_id,persona_id,porcentaje) VALUES($1,$2,$3,$4)",[req.tenantId,saved.rows[0].id,i.persona_id,i.porcentaje]);
    }); res.json({guardado:true});
  }));
  app.post(base,...route(async(req,res) => {
    const input = parse(z.object({id:uuid,persona_id:uuid,from:date,to:date,revision:hashSchema,confirmar:z.literal(true)}).strict(),req.body);
    const q = parse(rangeSchema,{from:input.from,to:input.to});
    const data = await transaction(pool,async(db) => {
      await lockTenant(db,req.tenantId);
      const existing = await db.query("SELECT *,desde::text,hasta::text FROM traslado_rendiciones WHERE tenant_id=$1 AND id=$2",[req.tenantId,input.id]);
      if (existing.rows.length) {
        const row=existing.rows[0];
        if (row.persona_id!==input.persona_id || String(row.desde).slice(0,10)!==q.from || String(row.hasta).slice(0,10)!==q.to || row.revision_origen!==input.revision) fail(409,"Ese identificador corresponde a otra rendición.");
        return detail(db,req.tenantId,input.id);
      }
      const p = await person(db,req.tenantId,input.persona_id);
      // Bloquear las fuentes económicas impide que una edición anterior al
      // cierre se cuele entre la revisión y el congelado de sus importes.
      const locked = new Map();
      for (const table of ["traslado_cobros","traslado_costos_externos","traslado_jornadas"]) {
        const rows = await db.query(`SELECT id FROM ${table} WHERE tenant_id=$1 AND fecha BETWEEN $2 AND $3 ORDER BY id FOR UPDATE`,[req.tenantId,q.from,q.to]);
        locked.set(table,new Set(rows.rows.map((r)=>r.id)));
      }
      const review=await preview(db,req.tenantId,q);
      if (review.revision!==input.revision) fail(409,"Los datos cambiaron después de la revisión. Volvé a cargarlos.");
      if (review.pendientes.length) fail(409,"Completá los gastos, condiciones y repartos pendientes antes de confirmar.");
      // Los INSERT de la operación anterior no toman el bloqueo del local.
      // Una fila que entró al período después de bloquear las fuentes requiere
      // otra revisión, incluso si hubo una edición simultánea de sus fechas.
      if (review.items.some((i)=>!locked.get(i.tipo==="gasto"?"traslado_costos_externos":i.tipo==="jornal"?"traslado_jornadas":"traslado_cobros").has(i.fuente_id))) fail(409,"Se agregaron conceptos durante la revisión. Volvé a cargar.");
      const summary=review.personas.find((v)=>v.id===p.id), items=review.items.filter((i)=>i.persona_id===p.id);
      if (!items.length) fail(409,"No hay conceptos nuevos para rendir de esta persona.");
      await db.query(`INSERT INTO traslado_rendiciones(id,tenant_id,persona_id,persona_nombre,desde,hasta,revision_origen,cobrado,remuneracion,reintegros,saldo_inicial,registrado_por)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[input.id,req.tenantId,p.id,p.name,q.from,q.to,input.revision,summary.cobrado,summary.remuneracion,summary.reintegros,summary.saldo_por_confirmar,req.user.sub]);
      for (const i of items) await db.query(`INSERT INTO traslado_rendicion_items(tenant_id,rendicion_id,persona_id,tipo,cobro_id,costo_id,jornada_id,fecha,concepto,monto,detalle)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[req.tenantId,input.id,p.id,i.tipo,["cobro","remuneracion"].includes(i.tipo)?i.fuente_id:null,i.tipo==="gasto"?i.fuente_id:null,i.tipo==="jornal"?i.fuente_id:null,i.fecha,i.concepto,i.monto,JSON.stringify(i.detalle)]);
      return detail(db,req.tenantId,input.id);
    }); res.status(201).json(data);
  }));
  app.get(base,...route(async(req,res) => {
    const q = parse(z.object({persona_id:uuid.optional(),limit:z.coerce.number().int().min(1).max(100).default(30),offset:z.coerce.number().int().min(0).max(1000000).default(0)}).strict(),req.query);
    if(q.persona_id) await person(pool,req.tenantId,q.persona_id);
    const data=await readSnapshot(pool,async(db)=>{
      const r=await db.query(`SELECT id,COUNT(*) OVER()::int AS total FROM traslado_rendiciones WHERE tenant_id=$1 AND ($2::uuid IS NULL OR persona_id=$2) ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4`,[req.tenantId,q.persona_id||null,q.limit,q.offset]);
      const items=[];for(const row of r.rows) items.push(await detail(db,req.tenantId,row.id));
      return {items,total:r.rows[0]?.total || 0,offset:q.offset,limit:q.limit};
    });res.json(data);
  }));
  app.get(`${base}/caja`,...route(async(req,res) => {
    const q=parse(z.object({fecha:date}).strict(),req.query);
    const r=await pool.query(`SELECT m.*,m.fecha::text,r.persona_nombre,p.name AS medio_pago FROM traslado_rendicion_movimientos m
      JOIN traslado_rendiciones r ON r.tenant_id=m.tenant_id AND r.id=m.rendicion_id
      JOIN payment_methods p ON p.tenant_id=m.tenant_id AND p.id=m.payment_method_id
      WHERE m.tenant_id=$1 AND m.fecha=$2 ORDER BY m.created_at,m.id`,[req.tenantId,q.fecha]);
    const items=r.rows.map((m)=>({...m,monto:Number(m.monto),importe_caja:pesos(cent(m.monto)*(m.tipo==="entrega_local"?1:-1)*(m.reversion_de?-1:1))}));
    res.json({items,entradas:pesos(items.reduce((s,m)=>s+Math.max(0,cent(m.importe_caja)),0)),salidas:pesos(items.reduce((s,m)=>s+Math.max(0,-cent(m.importe_caja)),0))});
  }));
  app.get(`${base}/:id`,...route(async(req,res)=>res.json(await readSnapshot(pool,(db)=>detail(db,req.tenantId,parse(uuid,req.params.id))))));
  app.post(`${base}/:id/movimientos`,...route(async(req,res) => {
    const id=parse(uuid,req.params.id), input=parse(z.object({id:uuid,tipo:z.enum(["entrega_local","pago_persona"]),monto:money.refine((v)=>v>0),fecha:date,payment_method_id:uuid,referencia:z.string().trim().max(200).default("")}).strict(),req.body);
    if(input.fecha>today()) fail(400,"Registrá una fecha de movimiento hasta hoy.");
    const data=await transaction(pool,async(db)=>{
      const d=await detail(db,req.tenantId,id,true);
      const existing=d.movimientos.find((m)=>m.id===input.id);
      if(existing){ if(existing.reversion_de || Object.keys(input).some((k)=>k!=="id" && String(existing[k])!==String(input[k]) && !(k==="monto"&&Number(existing[k])===input[k]))) fail(409,"El identificador ya se usó para otro movimiento."); return d; }
      if(d.anulada) fail(409,"La rendición está anulada.");
      const s=cent(d.saldo_pendiente), amount=cent(input.monto);
      if((s>0?input.tipo!=="entrega_local":input.tipo!=="pago_persona") || amount>Math.abs(s) || s===0) fail(409,"El movimiento no coincide con el saldo pendiente o supera su importe.");
      const method=await db.query("SELECT id FROM payment_methods WHERE tenant_id=$1 AND id=$2",[req.tenantId,input.payment_method_id]);
      if(!method.rows.length) fail(400,"Elegí un medio de pago del mismo local.");
      await db.query(`INSERT INTO traslado_rendicion_movimientos(id,tenant_id,rendicion_id,tipo,monto,fecha,payment_method_id,referencia,registrado_por) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[input.id,req.tenantId,id,input.tipo,input.monto,input.fecha,input.payment_method_id,input.referencia,req.user.sub]);
      return detail(db,req.tenantId,id);
    });res.status(201).json(data);
  }));
  app.post(`${base}/:id/reversiones`,...route(async(req,res)=>{
    const id=parse(uuid,req.params.id), input=parse(z.object({id:uuid,movimiento_id:uuid,fecha:date,payment_method_id:uuid.optional(),motivo:reason,confirmar:z.literal(true)}).strict(),req.body);
    if(input.fecha>today()) fail(400,"Registrá una fecha de reversión hasta hoy.");
    const data=await transaction(pool,async(db)=>{
      const d=await detail(db,req.tenantId,id,true), old=d.movimientos.find((m)=>m.id===input.movimiento_id);
      if(!old || old.reversion_de) fail(404,"Movimiento original no encontrado.");
      const method=input.payment_method_id || old.payment_method_id;
      const retry=d.movimientos.find((m)=>m.id===input.id);
      if(retry){if(retry.reversion_de!==old.id || retry.fecha!==input.fecha || retry.motivo!==input.motivo || retry.payment_method_id!==method) fail(409,"El identificador ya se usó para otra reversión.");return d;}
      if(d.anulada || d.movimientos.some((m)=>m.reversion_de===old.id)) fail(409,"El movimiento ya está revertido o la rendición está anulada.");
      if(input.fecha<old.fecha) fail(400,"La reversión no puede tener fecha anterior al movimiento original.");
      const validMethod=await db.query("SELECT id FROM payment_methods WHERE tenant_id=$1 AND id=$2",[req.tenantId,method]);
      if(!validMethod.rows.length) fail(400,"Elegí un medio de reversión del mismo local.");
      await db.query(`INSERT INTO traslado_rendicion_movimientos(id,tenant_id,rendicion_id,tipo,monto,fecha,payment_method_id,reversion_de,motivo,registrado_por) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[input.id,req.tenantId,id,old.tipo,old.monto,input.fecha,method,old.id,input.motivo,req.user.sub]);
      return detail(db,req.tenantId,id);
    });res.status(201).json(data);
  }));
  app.post(`${base}/:id/anulacion`,...route(async(req,res)=>{
    const id=parse(uuid,req.params.id), input=parse(z.object({motivo:reason,confirmar:z.literal(true)}).strict(),req.body);
    const data=await transaction(pool,async(db)=>{
      await lockTenant(db,req.tenantId);const d=await detail(db,req.tenantId,id,true);
      if(d.anulada){if(d.motivo_anulacion!==input.motivo)fail(409,"La rendición ya se anuló con otro motivo.");return d;}
      if(d.movimientos.some((m)=>!m.reversion_de&&!d.movimientos.some((rev)=>rev.reversion_de===m.id))) fail(409,"Revertí los movimientos de dinero antes de anular la rendición.");
      await db.query("UPDATE traslado_rendiciones SET anulada=true,anulada_por=$3,anulada_at=now(),motivo_anulacion=$4 WHERE tenant_id=$1 AND id=$2",[req.tenantId,id,req.user.sub,input.motivo]);
      await db.query("UPDATE traslado_rendicion_items SET vigente=false WHERE tenant_id=$1 AND rendicion_id=$2",[req.tenantId,id]);
      return detail(db,req.tenantId,id);
    });res.json(data);
  }));
}
