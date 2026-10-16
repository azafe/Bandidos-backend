import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { TrasladoError, sendTrasladoError, transaction } from "./traslados.js";

export const CORTE_HISTORICOS = "2026-10-15";
export const SQL_IMPORTAR_HISTORICOS = await readFile(new URL("../db/operations/importar_traslados_historicos.sql", import.meta.url), "utf8");
export const SQL_REVISAR_HISTORICOS = `SELECT a.id,a.date,a.status,a.pet_name,a.owner_name,
  a.traslado_amount,a.traslado_bonificado,a.traslado_direccion
  FROM agenda_turnos a WHERE a.tenant_id=$1 AND a.date <= $2::date
  AND a.date <= DATE '2026-10-15' AND a.traslado=true
  AND NOT EXISTS(SELECT 1 FROM traslado_solicitudes s WHERE s.tenant_id=a.tenant_id AND s.turno_id=a.id)
  ORDER BY a.id`;

function revisionDe(rows) {
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
function resumenDe(rows) {
  return {
    cantidad: rows.length,
    solicitudes: rows.length, tramos: rows.length, copias_historicas: rows.length,
    con_importe: rows.filter((r) => Number(r.traslado_amount) > 0).length,
    bonificados_confirmados: rows.filter((r) => r.traslado_bonificado === true && Number(r.traslado_amount) === 0).length,
    ceros_sin_clasificar: rows.filter((r) => Number(r.traslado_amount) === 0 && r.traslado_bonificado !== true).length,
    importe_en_reportes: rows.reduce((sum, r) => sum + (r.status === "finished" ? Math.round(Number(r.traslado_amount || 0) * 100) : 0), 0) / 100,
    por_estado: Object.fromEntries([...new Set(rows.map((r) => r.status))].map((status) => [status, rows.filter((r) => r.status === status).length])),
  };
}
export function registerTrasladosHistoricosRoutes(app, pool, requireRole) {
  const route = (fn) => async (req, res) => {
    try {
      if (!req.tenantId) throw new TrasladoError(403, "No tenant context");
      await fn(req, res);
    } catch (error) {
      if (!sendTrasladoError(res, error)) {
        console.error(error);
        res.status(500).json({ message: "No se pudo revisar o importar el historial de traslados." });
      }
    }
  };
  app.get("/v2/traslados/historicos/revision", requireRole("admin"), route(async (req, res) => {
    const parsed = z.object({ hasta: z.literal(CORTE_HISTORICOS) }).strict().safeParse(req.query);
    if (!parsed.success) throw new TrasladoError(400, "El corte autorizado es el 15/10/2026 inclusive.");
    const { rows } = await pool.query(SQL_REVISAR_HISTORICOS, [req.tenantId, CORTE_HISTORICOS]);
    res.json({ hasta: CORTE_HISTORICOS, revision: revisionDe(rows), resumen: resumenDe(rows), items: rows,
      sql: SQL_IMPORTAR_HISTORICOS,
      parametros: { local: req.tenantId, corte: CORTE_HISTORICOS, responsable: req.user.sub, ids: rows.map((r) => r.id), revision: revisionDe(rows) },
    });
  }));
  app.post("/v2/traslados/historicos/importar", requireRole("admin"), route(async (req, res) => {
    const parsed = z.object({
      hasta: z.literal(CORTE_HISTORICOS), revision: z.string().regex(/^[a-f\d]{64}$/),
      cantidad: z.number().int().positive(), confirmar: z.literal(true),
    }).strict().safeParse(req.body);
    if (!parsed.success) throw new TrasladoError(400, "Revisá la cantidad y confirmá el corte al 15/10/2026.");
    const input = parsed.data;
    const result = await transaction(pool, async (db) => {
      await db.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [req.tenantId]);
      const previous = await db.query("SELECT count(*)::int AS cantidad FROM traslado_historicos WHERE tenant_id=$1 AND revision_importacion=$2", [req.tenantId, input.revision]);
      if (previous.rows[0].cantidad > 0) {
        if (previous.rows[0].cantidad !== input.cantidad) throw new TrasladoError(409, "La cantidad no coincide con la importación anterior.");
        return { solicitudes: input.cantidad, tramos: input.cantidad, copias_historicas: input.cantidad, repetida: true };
      }
      const { rows } = await db.query(`${SQL_REVISAR_HISTORICOS} FOR UPDATE OF a`, [req.tenantId, CORTE_HISTORICOS]);
      if (rows.length !== input.cantidad || revisionDe(rows) !== input.revision)
        throw new TrasladoError(409, "Los datos cambiaron. Volvé a revisar la cantidad y el SQL antes de confirmar.");
      const imported = await db.query(SQL_IMPORTAR_HISTORICOS, [req.tenantId, CORTE_HISTORICOS, req.user.sub, rows.map((r) => r.id), input.revision]);
      const counts = imported.rows[0];
      if ([counts.solicitudes, counts.tramos, counts.copias_historicas].some((n) => n !== input.cantidad))
        throw new TrasladoError(409, "Cambió el conjunto de traslados. No se guardó la importación; volvé a revisarla.");
      return { ...counts, repetida: false };
    });
    res.json({ hasta: CORTE_HISTORICOS, ...result });
  }));
}
