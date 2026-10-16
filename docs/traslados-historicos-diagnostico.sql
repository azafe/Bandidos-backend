-- Solo lectura. Corte autorizado: hasta el 15/10/2026 inclusive.
-- Los del 16/10 en adelante quedan fuera. Ejecutar después de estructura 025.
-- Presentar estos resultados y el INSERT propuesto antes de autorizar backfill.
-- No se conoce aún la cantidad de filas reales; este archivo no importa nada.
-- Reemplazá NULL por el UUID del local autorizado. Sin ese dato no devuelve
-- filas y el resultado no sirve como conteo previo a una importación.
WITH local_objetivo AS (SELECT NULL::uuid AS tenant_id)
SELECT a.tenant_id,
       a.status,
       COUNT(*) AS turnos_sin_registro_propio,
       COUNT(*) FILTER (WHERE a.traslado_amount > 0) AS con_importe,
       COUNT(*) FILTER (WHERE a.traslado_amount = 0 AND a.traslado_bonificado IS NOT TRUE) AS ceros_sin_bonificacion_confirmada,
       COUNT(*) FILTER (WHERE a.traslado_bonificado IS TRUE) AS bonificados_confirmados
FROM agenda_turnos a
WHERE a.tenant_id = (SELECT tenant_id FROM local_objetivo)
  AND a.traslado = true
  AND a.date <= DATE '2026-10-15'
  AND NOT EXISTS (
    SELECT 1 FROM traslado_solicitudes s
    WHERE s.tenant_id = a.tenant_id AND s.turno_id = a.id
  )
GROUP BY a.tenant_id, a.status
ORDER BY a.tenant_id, a.status;
