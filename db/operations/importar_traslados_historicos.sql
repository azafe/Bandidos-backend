-- Parámetros: $1 local, $2 corte (2026-10-15), $3 usuario responsable,
-- $4 IDs exactos revisados, $5 revisión de sus datos originales.
-- Ejecutar dentro de la transacción de revisión; no es una migración automática.
WITH candidatos AS MATERIALIZED (
  SELECT a.* FROM agenda_turnos a
  WHERE a.tenant_id=$1 AND a.date <= $2::date AND a.date <= DATE '2026-10-15'
    AND a.traslado=true AND a.id=ANY($4::uuid[])
    AND NOT EXISTS (
      SELECT 1 FROM traslado_solicitudes s WHERE s.tenant_id=a.tenant_id AND s.turno_id=a.id
    )
  ORDER BY a.id FOR UPDATE OF a
), nuevas AS (
  INSERT INTO traslado_solicitudes(tenant_id,turno_id,origen,precio_total,bonificado,cancelado)
  SELECT a.tenant_id,a.id,'historico',
    CASE WHEN a.traslado_bonificado IS TRUE AND a.traslado_amount=0 THEN 0
      WHEN a.traslado_bonificado IS NOT TRUE AND a.traslado_amount>0 THEN a.traslado_amount
      ELSE NULL END,
    COALESCE(a.traslado_bonificado IS TRUE AND a.traslado_amount=0,false),
    a.status IN ('cancelled','no_show')
  FROM candidatos a
  ON CONFLICT(tenant_id,turno_id) DO NOTHING
  RETURNING id,tenant_id,turno_id
), tramos_creados AS (
  INSERT INTO traslados(tenant_id,solicitud_id,tipo,direccion,fecha_programada,estado)
  SELECT s.tenant_id,s.id,'ida_y_vuelta',a.traslado_direccion,a.date,NULL
  FROM nuevas s JOIN candidatos a ON a.tenant_id=s.tenant_id AND a.id=s.turno_id
  RETURNING id
), copias_creadas AS (
  INSERT INTO traslado_historicos(tenant_id,solicitud_id,turno_id,fecha,turno_status,
    pet_name,owner_name,monto,bonificado,direccion,revision_importacion,importado_por)
  SELECT s.tenant_id,s.id,a.id,a.date,a.status,a.pet_name,a.owner_name,
    a.traslado_amount,a.traslado_bonificado,a.traslado_direccion,$5,$3
  FROM nuevas s JOIN candidatos a ON a.tenant_id=s.tenant_id AND a.id=s.turno_id
  RETURNING solicitud_id
)
SELECT (SELECT count(*) FROM nuevas)::int AS solicitudes,
  (SELECT count(*) FROM tramos_creados)::int AS tramos,
  (SELECT count(*) FROM copias_creadas)::int AS copias_historicas;
