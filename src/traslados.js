import { CONFIGURABLE_ROLES } from "./permissions.js";
import { z } from "zod";

const id = z.string().uuid();
const text = z.string().trim().max(2000).nullable();
const money = z
  .number()
  .finite()
  .min(0)
  .max(9999999999.99)
  .refine(
    (v) => Math.abs(v * 100 - Math.round(v * 100)) < 0.0001,
    "Usá hasta dos decimales.",
  );
const date = z.string().date();
export const tramoSchema = z
  .object({
    tipo: z.enum(["busqueda", "entrega"]),
    chofer_id: id.nullable().default(null),
    vehiculo_id: id.nullable().default(null),
    zona_id: id.nullable().default(null),
    direccion: text.default(null),
    fecha_programada: date.optional(),
    hora_programada: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .nullable()
      .default(null),
    estado: z
      .enum(["pendiente", "en_camino", "retirado", "entregado", "cancelado"])
      .default("pendiente"),
    notas: text.default(null),
  })
  .strict();
export const solicitudSchema = z
  .object({
    precio_total: money.nullable(),
    bonificado: z.boolean(),
    notas: text.default(null),
    tramos: z.array(tramoSchema).min(1).max(2),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.tramos.map((t) => t.tipo)).size !== value.tramos.length)
      ctx.addIssue({
        code: "custom",
        path: ["tramos"],
        message: "No repitas el mismo tramo.",
      });
    if (value.bonificado ? value.precio_total !== 0 : value.precio_total === 0)
      ctx.addIssue({
        code: "custom",
        path: ["precio_total"],
        message:
          "Cargá un precio positivo, dejalo pendiente o marcá Bonificado con cero.",
      });
    if (value.tramos.every((t) => t.estado === "cancelado"))
      ctx.addIssue({
        code: "custom",
        path: ["tramos"],
        message: "Debe quedar al menos un tramo activo.",
      });
  });
const vehicleSchema = z
  .object({
    nombre: z.string().trim().min(1).max(100),
    patente: z
      .string()
      .trim()
      .min(1)
      .max(20)
      .transform((s) => s.toUpperCase()),
    propietario: text.default(null),
    activo: z.boolean().default(true),
  })
  .strict();
const zoneSchema = z
  .object({
    nombre: z.string().trim().min(1).max(100),
    tarifa: money.nullable().default(null),
    activo: z.boolean().default(true),
  })
  .strict();
const configSchema = z
  .object({
    modelo_pago: z.enum(["ninguno", "porcentaje", "jornal"]).nullable(),
    valor_pago: money.nullable(),
    costo_referencia: money.nullable(),
    unidad_referencia: z.enum(["dia", "traslado"]).nullable(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      (v.modelo_pago === null && v.valor_pago !== null) ||
      (v.modelo_pago === "ninguno" && v.valor_pago !== 0) ||
      (v.modelo_pago === "porcentaje" &&
        (v.valor_pago === null || v.valor_pago > 100)) ||
      (v.modelo_pago === "jornal" && !(v.valor_pago > 0))
    )
      ctx.addIssue({
        code: "custom",
        path: ["valor_pago"],
        message: "Revisá el valor según el modelo de pago.",
      });
    if ((v.costo_referencia === null) !== (v.unidad_referencia === null))
      ctx.addIssue({
        code: "custom",
        path: ["costo_referencia"],
        message: "Completá costo y unidad de referencia juntos.",
      });
  });
const cobroSchema = z
  .object({
    fecha: date,
    cobrado_por: z.enum(["chofer", "local"]),
    chofer_id: id.nullable(),
    payment_method_id: id,
  })
  .strict()
  .refine((v) => (v.cobrado_por === "chofer") === (v.chofer_id !== null), {
    message: "Elegí el chofer que cobró, o local sin chofer.",
    path: ["chofer_id"],
  });

export class TrasladoError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function fail(status, message) {
  throw new TrasladoError(status, message);
}
function parse(schema, input) {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    fail(
      400,
      parsed.error.issues
        .filter((i) => i.code === "custom")
        .map((i) => i.message)
        .join(" ") || "Revisá los campos requeridos y el formato de los datos.",
    );
  return parsed.data;
}
export function sendTrasladoError(res, error) {
  if (error instanceof TrasladoError) {
    res.status(error.status).json({ message: error.message });
    return true;
  }
  if (["23001", "23503", "23505", "23514"].includes(error.code)) {
    res.status(409).json({
      message:
        "El registro está vinculado, ya existe o tiene datos incompatibles. Revisá los datos antes de guardar.",
    });
    return true;
  }
  return false;
}
export function applySolicitudSummary(data) {
  if (!data.traslado_solicitud) return;
  const s = data.traslado_solicitud;
  data.traslado = true;
  data.traslado_amount = s.precio_total ?? 0;
  data.traslado_bonificado = s.bonificado;
  data.traslado_direccion =
    s.tramos
      .filter((t) => t.estado !== "cancelado")
      .map((t) => t.direccion)
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(" / ") || null;
}
export async function transaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
export async function loadSolicitud(db, tenant, solicitudId) {
  const { rows } = await db.query(
    "SELECT * FROM traslado_solicitudes WHERE tenant_id = $1 AND id = $2",
    [tenant, solicitudId],
  );
  if (!rows.length) fail(404, "Traslado no encontrado.");
  const [tramos, cobros] = await Promise.all([
    db.query(
      "SELECT * FROM traslados WHERE tenant_id = $1 AND solicitud_id = $2 ORDER BY tipo",
      [tenant, solicitudId],
    ),
    db.query(
      "SELECT * FROM traslado_cobros WHERE tenant_id = $1 AND solicitud_id = $2",
      [tenant, solicitudId],
    ),
  ]);
  const historico = rows[0].origen === "historico"
    ? await db.query("SELECT * FROM traslado_historicos WHERE tenant_id=$1 AND solicitud_id=$2", [tenant, solicitudId])
    : null;
  return { ...rows[0], tramos: tramos.rows, cobro: cobros.rows[0] || null, ...(historico ? { historico: historico.rows[0] || null } : {}) };
}
async function lockTurno(db, tenant, turnoId) {
  const { rows } = await db.query(
    "SELECT * FROM agenda_turnos WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
    [turnoId, tenant],
  );
  if (!rows.length) fail(404, "Turno no encontrado.");
  return rows[0];
}
export async function lockSolicitud(db, tenant, solicitudId) {
  const found = await db.query(
    "SELECT turno_id FROM traslado_solicitudes WHERE tenant_id = $1 AND id = $2",
    [tenant, solicitudId],
  );
  if (!found.rows.length) fail(404, "Traslado no encontrado.");
  // Todas las escrituras bloquean primero el turno y después la solicitud.
  // Mantener ese orden evita interbloqueos entre Agenda y el registro de cobro.
  const turno = await lockTurno(db, tenant, found.rows[0].turno_id);
  await db.query(
    "SELECT id FROM traslado_solicitudes WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
    [tenant, solicitudId],
  );
  return { turno, solicitud: await loadSolicitud(db, tenant, solicitudId) };
}
async function reference(db, tenant, table, ref, previous, condition = "") {
  if (!ref || ref === previous) return;
  const found = await db.query(
    `SELECT id FROM ${table} WHERE tenant_id = $1 AND id = $2 ${condition}`,
    [tenant, ref],
  );
  if (!found.rows.length)
    fail(
      400,
      "Elegí referencias activas del mismo local (chofer, vehículo, zona o medio de pago).",
    );
}
function checkPrice(s, finished) {
  if (finished && !s.bonificado && !(s.precio_total > 0))
    fail(
      400,
      "Cargá el precio total del traslado o marcá Bonificado antes de finalizar.",
    );
}
const transitions = {
  pendiente: ["pendiente", "en_camino", "cancelado"],
  en_camino: ["en_camino", "retirado", "cancelado"],
  retirado: ["retirado", "entregado"],
  entregado: ["entregado"],
  cancelado: ["cancelado", "pendiente"],
};
export async function saveSolicitud(db, tenant, turno, input, previous = null) {
  if (previous?.origen === "historico") fail(409, "El traslado importado conserva su historia y no se edita como un viaje pendiente.");
  const value = parse(solicitudSchema, input);
  checkPrice(value, turno.status === "finished");
  if (previous?.cancelado)
    fail(409, "La solicitud está cancelada. Conservá su historia.");
  if (
    previous?.cobro &&
    (Number(previous.precio_total) !== value.precio_total ||
      previous.bonificado !== value.bonificado)
  )
    fail(
      409,
      "El traslado ya fue cobrado: no se puede cambiar su precio ni bonificarlo.",
    );
  for (const t of value.tramos) {
    const old = previous?.tramos.find((r) => r.tipo === t.tipo);
    if (
      old?.estado === "entregado" &&
      [
        "chofer_id",
        "vehiculo_id",
        "zona_id",
        "direccion",
        "fecha_programada",
        "hora_programada",
      ].some((key) => (tramoInput(old)[key] ?? null) !== (t[key] ?? null))
    )
      fail(
        409,
        "Un tramo entregado conserva sus asignaciones y horario históricos.",
      );
    if (!transitions[old?.estado || "pendiente"]?.includes(t.estado))
      fail(409, "El cambio de estado del tramo no es válido.");
    if (
      previous?.cobro &&
      t.estado === "cancelado" &&
      old?.estado !== "cancelado"
    )
      fail(
        409,
        "No se puede cancelar un traslado cobrado sin resolver antes el cobro.",
      );
    if (
      ["en_camino", "retirado", "entregado"].includes(t.estado) &&
      (!t.direccion || !t.chofer_id || !t.vehiculo_id)
    )
      fail(400, "Antes de salir, cargá dirección, chofer y vehículo.");
    await reference(
      db,
      tenant,
      "employees",
      t.chofer_id,
      old?.chofer_id,
      "AND is_driver = true AND status = 'active'",
    );
    await reference(
      db,
      tenant,
      "vehiculos",
      t.vehiculo_id,
      old?.vehiculo_id,
      "AND activo = true",
    );
    await reference(
      db,
      tenant,
      "traslado_zonas",
      t.zona_id,
      old?.zona_id,
      "AND activo = true",
    );
  }
  for (const old of previous?.tramos || []) {
    if (
      !value.tramos.some((t) => t.tipo === old.tipo) &&
      old.estado !== "cancelado" &&
      (previous.cobro || old.estado !== "pendiente")
    )
      fail(409, "No se puede quitar un tramo en curso, completado o cobrado.");
  }
  let solicitudId = previous?.id;
  if (!solicitudId) {
    const config = await db.query(
      "SELECT id FROM traslado_configuracion WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1",
      [tenant],
    );
    const created = await db.query(
      `INSERT INTO traslado_solicitudes(tenant_id, turno_id, precio_total, bonificado, configuracion_id, notas)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
      [
        tenant,
        turno.id,
        value.precio_total,
        value.bonificado,
        config.rows[0]?.id || null,
        value.notas,
      ],
    );
    solicitudId = created.rows[0].id;
  } else {
    await db.query(
      "UPDATE traslado_solicitudes SET precio_total = $3, bonificado = $4, notas = $5, updated_at = now() WHERE tenant_id = $1 AND id = $2",
      [tenant, solicitudId, value.precio_total, value.bonificado, value.notas],
    );
  }
  for (const t of value.tramos) {
    await db.query(
      `INSERT INTO traslados(tenant_id,solicitud_id,tipo,chofer_id,vehiculo_id,zona_id,direccion,fecha_programada,hora_programada,estado,notas)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(tenant_id,solicitud_id,tipo) DO UPDATE SET chofer_id=EXCLUDED.chofer_id,vehiculo_id=EXCLUDED.vehiculo_id,
      zona_id=EXCLUDED.zona_id,direccion=EXCLUDED.direccion,fecha_programada=EXCLUDED.fecha_programada,hora_programada=EXCLUDED.hora_programada,
      orden_ruta=CASE WHEN (traslados.chofer_id,traslados.vehiculo_id,traslados.fecha_programada)
        IS DISTINCT FROM (EXCLUDED.chofer_id,EXCLUDED.vehiculo_id,EXCLUDED.fecha_programada)
        THEN NULL ELSE traslados.orden_ruta END,
      estado=EXCLUDED.estado,notas=EXCLUDED.notas,updated_at=now()`,
      [
        tenant,
        solicitudId,
        t.tipo,
        t.chofer_id,
        t.vehiculo_id,
        t.zona_id,
        t.direccion,
        t.fecha_programada || turno.date,
        t.hora_programada,
        t.estado,
        t.notas,
      ],
    );
  }
  await db.query(
    "UPDATE traslados SET estado = 'cancelado', updated_at = now() WHERE tenant_id = $1 AND solicitud_id = $2 AND NOT(tipo = ANY($3::text[])) AND estado = 'pendiente'",
    [tenant, solicitudId, value.tramos.map((t) => t.tipo)],
  );
  const summary = { traslado_solicitud: value };
  applySolicitudSummary(summary);
  await db.query(
    "UPDATE agenda_turnos SET traslado = true, traslado_amount = $3, traslado_bonificado = $4, traslado_direccion = $5 WHERE id = $1 AND tenant_id = $2",
    [
      turno.id,
      tenant,
      summary.traslado_amount,
      summary.traslado_bonificado,
      summary.traslado_direccion,
    ],
  );
  return loadSolicitud(db, tenant, solicitudId);
}
async function cancelSolicitud(db, tenant, turno, previous) {
  if (previous.origen === "historico") fail(409, "El traslado importado conserva su historia; no se cancela como un viaje nuevo.");
  if (
    previous.cobro ||
    previous.tramos.some((t) => !["pendiente", "cancelado"].includes(t.estado))
  )
    fail(
      409,
      "El traslado está en curso, completado o cobrado. No se puede cancelar ni borrar su historia.",
    );
  await db.query(
    "UPDATE traslados SET estado = 'cancelado', updated_at = now() WHERE tenant_id = $1 AND solicitud_id = $2 AND estado = 'pendiente'",
    [tenant, previous.id],
  );
  await db.query(
    "UPDATE traslado_solicitudes SET cancelado = true, updated_at = now() WHERE tenant_id = $1 AND id = $2",
    [tenant, previous.id],
  );
  await db.query(
    "UPDATE agenda_turnos SET traslado = false, traslado_amount = 0, traslado_bonificado = false WHERE id = $1 AND tenant_id = $2",
    [turno.id, tenant],
  );
  return loadSolicitud(db, tenant, previous.id);
}
export async function syncAgendaTraslado(
  db,
  tenant,
  turno,
  changes,
  { isNew = false, previousTurno = null } = {},
) {
  const rows = await db.query(
    "SELECT id FROM traslado_solicitudes WHERE tenant_id = $1 AND turno_id = $2 FOR UPDATE",
    [tenant, turno.id],
  );
  const previous = rows.rows[0]
    ? await loadSolicitud(db, tenant, rows.rows[0].id)
    : null;
  if (previous?.origen === "historico") {
    // Las notas del grooming pueden corregirse sin reescribir la copia del
    // traslado ni sus importes. Las correcciones históricas requieren revisión.
    const protectedFields = ["traslado", "traslado_amount", "traslado_bonificado", "traslado_direccion", "status", "date"];
    if (changes.traslado_solicitud || protectedFields.some((key) => {
      if (!Object.hasOwn(changes, key)) return false;
      return key === "traslado_amount" ? Number(changes[key]) !== Number(previousTurno?.[key])
        : changes[key] !== previousTurno?.[key];
    })) fail(409, "Este traslado ya se importó como histórico. Sus datos originales requieren una corrección revisada.");
    return previous;
  }
  if (!previous) {
    if (!turno.traslado) return null;
    if (isNew && ["cancelled", "no_show"].includes(turno.status))
      fail(409, "No agregues traslados a un turno cancelado o ausente.");
    if (!isNew && previousTurno?.traslado) {
      if (changes.traslado_solicitud)
        fail(
          409,
          "Este traslado es histórico. Su importación requiere revisión previa.",
        );
      return null;
    }
    const payload = changes.traslado_solicitud || {
      precio_total: turno.traslado_bonificado
        ? 0
        : Number(turno.traslado_amount) > 0
          ? Number(turno.traslado_amount)
          : null,
      bonificado: turno.traslado_bonificado === true,
      tramos: ["busqueda", "entrega"].map((tipo) => ({
        tipo,
        direccion: turno.traslado_direccion || null,
      })),
    };
    return saveSolicitud(db, tenant, turno, payload);
  }
  if (
    ["cancelled", "no_show"].includes(turno.status) ||
    changes.traslado === false
  )
    return cancelSolicitud(db, tenant, turno, previous);
  if (previous.cancelado) {
    if (turno.traslado)
      fail(
        409,
        "La solicitud está cancelada. No se puede reactivar desde los campos anteriores del turno.",
      );
    return previous;
  }
  if (
    !changes.traslado_solicitud &&
    Object.hasOwn(changes, "traslado_direccion") &&
    changes.traslado_direccion !== previousTurno?.traslado_direccion
  )
    fail(
      400,
      "Editá la dirección de cada tramo desde el detalle del traslado.",
    );
  const nextBonificado = changes.traslado_bonificado ?? previous.bonificado;
  const value = changes.traslado_solicitud || {
    precio_total: Object.hasOwn(changes, "traslado_amount")
      ? Number(changes.traslado_amount) > 0
        ? Number(changes.traslado_amount)
        : nextBonificado
          ? 0
          : null
      : previous.precio_total == null
        ? null
        : Number(previous.precio_total),
    bonificado: nextBonificado,
    notas: previous.notas,
    tramos: previous.tramos
      .filter((t) => t.estado !== "cancelado")
      .map(tramoInput),
  };
  // Los campos de dirección del legado son solo un resumen; no pisan dos
  // direcciones independientes al editar notas o finalizar el grooming.
  return saveSolicitud(db, tenant, turno, value, previous);
}
export function tramoInput(t) {
  return {
    tipo: t.tipo,
    chofer_id: t.chofer_id,
    vehiculo_id: t.vehiculo_id,
    zona_id: t.zona_id,
    direccion: t.direccion,
    fecha_programada: t.fecha_programada,
    hora_programada: t.hora_programada?.slice(0, 5) || null,
    estado: t.estado,
    notas: t.notas,
  };
}

// Una importación conserva la interpretación anterior y su fecha de referencia,
// sin inventar un recibo. Las operaciones nuevas usan la fecha del cobro real.
export async function cobradoEnPeriodo(db, tenant, from, to, cobrador = null) {
  const result = await db.query(
    `SELECT COALESCE(SUM(amount),0) AS amount FROM (
    SELECT c.monto AS amount FROM traslado_cobros c WHERE c.tenant_id=$1 AND c.fecha BETWEEN $2 AND $3 AND ($4::text IS NULL OR c.cobrado_por=$4)
    UNION ALL
    SELECT h.monto FROM traslado_historicos h WHERE h.tenant_id=$1 AND h.fecha BETWEEN $2 AND $3
    AND h.turno_status='finished' AND ($4::text IS NULL OR $4='chofer')
    UNION ALL
    SELECT a.traslado_amount FROM agenda_turnos a WHERE a.tenant_id=$1 AND a.date BETWEEN $2 AND $3
    AND a.status='finished' AND a.traslado=true AND ($4::text IS NULL OR $4='chofer')
    AND NOT EXISTS(SELECT 1 FROM traslado_solicitudes s WHERE s.tenant_id=a.tenant_id AND s.turno_id=a.id)
  ) receipts`,
    [tenant, from, to, cobrador],
  );
  return Number(result.rows[0].amount);
}
export async function cobrosDeCaja(db, tenant, from) {
  const result = await db.query(
    "SELECT payment_method_id, SUM(monto) AS total FROM traslado_cobros WHERE tenant_id=$1 AND fecha=$2 AND cobrado_por='local' GROUP BY payment_method_id",
    [tenant, from],
  );
  return result.rows;
}

export function registerTrasladosRoutes(app, pool, requireRole) {
  const route = (fn) => async (req, res) => {
    try {
      if (!req.tenantId) fail(403, "No tenant context");
      await fn(req, res);
    } catch (e) {
      if (!sendTrasladoError(res, e)) {
        console.error(e);
        res
          .status(500)
          .json({ message: "No se pudo guardar o consultar el traslado." });
      }
    }
  };
  const paramId = (req) => parse(id, req.params.id);
  for (const [path, table, schema, columns] of [
    [
      "vehiculos",
      "vehiculos",
      vehicleSchema,
      ["nombre", "patente", "propietario", "activo"],
    ],
    [
      "traslado-zonas",
      "traslado_zonas",
      zoneSchema,
      ["nombre", "tarifa", "activo"],
    ],
  ]) {
    app.get(
      `/v2/${path}`,
      route(async (req, res) => {
        const data = await pool.query(
          `SELECT * FROM ${table} WHERE tenant_id=$1 ORDER BY nombre`,
          [req.tenantId],
        );
        res.json(data.rows);
      }),
    );
    app.get(
      `/v2/${path}/:id`,
      route(async (req, res) => {
        const data = await pool.query(
          `SELECT * FROM ${table} WHERE tenant_id=$1 AND id=$2`,
          [req.tenantId, paramId(req)],
        );
        if (!data.rows.length) fail(404, "Registro no encontrado.");
        res.json(data.rows[0]);
      }),
    );
    app.post(
      `/v2/${path}`,
      requireRole("admin"),
      route(async (req, res) => {
        const value = parse(schema, req.body);
        const data = await pool.query(
          `INSERT INTO ${table}(tenant_id,${columns.join(",")}) VALUES($1,${columns.map((_, i) => `$${i + 2}`).join(",")}) RETURNING *`,
          [req.tenantId, ...columns.map((c) => value[c])],
        );
        res.status(201).json(data.rows[0]);
      }),
    );
    app.put(
      `/v2/${path}/:id`,
      requireRole("admin"),
      route(async (req, res) => {
        const value = parse(schema.partial().strict(), req.body);
        const keys = columns.filter((c) => Object.hasOwn(value, c));
        if (!keys.length) fail(400, "No hay cambios para guardar.");
        const data = await pool.query(
          `UPDATE ${table} SET ${keys.map((c, i) => `${c}=$${i + 3}`).join(",")},updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
          [req.tenantId, paramId(req), ...keys.map((c) => value[c])],
        );
        if (!data.rows.length) fail(404, "Registro no encontrado.");
        res.json(data.rows[0]);
      }),
    );
    app.delete(
      `/v2/${path}/:id`,
      requireRole("admin"),
      route(async (req, res) => {
        const data = await pool.query(
          `UPDATE ${table} SET activo=false,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
          [req.tenantId, paramId(req)],
        );
        if (!data.rows.length) fail(404, "Registro no encontrado.");
        res.json(data.rows[0]);
      }),
    );
  }
  app.get(
    "/v2/traslados/configuracion",
    requireRole("admin"),
    route(async (req, res) => {
      const result = await pool.query(
        "SELECT * FROM traslado_configuracion WHERE tenant_id=$1 ORDER BY version DESC LIMIT 1",
        [req.tenantId],
      );
      res.json(result.rows[0] || null);
    }),
  );
  app.put(
    "/v2/traslados/configuracion",
    requireRole("admin"),
    route(async (req, res) => {
      const v = parse(configSchema, req.body);
      const saved = await transaction(pool, async (db) => {
        await db.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [
          req.tenantId,
        ]);
        const result = await db.query(
          `INSERT INTO traslado_configuracion(tenant_id,version,modelo_pago,valor_pago,costo_referencia,unidad_referencia)
        SELECT $1,COALESCE(MAX(version),0)+1,$2,$3,$4,$5 FROM traslado_configuracion WHERE tenant_id=$1 RETURNING *`,
          [
            req.tenantId,
            v.modelo_pago,
            v.valor_pago,
            v.costo_referencia,
            v.unidad_referencia,
          ],
        );
        return result.rows[0];
      });
      res.json(saved);
    }),
  );
  app.get(
    "/v2/traslado-solicitudes/cobrados",
    route(async (req, res) => {
      const query = parse(
        z
          .object({ from: date, to: date })
          .refine((v) => v.from <= v.to, "Revisá el rango de fechas."),
        req.query,
      );
      res.json({
        amount: await cobradoEnPeriodo(
          pool,
          req.tenantId,
          query.from,
          query.to,
        ),
      });
    }),
  );
  app.get(
    "/v2/traslado-solicitudes",
    route(async (req, res) => {
      const q = parse(
        z.object({ turno_id: id.optional() }).strict(),
        req.query,
      );
      const rows = await pool.query(
        "SELECT id FROM traslado_solicitudes WHERE tenant_id=$1 AND ($2::uuid IS NULL OR turno_id=$2) ORDER BY created_at DESC",
        [req.tenantId, q.turno_id || null],
      );
      res.json(
        await Promise.all(
          rows.rows.map((r) => loadSolicitud(pool, req.tenantId, r.id)),
        ),
      );
    }),
  );
  app.get(
    "/v2/traslado-solicitudes/:id",
    route(async (req, res) =>
      res.json(await loadSolicitud(pool, req.tenantId, paramId(req))),
    ),
  );
  app.post(
    "/v2/traslado-solicitudes",
    route(async (req, res) => {
      const value = parse(
        z.object({ turno_id: id, solicitud: solicitudSchema }).strict(),
        req.body,
      );
      const result = await transaction(pool, async (db) => {
        const turno = await lockTurno(db, req.tenantId, value.turno_id);
        const found = await db.query(
          "SELECT id FROM traslado_solicitudes WHERE tenant_id=$1 AND turno_id=$2",
          [req.tenantId, turno.id],
        );
        if (found.rows.length)
          return saveSolicitud(
            db,
            req.tenantId,
            turno,
            value.solicitud,
            await loadSolicitud(db, req.tenantId, found.rows[0].id),
          );
        if (turno.traslado)
          fail(
            409,
            "Este traslado es histórico. Su importación requiere revisión previa.",
          );
        if (["cancelled", "no_show"].includes(turno.status))
          fail(409, "No agregues traslados a un turno cancelado o ausente.");
        return saveSolicitud(db, req.tenantId, turno, value.solicitud);
      });
      res.status(201).json(result);
    }),
  );
  app.put(
    "/v2/traslado-solicitudes/:id",
    route(async (req, res) => {
      const input = parse(solicitudSchema, req.body);
      const result = await transaction(pool, async (db) => {
        const { turno, solicitud } = await lockSolicitud(
          db,
          req.tenantId,
          paramId(req),
        );
        return saveSolicitud(db, req.tenantId, turno, input, solicitud);
      });
      res.json(result);
    }),
  );
  app.delete(
    "/v2/traslado-solicitudes/:id",
    route(async (req, res) => {
      const result = await transaction(pool, async (db) => {
        const { turno, solicitud } = await lockSolicitud(
          db,
          req.tenantId,
          paramId(req),
        );
        return cancelSolicitud(db, req.tenantId, turno, solicitud);
      });
      res.json(result);
    }),
  );
  app.post(
    "/v2/traslado-solicitudes/:id/cobro",
    requireRole("admin", "user", ...CONFIGURABLE_ROLES),
    route(async (req, res) => {
      const value = parse(cobroSchema, req.body);
      const result = await transaction(pool, async (db) => {
        const { turno, solicitud } = await lockSolicitud(
          db,
          req.tenantId,
          paramId(req),
        );
        if (solicitud.origen === "historico") fail(409, "El histórico no genera un cobro nuevo. Se conserva su tratamiento anterior.");
        if (
          solicitud.cancelado ||
          ["cancelled", "no_show"].includes(turno.status) ||
          solicitud.bonificado ||
          !(Number(solicitud.precio_total) > 0)
        )
          fail(
            409,
            "El traslado está cancelado, bonificado o sin precio: no se puede registrar un cobro.",
          );
        if (solicitud.cobro) {
          if (
            ["fecha", "cobrado_por", "chofer_id", "payment_method_id"].every(
              (k) => solicitud.cobro[k] === value[k],
            )
          )
            return solicitud.cobro;
          fail(409, "Ya hay un cobro registrado con otros datos.");
        }
        await reference(
          db,
          req.tenantId,
          "payment_methods",
          value.payment_method_id,
          null,
        );
        await reference(
          db,
          req.tenantId,
          "employees",
          value.chofer_id,
          null,
          "AND is_driver=true AND status='active'",
        );
        const saved = await db.query(
          `INSERT INTO traslado_cobros(tenant_id,solicitud_id,monto,fecha,cobrado_por,chofer_id,payment_method_id,registrado_por)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [
            req.tenantId,
            solicitud.id,
            solicitud.precio_total,
            value.fecha,
            value.cobrado_por,
            value.chofer_id,
            value.payment_method_id,
            req.user.sub,
          ],
        );
        return saved.rows[0];
      });
      res.json(result);
    }),
  );
  app.get(
    "/v2/traslados",
    route(async (req, res) => {
      const q = parse(
        z
          .object({
            from: date.optional(),
            to: date.optional(),
            chofer_id: id.optional(),
            vehiculo_id: id.optional(),
            turno_id: id.optional(),
          })
          .strict()
          .refine(
            (v) => !v.from || !v.to || v.from <= v.to,
            "Revisá el rango de fechas.",
          ),
        req.query,
      );
      const result = await pool.query(
        `SELECT t.*,s.turno_id FROM traslados t JOIN traslado_solicitudes s ON s.tenant_id=t.tenant_id AND s.id=t.solicitud_id
      WHERE t.tenant_id=$1 AND ($2::date IS NULL OR t.fecha_programada >= $2) AND ($3::date IS NULL OR t.fecha_programada <= $3)
      AND ($4::uuid IS NULL OR t.chofer_id=$4) AND ($5::uuid IS NULL OR t.vehiculo_id=$5) AND ($6::uuid IS NULL OR s.turno_id=$6)
      ORDER BY t.fecha_programada,t.hora_programada NULLS LAST,t.tipo`,
        [
          req.tenantId,
          q.from || null,
          q.to || null,
          q.chofer_id || null,
          q.vehiculo_id || null,
          q.turno_id || null,
        ],
      );
      res.json(result.rows);
    }),
  );
  app.get(
    "/v2/traslados/:id",
    route(async (req, res) => {
      const result = await pool.query(
        "SELECT * FROM traslados WHERE tenant_id=$1 AND id=$2",
        [req.tenantId, paramId(req)],
      );
      if (!result.rows.length) fail(404, "Tramo no encontrado.");
      res.json(result.rows[0]);
    }),
  );
  for (const method of ["post", "put", "delete"]) {
    app[method](
      method === "post" ? "/v2/traslados" : "/v2/traslados/:id",
      route(async (req, res) => {
        const result = await transaction(pool, async (db) => {
          let target, input;
          if (method === "post") {
            const parsed = parse(
              z.object({ solicitud_id: id, tramo: tramoSchema }).strict(),
              req.body,
            );
            target = parsed.solicitud_id;
            input = parsed.tramo;
          } else {
            const found = await db.query(
              "SELECT * FROM traslados WHERE tenant_id=$1 AND id=$2",
              [req.tenantId, paramId(req)],
            );
            if (!found.rows.length) fail(404, "Tramo no encontrado.");
            target = found.rows[0].solicitud_id;
            input =
              method === "delete"
                ? { ...tramoInput(found.rows[0]), estado: "cancelado" }
                : parse(tramoSchema, req.body);
            if (input.tipo !== found.rows[0].tipo)
              fail(400, "No se puede cambiar el tipo de un tramo existente.");
          }
          const { turno, solicitud } = await lockSolicitud(
            db,
            req.tenantId,
            target,
          );
          const tramos = solicitud.tramos
            .filter((t) => t.tipo !== input.tipo && t.estado !== "cancelado")
            .map(tramoInput);
          tramos.push(input);
          if (tramos.every((t) => t.estado === "cancelado"))
            return cancelSolicitud(db, req.tenantId, turno, solicitud);
          return saveSolicitud(
            db,
            req.tenantId,
            turno,
            {
              precio_total:
                solicitud.precio_total == null
                  ? null
                  : Number(solicitud.precio_total),
              bonificado: solicitud.bonificado,
              notas: solicitud.notas,
              tramos,
            },
            solicitud,
          );
        });
        res.json(result);
      }),
    );
  }
}
