import { z } from "zod";
import {
  TrasladoError, transaction, lockSolicitud, saveSolicitud, tramoInput,
  sendTrasladoError,
} from "./traslados.js";

const uuid = z.string().uuid();
const fecha = z.string().date();
const fail = (status, message) => { throw new TrasladoError(status, message); };
const parse = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) fail(400, "Revisá los campos y el formato de los datos.");
  return result.data;
};

// El vínculo se consulta en cada request. Un chofer inactivo conserva la
// restricción: desactivarlo nunca le devuelve los permisos generales de staff.
export function restrictDriverAccess(req, res, next) {
  if (!req.driverId) return next();
  const path = req.path.replace(/\/+$/, "");
  if (req.method === "GET" && path === "/me") return next();
  if (!req.driverActive) {
    return res.status(403).json({ message: "Tu acceso de chofer está inactivo. Contactá al administrador." });
  }
  if ((req.method === "GET" && path === "/v2/traslados/hoja-de-ruta") ||
      (req.method === "PATCH" && /^\/v2\/traslados\/[a-f\d-]+\/estado$/i.test(path))) {
    return next();
  }
  return res.status(403).json({ message: "Tu cuenta solo tiene acceso a tus traslados." });
}

export async function validateDriver(db, tenant, driverId) {
  if (!driverId) return;
  const found = await db.query(
    "SELECT id FROM employees WHERE tenant_id=$1 AND id=$2 AND is_driver=true AND status='active' FOR SHARE",
    [tenant, driverId],
  );
  if (!found.rows.length) fail(400, "Elegí un chofer activo del mismo local.");
}

export function registerTrasladosOperacionRoutes(app, pool, requireRole) {
  const route = (fn) => async (req, res) => {
    try {
      if (!req.tenantId) fail(403, "No tenant context");
      await fn(req, res);
    } catch (error) {
      if (!sendTrasladoError(res, error)) {
        console.error(error);
        res.status(500).json({ message: "No se pudo consultar o actualizar la hoja de ruta." });
      }
    }
  };

  app.get("/v2/traslados/hoja-de-ruta", route(async (req, res) => {
    const q = parse(z.object({
      fecha, chofer_id: uuid.optional(), vehiculo_id: uuid.optional(),
    }).strict(), req.query);
    if (req.driverId && q.chofer_id && q.chofer_id !== req.driverId)
      fail(403, "Solo podés consultar tus traslados.");
    const result = await pool.query(
      `SELECT t.id,t.tipo,t.chofer_id,t.vehiculo_id,t.direccion,
        t.fecha_programada,t.hora_programada,t.estado,t.notas,t.orden_ruta,t.updated_at,t.xmin::text AS revision,
        a.pet_name,a.owner_name,
        COALESCE(NULLIF(c.phone,''),NULLIF(p.owner_phone,'')) AS owner_phone,
        e.name AS chofer_nombre,v.nombre AS vehiculo_nombre,v.patente
       FROM traslados t
       JOIN traslado_solicitudes s ON s.tenant_id=t.tenant_id AND s.id=t.solicitud_id
       JOIN agenda_turnos a ON a.tenant_id=s.tenant_id AND a.id=s.turno_id
       LEFT JOIN employees e ON e.tenant_id=t.tenant_id AND e.id=t.chofer_id
       LEFT JOIN vehiculos v ON v.tenant_id=t.tenant_id AND v.id=t.vehiculo_id
       LEFT JOIN pets p ON p.tenant_id=a.tenant_id AND p.id=a.pet_id
       LEFT JOIN customers c ON c.tenant_id=p.tenant_id AND c.id=p.customer_id
       WHERE t.tenant_id=$1 AND t.fecha_programada=$2 AND NOT s.cancelado
         AND a.status NOT IN ('cancelled','no_show') AND t.estado <> 'cancelado'
         AND ($3::uuid IS NULL OR t.chofer_id=$3)
         AND ($4::uuid IS NULL OR t.vehiculo_id=$4)
       ORDER BY e.name NULLS LAST,v.nombre NULLS LAST,t.chofer_id,t.vehiculo_id,
         t.orden_ruta NULLS LAST,t.hora_programada NULLS LAST,t.created_at,t.id`,
      [req.tenantId, q.fecha, req.driverId || q.chofer_id || null, q.vehiculo_id || null],
    );
    let historicos = 0;
    let historial = [];
    if (!req.driverId) {
      const legacy = await pool.query(
        `SELECT count(*) AS count FROM agenda_turnos a WHERE a.tenant_id=$1 AND a.date=$2
        AND a.traslado=true AND a.status NOT IN ('cancelled','no_show')
        AND NOT EXISTS(SELECT 1 FROM traslado_solicitudes s WHERE s.tenant_id=a.tenant_id AND s.turno_id=a.id)`,
        [req.tenantId, q.fecha],
      );
      historicos = Number(legacy.rows[0].count);
      if (!q.chofer_id && !q.vehiculo_id) {
        const imported = await pool.query(
          "SELECT solicitud_id,turno_id,fecha,turno_status,pet_name,owner_name,monto,bonificado,direccion FROM traslado_historicos WHERE tenant_id=$1 AND fecha=$2 ORDER BY pet_name,turno_id",
          [req.tenantId, q.fecha],
        );
        historial = imported.rows;
      }
    }
    res.json({ items: result.rows, historicos_pendientes: historicos, historial });
  }));

  app.put("/v2/traslados/orden-ruta", requireRole("admin"), route(async (req, res) => {
    const input = parse(z.object({
      fecha, chofer_id: uuid, vehiculo_id: uuid,
      tramos: z.array(z.object({ id: uuid, revision: z.string().regex(/^\d+$/) }).strict()).min(1).max(500),
    }).strict(), req.body);
    if (new Set(input.tramos.map((t) => t.id)).size !== input.tramos.length)
      fail(400, "No repitas paradas en la ruta.");
    await transaction(pool, async (db) => {
      const current = await db.query(
        `SELECT t.id,t.xmin::text AS revision FROM traslados t
         JOIN traslado_solicitudes s ON s.tenant_id=t.tenant_id AND s.id=t.solicitud_id
         JOIN agenda_turnos a ON a.tenant_id=s.tenant_id AND a.id=s.turno_id
         WHERE t.tenant_id=$1 AND t.fecha_programada=$2 AND t.chofer_id=$3 AND t.vehiculo_id=$4
         AND t.estado <> 'cancelado' AND NOT s.cancelado AND a.status NOT IN ('cancelled','no_show')
         ORDER BY t.id FOR UPDATE OF t`,
        [req.tenantId, input.fecha, input.chofer_id, input.vehiculo_id],
      );
      // La revisión de PostgreSQL detecta cambios incluso dentro del mismo
      // milisegundo; updated_at serializado por JavaScript pierde esa precisión.
      const versions = new Map(current.rows.map((t) => [t.id, t.revision]));
      if (versions.size !== input.tramos.length || input.tramos.some((t) => versions.get(t.id) !== t.revision))
        fail(409, "La ruta cambió. Volvé a cargarla antes de ordenar.");
      for (const [index, t] of input.tramos.entries()) {
        await db.query("UPDATE traslados SET orden_ruta=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2", [req.tenantId, t.id, index + 1]);
      }
    });
    res.json({ ok: true });
  }));

  app.patch("/v2/traslados/:id/estado", route(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const input = parse(z.object({
      estado: z.enum(["en_camino", "retirado", "entregado"]),
      estado_anterior: z.enum(["pendiente", "en_camino", "retirado", "entregado"]),
    }).strict(), req.body);
    const updated = await transaction(pool, async (db) => {
      const found = await db.query(
        "SELECT solicitud_id FROM traslados WHERE tenant_id=$1 AND id=$2 AND ($3::uuid IS NULL OR chofer_id=$3)",
        [req.tenantId, id, req.driverId || null],
      );
      if (!found.rows.length) fail(404, "Tramo no encontrado.");
      const { turno, solicitud } = await lockSolicitud(db, req.tenantId, found.rows[0].solicitud_id);
      if (solicitud.origen === "historico") fail(409, "El histórico no es un traslado pendiente: su estado operativo no está registrado.");
      const target = solicitud.tramos.find((t) => t.id === id);
      // Revalidar después del bloqueo: la asignación puede haber cambiado.
      if (!target || (req.driverId && target.chofer_id !== req.driverId)) fail(404, "Tramo no encontrado.");
      if (solicitud.cancelado || ["cancelled", "no_show"].includes(turno.status)) fail(409, "El traslado está cancelado.");
      if (target.estado === input.estado) return target;
      if (target.estado !== input.estado_anterior) fail(409, "El estado cambió. Volvé a cargar tus traslados.");
      const saved = await saveSolicitud(db, req.tenantId, turno, {
        precio_total: solicitud.precio_total == null ? null : Number(solicitud.precio_total),
        bonificado: solicitud.bonificado, notas: solicitud.notas,
        tramos: solicitud.tramos.map((t) => ({ ...tramoInput(t), ...(t.id === id ? { estado: input.estado } : {}) })),
      }, solicitud);
      return saved.tramos.find((t) => t.id === id);
    });
    // La respuesta tampoco revela el otro tramo ni la información económica.
    res.json({ id: updated.id, estado: updated.estado, updated_at: updated.updated_at });
  }));

  app.put("/v2/users/:id/chofer", requireRole("admin"), route(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const { chofer_id } = parse(z.object({ chofer_id: uuid.nullable() }).strict(), req.body);
    if (id === req.user.sub) fail(400, "No cambies tu propio acceso desde esta opción.");
    const user = await transaction(pool, async (db) => {
      const found = await db.query("SELECT id,role FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [req.tenantId, id]);
      if (!found.rows.length) fail(404, "Usuario no encontrado.");
      if (chofer_id && !["staff", "user"].includes(found.rows[0].role)) fail(400, "Usá una cuenta de equipo para el acceso de chofer.");
      await validateDriver(db, req.tenantId, chofer_id);
      const result = await db.query(
        "UPDATE users SET chofer_id=$3 WHERE tenant_id=$1 AND id=$2 RETURNING id,email,role,chofer_id",
        [req.tenantId, id, chofer_id],
      );
      return result.rows[0];
    });
    res.json(user);
  }));
}
