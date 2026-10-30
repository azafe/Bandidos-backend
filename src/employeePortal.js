// Experiencia de MiPagoPage/AnticiposPage de AppTzReactChofer, adaptada a
// sesiones JWT de Bandidos y a una única fuente de trabajos: agenda_turnos.
import { z } from 'zod';
import { transaction } from './traslados.js';

const uuid = z.string().uuid();
export const calendarDate = z.string().regex(/^(?!0000)\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const d = new Date(`${s}T12:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === s;
});
const period = z.object({ from: calendarDate, to: calendarDate }).strict()
  .refine((v) => v.from <= v.to && (new Date(v.to)-new Date(v.from))/86400000 <= 366);
export function fail(status, message) { throw Object.assign(new Error(message), { status }); }
export function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) fail(400, 'Revisá los datos enviados.');
  return result.data;
}
export function route(fn) {
  return async (req, res) => {
    try {
      res.set('Cache-Control','no-store');
      if (!req.tenantId) fail(403, 'No hay un local asignado.');
      await fn(req,res);
    } catch (e) {
      const status = e.status || (['23514','23503'].includes(e.code) ? 400 : e.code === '23505' ? 409 : 500);
      if (status === 500) console.error(e);
      res.status(status).json({ message: status===500 ? 'No se pudo completar la operación.' : status===409 && !e.status ? 'Ya existe una cuenta o un movimiento con esos datos.' : e.message });
    }
  };
}

export async function validateEmployee(db, tenant, employeeId) {
  const r = await db.query("SELECT id FROM employees WHERE tenant_id=$1 AND id=$2 AND status='active' FOR SHARE", [tenant,employeeId]);
  if (!r.rows.length) fail(400,'Elegí un empleado activo del mismo local.');
}

// Permisos del servidor: el ID de la sesión decide a quién pertenecen los
// datos. Los parámetros del navegador nunca amplían ese acceso.
export function restrictEmployeeAccess(req,res,next) {
  if (!req.employeeId) return next();
  const path = req.path.replace(/\/+$/,'');
  if (req.method==='GET' && path==='/me') return next();
  if (!req.employeeActive) return res.status(403).json({ message:'Tu acceso está inactivo. Contactá al administrador.', employee_inactive:true });
  if (path==='/v2/me/employee' && req.method==='GET') return next();
  if (path.startsWith('/v2/chat/') || path==='/v2/chat') return next();
  if (path==='/push/subscribe' && ['POST','DELETE'].includes(req.method) && !req.driverId) return next();
  if (req.driverId && ((req.method==='GET' && path==='/v2/traslados/hoja-de-ruta') ||
      (req.method==='PATCH' && /^\/v2\/traslados\/[a-f\d-]+\/estado$/i.test(path)))) return next();
  return res.status(403).json({ message:'Tu cuenta solo tiene acceso a tu espacio personal y al chat.' });
}

// El pool de comisión se redondea una sola vez a centavos. El resto se
// asigna en orden (principal, segunda, tercera): los importes siempre suman.
export const workSql = `SELECT a.id,a.date::text,a.time,a.pet_name,st.name AS service_name,
  a.price,a.commission_rate_snapshot,a.commission_historical_estimate,
  array_length(p.ids,1) AS participants,
  ((floor(round(COALESCE(a.price,0)*COALESCE(a.commission_rate_snapshot,0.40)*100)/array_length(p.ids,1)) +
    CASE WHEN array_position(p.ids,$2::uuid)<=mod(round(COALESCE(a.price,0)*COALESCE(a.commission_rate_snapshot,0.40)*100),array_length(p.ids,1)) THEN 1 ELSE 0 END)/100)::numeric(12,2) AS earned
 FROM agenda_turnos a
 CROSS JOIN LATERAL (SELECT array_remove(ARRAY[a.groomer_id,a.second_groomer_id,a.third_groomer_id],NULL) AS ids) p
 LEFT JOIN service_types st ON st.tenant_id=a.tenant_id AND st.id=a.service_type_id
 WHERE a.tenant_id=$1 AND (a.groomer_id=$2::uuid OR a.second_groomer_id=$2::uuid OR a.third_groomer_id=$2::uuid) AND a.status='finished'`;

async function statement(db,tenant,employeeId,q) {
  const employee = (await db.query('SELECT id,name,role,status,payroll_start_date::text,opening_balance FROM employees WHERE tenant_id=$1 AND id=$2',[tenant,employeeId])).rows[0];
  if (!employee) fail(404,'Empleado no encontrado.');
  const works = (await db.query(`${workSql} AND a.date BETWEEN $3 AND $4 ORDER BY a.date DESC,a.time DESC,a.id`,[tenant,employeeId,q.from,q.to])).rows;
  const payments = (await db.query('SELECT id,kind,date::text,amount,method,notes,created_at,voided_at,void_reason FROM employee_payments WHERE tenant_id=$1 AND employee_id=$2 AND date BETWEEN $3 AND $4 ORDER BY date DESC,created_at DESC,id',[tenant,employeeId,q.from,q.to])).rows;
  const totals = (await db.query(`WITH works AS (${workSql})
    SELECT COALESCE((SELECT sum(earned) FROM works WHERE date::date BETWEEN $3::date AND $4::date),0) AS earned_total,
    COALESCE((SELECT sum(earned) FROM works WHERE date::date >= $3::date AND date::date < $5::date AND date::date <= $4::date),0) AS earned_before,
    COALESCE(sum(amount) FILTER(WHERE kind='anticipo' AND date >= $5::date),0) AS advances,
    COALESCE(sum(amount) FILTER(WHERE kind='pago' AND date >= $5::date),0) AS paid,
    COALESCE(sum(amount),0) AS payments_total,
    COALESCE(sum(amount) FILTER(WHERE date < $5::date),0) AS payments_before
    FROM employee_payments WHERE tenant_id=$1 AND employee_id=$2 AND NOT (voided_at IS NOT NULL)
      AND date BETWEEN $3::date AND $4::date`,[tenant,employeeId,employee.payroll_start_date,q.to,q.from])).rows[0];
  const inRange = works.filter(w=>w.date >= employee.payroll_start_date);
  const cents = (n) => Math.round(Number(n)*100);
  const opening = q.to < employee.payroll_start_date ? 0 : cents(employee.opening_balance);
  return { employee,from:q.from,to:q.to,works,payments, summary:{
    earned:inRange.reduce((s,w)=>s+cents(w.earned),0)/100,
    advances:Number(totals.advances),paid:Number(totals.paid),
    opening:(opening+cents(totals.earned_before)-cents(totals.payments_before))/100,
    balance:(opening+cents(totals.earned_total)-cents(totals.payments_total))/100,
    advance_count:payments.filter(p=>p.kind==='anticipo' && !p.voided_at && p.date>=employee.payroll_start_date).length,
    missing_prices:inRange.filter(w=>w.price==null).length,
    historical_estimates:inRange.filter(w=>w.commission_historical_estimate).length,
  }};
}

export function registerEmployeePortalRoutes(app,pool,requireRole) {
  // Repeatable read evita combinar trabajos y movimientos de dos momentos.
  const readStatement = (tenant,id,q) => transaction(pool,async db=>{
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    return statement(db,tenant,id,q);
  });
  app.get('/v2/me/employee',route(async(req,res)=>{
    const id=req.employeeId || req.driverId;
    if (!id) fail(403,'Tu cuenta no está vinculada a un empleado.');
    res.json(await readStatement(req.tenantId,id,parse(period,req.query)));
  }));
  app.get('/v2/employees/:id/statement',requireRole('admin'),route(async(req,res)=>{
    res.json(await readStatement(req.tenantId,parse(uuid,req.params.id),parse(period,req.query)));
  }));
  app.put('/v2/users/:id/employee',requireRole('admin'),route(async(req,res)=>{
    const id=parse(uuid,req.params.id);
    const {employee_id}=parse(z.object({employee_id:uuid.nullable()}).strict(),req.body);
    if (id===req.user.sub) fail(400,'No cambies tu propio acceso desde esta opción.');
    const saved=await transaction(pool,async db=>{
      const user=(await db.query('SELECT id,role FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[req.tenantId,id])).rows[0];
      if (!user) fail(404,'Usuario no encontrado.');
      if (employee_id && !['staff','user'].includes(user.role)) fail(400,'Usá una cuenta de equipo para el acceso personal.');
      if (employee_id) await validateEmployee(db,req.tenantId,employee_id);
      return (await db.query('UPDATE users SET employee_id=$3,chofer_id=NULL WHERE tenant_id=$1 AND id=$2 RETURNING id,email,role,employee_id,chofer_id',[req.tenantId,id,employee_id])).rows[0];
    });
    res.json(saved);
  }));
  app.put('/v2/employees/:id/payroll-config',requireRole('admin'),route(async(req,res)=>{
    const id=parse(uuid,req.params.id);
    const data=parse(z.object({payroll_start_date:calendarDate,opening_balance:z.number().finite().min(-999999999).max(999999999).multipleOf(0.01)}).strict(),req.body);
    res.json(await transaction(pool,async db=>{
      const employee=(await db.query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[req.tenantId,id])).rows[0];
      if (!employee) fail(404,'Empleado no encontrado.');
      const paid=(await db.query('SELECT id FROM employee_payments WHERE tenant_id=$1 AND employee_id=$2 LIMIT 1',[req.tenantId,id])).rows.length;
      if(paid) fail(409,'La liquidación ya tiene movimientos. Conservá la configuración inicial.');
      return (await db.query('UPDATE employees SET payroll_start_date=$3,opening_balance=$4 WHERE tenant_id=$1 AND id=$2 RETURNING id,payroll_start_date::text,opening_balance',[req.tenantId,id,data.payroll_start_date,data.opening_balance])).rows[0];
    }));
  }));
  app.post('/v2/employees/:id/payments',requireRole('admin'),route(async(req,res)=>{
    const employeeId=parse(uuid,req.params.id);
    const data=parse(z.object({id:uuid,kind:z.enum(['anticipo','pago']),date:calendarDate,
      amount:z.number().positive().max(999999999).multipleOf(0.01),method:z.enum(['efectivo','transferencia','otro']),notes:z.string().trim().max(1000).default('')}).strict(),req.body);
    const saved=await transaction(pool,async db=>{
      const employee=(await db.query('SELECT payroll_start_date::text FROM employees WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[req.tenantId,employeeId])).rows[0];
      if(!employee) fail(404,'Empleado no encontrado.');
      if(data.date < employee.payroll_start_date) fail(400,'El movimiento debe ser posterior al inicio de la liquidación.');
      const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      if(data.date>today) fail(400,'Registrá únicamente pagos ya realizados.');
      const old=(await db.query('SELECT * FROM employee_payments WHERE id=$1',[data.id])).rows[0];
      if(old){
        if(old.tenant_id!==req.tenantId || old.employee_id!==employeeId || old.kind!==data.kind || String(old.date).slice(0,10)!==data.date || Number(old.amount)!==data.amount || old.method!==data.method || old.notes!==data.notes || old.voided_at)
          fail(409,'Ese identificador ya corresponde a otro movimiento.');
        return old;
      }
      return (await db.query(`INSERT INTO employee_payments(id,tenant_id,employee_id,kind,date,amount,method,notes,recorded_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[data.id,req.tenantId,employeeId,data.kind,data.date,data.amount,data.method,data.notes,req.user.sub])).rows[0];
    });
    res.status(201).json(saved);
  }));
  app.post('/v2/employees/:id/payments/:paymentId/void',requireRole('admin'),route(async(req,res)=>{
    const id=parse(uuid,req.params.id),paymentId=parse(uuid,req.params.paymentId);
    const {reason}=parse(z.object({reason:z.string().trim().min(1).max(500)}).strict(),req.body);
    const saved=(await pool.query(`UPDATE employee_payments SET voided_at=now(),voided_by=$4,void_reason=$5
      WHERE tenant_id=$1 AND employee_id=$2 AND id=$3 AND voided_at IS NULL RETURNING id`,[req.tenantId,id,paymentId,req.user.sub,reason])).rows[0];
    if(!saved) fail(409,'El movimiento no existe o ya fue anulado.');
    res.json(saved);
  }));
}
