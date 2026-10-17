import crypto from "node:crypto";
import { z } from "zod";
import { TrasladoError, sendTrasladoError, transaction, lockSolicitud } from "./traslados.js";

const uuid = z.string().uuid();
const fecha = z.string().date();
const importe = z.number().finite().min(0).max(9999999999.99)
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.0001);
const revision = z.string().regex(/^\d+$/).nullable();
const rango = z.object({ from: fecha, to: fecha }).strict().refine(
  (v) => v.from <= v.to && v.from.slice(0, 7) === v.to.slice(0, 7),
  "Elegí un período dentro del mismo mes.",
);
const fail = (status, message) => { throw new TrasladoError(status, message); };
const parse = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) fail(400, "Revisá los campos, los importes y el período (un mes por consulta).");
  return result.data;
};
const cents = (n) => Math.round(Number(n || 0) * 100);
const pesos = (n) => n / 100;
const inRange = (d, q) => d >= q.from && d <= q.to;
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Repartir centavos, en lugar de redondear cada porcentaje por separado,
// conserva exactamente el total aun cuando el precio no sea divisible.
function distribute(amount, weights) {
  const rows = weights.map((w) => {
    const product = BigInt(amount) * BigInt(w.puntos);
    return { ...w, value: Number(product / 10000n), rest: Number(product % 10000n) };
  });
  let remaining = amount - rows.reduce((s, r) => s + r.value, 0);
  for (const row of [...rows].sort((a, b) => b.rest - a.rest || String(a.vehiculo_id).localeCompare(String(b.vehiculo_id)))) {
    if (remaining-- > 0) row.value += 1;
  }
  return rows;
}

async function costData(db, tenant, q) {
  const period = `${q.from.slice(0, 7)}-01`;
  const [settings, categories, daily, fixed, external, review, month] = await Promise.all([
    db.query("SELECT * FROM traslado_resultado_ajustes WHERE tenant_id=$1", [tenant]),
    db.query("SELECT category_id FROM traslado_resultado_categorias WHERE tenant_id=$1 ORDER BY category_id", [tenant]),
    db.query(`SELECT d.id,d.date::text AS fecha,d.description AS concepto,d.amount AS monto,a.vehiculo_id,a.xmin::text AS revision
      FROM daily_expenses d JOIN traslado_resultado_categorias c ON c.tenant_id=d.tenant_id AND c.category_id=d.category_id
      LEFT JOIN traslado_gasto_asignaciones a ON a.tenant_id=d.tenant_id AND a.daily_expense_id=d.id
      WHERE d.tenant_id=$1 AND d.date BETWEEN $2 AND $3 ORDER BY d.id`, [tenant, `${period}`, `${period.slice(0, 7)}-${new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).getUTCDate()}`]),
    db.query(`SELECT f.id,f.period::text AS fecha,f.name AS concepto,f.amount AS monto,a.vehiculo_id,a.xmin::text AS revision,p.source
      FROM fixed_expense_charges f JOIN traslado_resultado_categorias c ON c.tenant_id=f.tenant_id AND c.category_id=f.category_id
      LEFT JOIN traslado_gasto_asignaciones a ON a.tenant_id=f.tenant_id AND a.fixed_charge_id=f.id
      LEFT JOIN fixed_expense_periods p ON p.tenant_id=f.tenant_id AND p.period=f.period
      WHERE f.tenant_id=$1 AND f.period=$2 ORDER BY f.id`, [tenant, period]),
    db.query("SELECT *,fecha::text,xmin::text AS revision FROM traslado_costos_externos WHERE tenant_id=$1 AND date_trunc('month',fecha)::date=$2 ORDER BY id", [tenant, period]),
    db.query("SELECT revision FROM traslado_revision_costos WHERE tenant_id=$1 AND periodo=$2", [tenant, period]),
    db.query("SELECT source FROM fixed_expense_periods WHERE tenant_id=$1 AND period=$2", [tenant, period]),
  ]);
  const signature = hash([settings.rows.length > 0, categories.rows, daily.rows, fixed.rows, external.rows, month.rows]);
  const days = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).getUTCDate();
  // La diferencia entre acumulados conserva los centavos al dividir un mes
  // en períodos contiguos: dos mitades deben sumar el mismo cargo mensual.
  const prorate = (amount) => Math.round(cents(amount) * Number(q.to.slice(8)) / days)
    - Math.round(cents(amount) * (Number(q.from.slice(8)) - 1) / days);
  const costos = [
    ...daily.rows.filter((r) => inRange(r.fecha, q)).map((r) => ({ ...r, tipo: "diario", pagado_por: "Local", centavos: cents(r.monto) })),
    ...fixed.rows.map((r) => ({ ...r, tipo: "fijo", pagado_por: "Local", centavos: prorate(r.monto) })),
    ...external.rows.filter((r) => !r.anulado && inRange(r.fecha, q)).map((r) => ({ ...r, tipo: "externo", centavos: cents(r.monto) })),
  ];
  return {
    costos, externos: external.rows, categorias: categories.rows.map((r) => r.category_id), configurado: settings.rows.length > 0,
    revision: signature, confirmado: review.rows[0]?.revision === signature,
    fijos_estimados: fixed.rows.some((r) => r.source === "backfill"),
    // La confirmación incluye revisar que no falte cargar seguro/patente u otros
    // gastos: una categoría vacía no prueba por sí misma que el costo sea cero.
    mes_fijo_armado: month.rows.length > 0,
  };
}

export async function resultadosEnPeriodo(db, tenant, q) {
  const [cost, requests, legs, splits, jornadas, vehicles, history] = await Promise.all([
    costData(db, tenant, q),
    db.query(`SELECT s.*,a.pet_name,a.status AS turno_status,c.monto AS cobro_monto,c.fecha::text AS cobro_fecha,
      cfg.modelo_pago,cfg.valor_pago,cfg.costo_referencia,cfg.unidad_referencia
      FROM traslado_solicitudes s JOIN agenda_turnos a ON a.tenant_id=s.tenant_id AND a.id=s.turno_id
      LEFT JOIN traslado_cobros c ON c.tenant_id=s.tenant_id AND c.solicitud_id=s.id
      LEFT JOIN traslado_condiciones_revisadas cr ON cr.tenant_id=s.tenant_id AND cr.solicitud_id=s.id
      LEFT JOIN traslado_configuracion cfg ON cfg.tenant_id=s.tenant_id AND cfg.id=COALESCE(cr.configuracion_id,s.configuracion_id)
      WHERE s.tenant_id=$1 AND s.origen='agenda' AND (c.fecha BETWEEN $2 AND $3 OR EXISTS(
        SELECT 1 FROM traslados t WHERE t.tenant_id=s.tenant_id AND t.solicitud_id=s.id AND t.fecha_programada BETWEEN $2 AND $3))
      ORDER BY s.id`, [tenant, q.from, q.to]),
    db.query("SELECT solicitud_id,vehiculo_id,chofer_id,fecha_programada::text AS fecha,estado FROM traslados WHERE tenant_id=$1 ORDER BY id", [tenant]),
    db.query(`SELECT r.solicitud_id,i.vehiculo_id,i.porcentaje,r.xmin::text AS revision
      FROM traslado_repartos r JOIN traslado_reparto_items i ON i.tenant_id=r.tenant_id AND i.reparto_id=r.id
      WHERE r.tenant_id=$1 ORDER BY r.solicitud_id,i.vehiculo_id`, [tenant]),
    db.query(`SELECT j.*,j.fecha::text,j.xmin::text AS revision,e.name AS chofer_nombre
      FROM traslado_jornadas j JOIN employees e ON e.tenant_id=j.tenant_id AND e.id=j.chofer_id
      WHERE j.tenant_id=$1 AND j.fecha BETWEEN $2 AND $3 ORDER BY j.fecha,j.chofer_id`, [tenant, q.from, q.to]),
    db.query("SELECT id,nombre,patente,activo FROM vehiculos WHERE tenant_id=$1 ORDER BY nombre,id", [tenant]),
    db.query(`SELECT fecha::text,monto,bonificado FROM traslado_historicos WHERE tenant_id=$1 AND fecha BETWEEN $2 AND $3 AND turno_status='finished'
      UNION ALL SELECT a.date::text,a.traslado_amount,a.traslado_bonificado FROM agenda_turnos a WHERE a.tenant_id=$1
      AND a.date BETWEEN $2 AND $3 AND a.status='finished' AND a.traslado=true
      AND NOT EXISTS(SELECT 1 FROM traslado_solicitudes s WHERE s.tenant_id=a.tenant_id AND s.turno_id=a.id)`, [tenant, q.from, q.to]),
  ]);
  const make = (id, nombre) => ({ vehiculo_id: id, nombre, ingreso: 0, pago: 0, gasto: 0, referencia: 0, cobros: 0, realizados: 0, bonificados: 0, pendientes: new Set(), dias: new Set(), semana: Array(7).fill(0) });
  const total = make(null, "Todos los móviles");
  const groups = new Map(vehicles.rows.map((v) => [v.id, { ...make(v.id, v.nombre), patente: v.patente }]));
  groups.set("sin_asignar", make(null, "Sin distribuir"));
  const byLeg = new Map(), bySplit = new Map();
  for (const l of legs.rows) { const list = byLeg.get(l.solicitud_id) || []; list.push(l); byLeg.set(l.solicitud_id, list); }
  for (const s of splits.rows) { const list = bySplit.get(s.solicitud_id) || []; list.push(s); bySplit.set(s.solicitud_id, list); }
  const groupFor = (id) => groups.get(id || "sin_asignar");
  const add = (key, amount, weights) => {
    total[key] += amount;
    for (const row of distribute(amount, weights)) groupFor(row.vehiculo_id)[key] += row.value;
  };
  const pending = (key, weights) => { total.pendientes.add(key); for (const w of weights) groupFor(w.vehiculo_id).pendientes.add(key); };
  const operaciones = [], jornalDays = new Map(), referenceDays = new Map(), referenceUnits = new Map();
  for (const s of requests.rows) {
    const active = (byLeg.get(s.id) || []).filter((l) => l.estado !== "cancelado");
    const ids = [...new Set(active.map((l) => l.vehiculo_id))];
    const saved = bySplit.get(s.id) || [];
    const repartoValido = saved.length > 0 && saved.every((p) => ids.includes(p.vehiculo_id)) && saved.reduce((sum, p) => sum + Math.round(Number(p.porcentaje) * 100), 0) === 10000;
    const weights = repartoValido ? saved.map((p) => ({ vehiculo_id: p.vehiculo_id, puntos: Math.round(Number(p.porcentaje) * 100) }))
      : [{ vehiculo_id: ids.length === 1 ? ids[0] : null, puntos: 10000 }];
    const completion = active.map((l) => l.fecha).sort().at(-1);
    const done = !s.cancelado && !["cancelled", "no_show"].includes(s.turno_status) && active.length > 0 && active.every((l) => l.estado === "entregado");
    const completedHere = done && inRange(completion, q);
    const collectedHere = s.cobro_fecha && inRange(s.cobro_fecha, q);
    if (!done && active.some((l) => l.estado === "entregado" && inRange(l.fecha, q))) pending("operaciones_en_curso", weights);
    if (collectedHere) {
      const received = cents(s.cobro_monto);
      add("ingreso", received, weights);
      total.cobros += 1;
      for (const w of weights) groupFor(w.vehiculo_id).cobros += w.puntos / 10000;
      if (s.modelo_pago === "porcentaje") add("pago", Math.round(received * Number(s.valor_pago) / 100), weights);
      else if (!s.modelo_pago) pending("pago_sin_definir", weights);
      if (!done) pending("cobros_con_operacion_pendiente", weights);
    }
    for (const l of active.filter((l) => l.estado === "entregado" && inRange(l.fecha, q))) {
      const key = `${l.chofer_id}:${l.fecha}`;
      if (!s.modelo_pago) pending("pago_sin_definir", weights);
      if (l.chofer_id && s.costo_referencia !== null && s.costo_referencia !== undefined) {
        const units = referenceUnits.get(key) || new Set(); units.add(s.unidad_referencia); referenceUnits.set(key, units);
      }
      if (s.modelo_pago === "jornal") {
        if (!l.chofer_id) pending("jornales_sin_chofer", weights);
        else jornalDays.set(key, { fecha: l.fecha, chofer_id: l.chofer_id, monto_sugerido: Number(s.valor_pago) });
      }
      if (s.unidad_referencia === "dia" && s.costo_referencia !== null && s.costo_referencia !== undefined) {
        if (!l.chofer_id) pending("referencia_sin_chofer", weights);
        else {
          const entry = referenceDays.get(key) || { amount: cents(s.costo_referencia), vehicles: new Set(), conflict: false };
          entry.conflict ||= entry.amount !== cents(s.costo_referencia);
          entry.vehicles.add(l.vehiculo_id); referenceDays.set(key, entry);
        }
      }
    }
    if (completedHere) {
      total.realizados += 1;
      total.bonificados += Number(s.bonificado);
      total.dias.add(completion);
      const day = new Date(`${completion}T12:00:00Z`).getUTCDay();
      total.semana[day] += 1;
      for (const w of weights) {
        const g = groupFor(w.vehiculo_id), share = w.puntos / 10000;
        g.realizados += share; g.bonificados += Number(s.bonificado) * share; g.dias.add(completion); g.semana[day] += share;
      }
      if (s.costo_referencia === null || s.costo_referencia === undefined) pending("referencia_sin_definir", weights);
      else if (s.unidad_referencia === "traslado") add("referencia", cents(s.costo_referencia), weights);
      if (!s.bonificado && !s.cobro_fecha) pending("traslados_sin_cobrar", weights);
      if (!s.modelo_pago) pending("pago_sin_definir", weights);
    }
    if (collectedHere || completedHere) {
      operaciones.push({ id: s.id, mascota: s.pet_name, precio: s.precio_total === null ? null : Number(s.precio_total), cobrado: collectedHere ? Number(s.cobro_monto) : 0,
        realizado: completedHere, bonificado: s.bonificado, condiciones_pendientes: !s.modelo_pago, vehiculos: ids.filter(Boolean), reparto: saved.map((p) => ({ vehiculo_id: p.vehiculo_id, porcentaje: Number(p.porcentaje) })),
        revision: saved[0]?.revision || null, sin_distribuir: weights.some((w) => !w.vehiculo_id) });
    }
  }
  const requiredJornales = [...jornalDays.values()].filter((d) => !jornadas.rows.some((j) => !j.anulado && j.chofer_id === d.chofer_id && j.fecha === d.fecha));
  if ([...referenceUnits.values()].some((units) => units.size > 1)) total.pendientes.add("referencias_diarias_incompatibles");
  if (requiredJornales.length) total.pendientes.add("jornales_sin_registrar");
  for (const j of jornadas.rows.filter((j) => !j.anulado)) add("pago", cents(j.monto), [{ vehiculo_id: j.vehiculo_id, puntos: 10000 }]);
  for (const r of referenceDays.values()) {
    if (r.conflict) total.pendientes.add("referencias_diarias_incompatibles");
    else add("referencia", r.amount, [{ vehiculo_id: r.vehicles.size === 1 ? [...r.vehicles][0] : null, puntos: 10000 }]);
  }
  for (const c of cost.costos) add("gasto", c.centavos, [{ vehiculo_id: c.vehiculo_id, puntos: 10000 }]);
  const common = [];
  if (!cost.configurado) common.push("categorias_sin_elegir");
  if (!cost.confirmado) common.push("gastos_sin_revisar");
  if (cost.fijos_estimados) common.push("gastos_fijos_estimados");
  if (history.rows.length) common.push("historicos_sin_costos");
  // Un ingreso sin móvil o un gasto compartido no se atribuye por intuición.
  // Bloquea los resultados por móvil, pero el total conocido se conserva.
  const unassigned = groupFor(null);
  const hasUnassigned = ["ingreso", "pago", "gasto", "realizados"].some((k) => unassigned[k] !== 0);
  const material = (g, overall = false) => {
    const problems = new Set([...common, ...g.pendientes]);
    if (!overall && hasUnassigned) problems.add("importes_sin_distribuir");
    if (!overall && unassigned.referencia !== 0) problems.add("referencia_sin_distribuir");
    if (requiredJornales.length) problems.add("jornales_sin_registrar");
    if (total.pendientes.has("referencias_diarias_incompatibles")) problems.add("referencias_diarias_incompatibles");
    const financial = [...problems].filter((p) => !p.startsWith("referencia"));
    const refProblems = [...problems].filter((p) => !["pago_sin_definir", "jornales_sin_registrar", "jornales_sin_chofer"].includes(p));
    return { vehiculo_id: g.vehiculo_id, nombre: g.nombre, patente: g.patente,
      ingresos: pesos(g.ingreso), pago_choferes: [...problems].some((p) => ["pago_sin_definir", "jornales_sin_registrar", "jornales_sin_chofer"].includes(p)) ? null : pesos(g.pago),
      pago_choferes_conocido: pesos(g.pago), gastos: pesos(g.gasto),
      costo_referencia: [...problems].some((p) => p.startsWith("referencia") || p === "historicos_sin_costos") ? null : pesos(g.referencia),
      resultado: financial.length ? null : pesos(g.ingreso - g.pago - g.gasto),
      resultado_referencia: refProblems.length ? null : pesos(g.ingreso - g.referencia - g.gasto),
      subtotal: pesos(g.ingreso - g.pago - g.gasto), pendientes: [...problems],
      realizados: g.realizados, bonificados: g.bonificados,
      costo_por_traslado: financial.length || !g.realizados ? null : pesos(g.pago + g.gasto) / g.realizados,
      // Ingreso y volumen usan fechas distintas: se expone la base al usuario.
      ingreso_promedio_cobrado: g.cobros ? pesos(g.ingreso) / g.cobros : null,
      traslados_por_dia_activo: g.dias.size ? g.realizados / g.dias.size : null,
      dias_activos: g.dias.size, por_dia_semana: g.semana,
    };
  };
  return { from: q.from, to: q.to, total: material(total, true), vehiculos: [...groups.values()].map((g) => material(g)),
    operaciones, jornadas: jornadas.rows, jornadas_pendientes: requiredJornales, costos_externos: cost.externos,
    costos: cost.costos.map(({ centavos, ...c }) => ({ ...c, monto_periodo: pesos(centavos), monto: Number(c.monto) })),
    gastos: { categorias: cost.categorias, configurado: cost.configurado, confirmado: cost.confirmado, revision: cost.revision, mes_fijo_armado: cost.mes_fijo_armado },
    historicos: { cantidad: history.rows.length, importe_registrado: pesos(history.rows.reduce((sum, r) => sum + cents(r.monto), 0)) },
  };
}

async function assertVehicle(db, tenant, vehicle) {
  if (!vehicle) return;
  const found = await db.query("SELECT id FROM vehiculos WHERE tenant_id=$1 AND id=$2", [tenant, vehicle]);
  if (!found.rows.length) fail(400, "Elegí un móvil del mismo local.");
}

async function assertDriver(db, tenant, driver) {
  // Un jornal de un mes anterior puede corresponder a un chofer hoy inactivo.
  const found = await db.query("SELECT id FROM employees WHERE tenant_id=$1 AND id=$2 AND is_driver=true", [tenant, driver]);
  if (!found.rows.length) fail(400, "Elegí un chofer del mismo local.");
}

export function registerTrasladosResultadosRoutes(app, pool, requireRole) {
  const route = (fn) => [requireRole("admin"), async (req, res) => {
    try {
      if (!req.tenantId) fail(403, "No tenant context");
      await fn(req, res);
    } catch (e) {
      if (!sendTrasladoError(res, e)) { console.error(e); res.status(500).json({ message: "No se pudieron consultar o guardar los resultados de Bandimóviles." }); }
    }
  }];
  app.get("/v2/traslados/resultados", ...route(async (req, res) => {
    const q = parse(rango, req.query);
    const data = await transaction(pool, async (db) => {
      await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      return resultadosEnPeriodo(db, req.tenantId, q);
    });
    res.json(data);
  }));
  app.put("/v2/traslados/resultados/categorias", ...route(async (req, res) => {
    const { ids } = parse(z.object({ ids: z.array(uuid).max(100) }).strict(), req.body);
    if (new Set(ids).size !== ids.length) fail(400, "No repitas categorías.");
    await transaction(pool, async (db) => {
      await db.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [req.tenantId]);
      const found = await db.query("SELECT id FROM expense_categories WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [req.tenantId, ids]);
      if (found.rows.length !== ids.length) fail(400, "Elegí categorías del mismo local.");
      await db.query("INSERT INTO traslado_resultado_ajustes(tenant_id) VALUES($1) ON CONFLICT(tenant_id) DO UPDATE SET updated_at=now()", [req.tenantId]);
      await db.query("DELETE FROM traslado_resultado_categorias WHERE tenant_id=$1", [req.tenantId]);
      for (const id of ids) await db.query("INSERT INTO traslado_resultado_categorias(tenant_id,category_id) VALUES($1,$2)", [req.tenantId, id]);
    });
    res.json({ ids });
  }));
  app.put("/v2/traslados/resultados/condiciones/:id", ...route(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const body = parse(z.object({ configuracion_id: uuid, confirmar: z.literal(true) }).strict(), req.body);
    await transaction(pool, async (db) => {
      const { solicitud } = await lockSolicitud(db, req.tenantId, id);
      if (solicitud.origen === "historico") fail(409, "No se pueden completar condiciones desconocidas del histórico.");
      const existing = await db.query("SELECT configuracion_id FROM traslado_condiciones_revisadas WHERE tenant_id=$1 AND solicitud_id=$2", [req.tenantId, id]);
      if (existing.rows.length) {
        if (existing.rows[0].configuracion_id !== body.configuracion_id) fail(409, "El viaje ya tiene condiciones revisadas.");
        return;
      }
      const original = await db.query("SELECT modelo_pago FROM traslado_configuracion WHERE tenant_id=$1 AND id=$2", [req.tenantId, solicitud.configuracion_id]);
      if (original.rows[0]?.modelo_pago) fail(409, "El viaje ya conserva sus condiciones pactadas.");
      const cfg = await db.query("SELECT modelo_pago FROM traslado_configuracion WHERE tenant_id=$1 AND id=$2", [req.tenantId, body.configuracion_id]);
      if (!cfg.rows[0]?.modelo_pago) fail(400, "Elegí condiciones del mismo local con el pago al chofer definido.");
      await db.query("INSERT INTO traslado_condiciones_revisadas(tenant_id,solicitud_id,configuracion_id,registrado_por) VALUES($1,$2,$3,$4)", [req.tenantId, id, body.configuracion_id, req.user.sub]);
    });
    res.json({ revisado: true });
  }));
  app.post("/v2/traslados/resultados/revision-gastos", ...route(async (req, res) => {
    const body = parse(z.object({ from: fecha, to: fecha, revision: z.string().regex(/^[a-f0-9]{64}$/), confirmar: z.literal(true) }).strict(), req.body);
    const q = parse(rango, { from: body.from, to: body.to });
    await transaction(pool, async (db) => {
      await db.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [req.tenantId]);
      const c = await costData(db, req.tenantId, q);
      if (!c.configurado) fail(409, "Primero elegí las categorías de gastos.");
      if (c.revision !== body.revision) fail(409, "Los gastos cambiaron. Volvé a revisar el mes.");
      await db.query(`INSERT INTO traslado_revision_costos(tenant_id,periodo,revision,registrado_por) VALUES($1,$2,$3,$4)
        ON CONFLICT(tenant_id,periodo) DO UPDATE SET revision=EXCLUDED.revision,registrado_por=EXCLUDED.registrado_por,created_at=now()`,
      [req.tenantId, `${q.from.slice(0, 7)}-01`, c.revision, req.user.sub]);
    });
    res.json({ confirmado: true });
  }));
  app.put("/v2/traslados/resultados/gastos/:tipo/:id", ...route(async (req, res) => {
    const tipo = parse(z.enum(["diario", "fijo"]), req.params.tipo), id = parse(uuid, req.params.id);
    const input = parse(z.object({ vehiculo_id: uuid.nullable(), revision }).strict(), req.body);
    const column = tipo === "diario" ? "daily_expense_id" : "fixed_charge_id";
    const table = tipo === "diario" ? "daily_expenses" : "fixed_expense_charges";
    const saved = await transaction(pool, async (db) => {
      const source = await db.query(`SELECT id FROM ${table} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [req.tenantId, id]);
      if (!source.rows.length) fail(404, "Gasto no encontrado.");
      await assertVehicle(db, req.tenantId, input.vehiculo_id);
      const current = await db.query(`SELECT xmin::text AS revision FROM traslado_gasto_asignaciones WHERE tenant_id=$1 AND ${column}=$2`, [req.tenantId, id]);
      if ((current.rows[0]?.revision || null) !== input.revision) fail(409, "La asignación cambió. Volvé a cargar.");
      if (!input.vehiculo_id) {
        await db.query(`DELETE FROM traslado_gasto_asignaciones WHERE tenant_id=$1 AND ${column}=$2`, [req.tenantId, id]); return null;
      }
      const data = await db.query(`INSERT INTO traslado_gasto_asignaciones(tenant_id,${column},vehiculo_id) VALUES($1,$2,$3)
        ON CONFLICT(tenant_id,${column}) DO UPDATE SET vehiculo_id=EXCLUDED.vehiculo_id RETURNING *,xmin::text AS revision`, [req.tenantId, id, input.vehiculo_id]);
      return data.rows[0];
    });
    res.json(saved);
  }));
  app.put("/v2/traslados/resultados/repartos/:id", ...route(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const body = parse(z.object({ revision, items: z.array(z.object({ vehiculo_id: uuid, porcentaje: importe.refine((n) => n > 0 && n <= 100) }).strict()).max(10) }).strict(), req.body);
    if (body.items.length && (new Set(body.items.map((p) => p.vehiculo_id)).size !== body.items.length || body.items.reduce((s, p) => s + Math.round(p.porcentaje * 100), 0) !== 10000)) fail(400, "El reparto debe sumar 100% sin repetir móviles.");
    await transaction(pool, async (db) => {
      const { solicitud } = await lockSolicitud(db, req.tenantId, id);
      if (solicitud.origen === "historico") fail(409, "El histórico conserva sus asignaciones desconocidas.");
      const allowed = solicitud.tramos.filter((t) => t.estado !== "cancelado").map((t) => t.vehiculo_id);
      if (body.items.some((i) => !allowed.includes(i.vehiculo_id))) fail(400, "Repartí únicamente entre los móviles asignados al viaje.");
      const current = await db.query("SELECT id,xmin::text AS revision FROM traslado_repartos WHERE tenant_id=$1 AND solicitud_id=$2", [req.tenantId, id]);
      if ((current.rows[0]?.revision || null) !== body.revision) fail(409, "El reparto cambió. Volvé a cargar.");
      // Reemplazar la cabecera genera una revisión nueva incluso si las dos
      // escrituras ocurren en el mismo milisegundo.
      await db.query("DELETE FROM traslado_repartos WHERE tenant_id=$1 AND solicitud_id=$2", [req.tenantId, id]);
      if (body.items.length) {
        const result = await db.query("INSERT INTO traslado_repartos(tenant_id,solicitud_id) VALUES($1,$2) RETURNING id", [req.tenantId, id]);
        for (const item of body.items) await db.query("INSERT INTO traslado_reparto_items(tenant_id,reparto_id,vehiculo_id,porcentaje) VALUES($1,$2,$3,$4)", [req.tenantId, result.rows[0].id, item.vehiculo_id, item.porcentaje]);
      }
    });
    res.json({ guardado: true });
  }));

  for (const [path, table, fields] of [
    ["costos-externos", "traslado_costos_externos", { concepto: z.string().trim().min(1).max(200), pagado_por: z.string().trim().min(1).max(100) }],
    ["jornadas", "traslado_jornadas", { chofer_id: uuid }],
  ]) {
    const fieldsSchema = z.object({ fecha, monto: importe.refine((n) => n > 0), vehiculo_id: uuid.nullable(), ...fields }).strict();
    app.post(`/v2/traslados/resultados/${path}`, ...route(async (req, res) => {
      const input = parse(fieldsSchema.extend({ id: uuid }), req.body);
      const data = await transaction(pool, async (db) => {
        await assertVehicle(db, req.tenantId, input.vehiculo_id);
        if (input.chofer_id) await assertDriver(db, req.tenantId, input.chofer_id);
        const columns = Object.keys(input), params = columns.map((c) => input[c]);
        const result = await db.query(`INSERT INTO ${table}(tenant_id,registrado_por,${columns.join(",")}) VALUES($1,$2,${params.map((_, i) => `$${i + 3}`).join(",")})
          ON CONFLICT(id) DO NOTHING RETURNING *,xmin::text AS revision`, [req.tenantId, req.user.sub, ...params]);
        if (result.rows.length) return result.rows[0];
        const existing = await db.query(`SELECT *,xmin::text AS revision,fecha::text FROM ${table} WHERE tenant_id=$1 AND id=$2`, [req.tenantId, input.id]);
        if (!existing.rows.length || existing.rows[0].anulado || columns.some((k) => String(existing.rows[0][k]) !== String(input[k]) && !(k === "monto" && Number(existing.rows[0][k]) === input[k]))) fail(409, "El identificador ya se usó para otro registro.");
        return existing.rows[0];
      });
      res.status(201).json(data);
    }));
    app.put(`/v2/traslados/resultados/${path}/:id`, ...route(async (req, res) => {
      const id = parse(uuid, req.params.id), input = parse(fieldsSchema.extend({ revision: z.string().regex(/^\d+$/), anulado: z.boolean() }), req.body);
      const saved = await transaction(pool, async (db) => {
        await assertVehicle(db, req.tenantId, input.vehiculo_id);
        if (input.chofer_id) await assertDriver(db, req.tenantId, input.chofer_id);
        const cols = Object.keys(input).filter((k) => k !== "revision");
        const result = await db.query(`UPDATE ${table} SET ${cols.map((c, i) => `${c}=$${i + 4}`).join(",")}
          WHERE tenant_id=$1 AND id=$2 AND xmin::text=$3 RETURNING *,xmin::text AS revision`, [req.tenantId, id, input.revision, ...cols.map((c) => input[c])]);
        if (!result.rows.length) {
          const exists = await db.query(`SELECT id FROM ${table} WHERE tenant_id=$1 AND id=$2`, [req.tenantId, id]);
          fail(exists.rows.length ? 409 : 404, "El registro cambió o no está disponible. Volvé a cargar.");
        }
        return result.rows[0];
      });
      res.json(saved);
    }));
  }
}
