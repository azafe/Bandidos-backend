// Solo las cuentas generales reciben avisos de Agenda. Las suscripciones sin
// responsable se vinculan nuevamente cuando su usuario abre el panel.
export async function tenantPushAudience(db, tenantId) {
  return db.query(
    `SELECT p.device_id,p.endpoint,p.p256dh,p.auth FROM push_subscriptions p
     JOIN users u ON u.id=p.user_id AND u.tenant_id=p.tenant_id
     WHERE p.tenant_id=$1 AND u.chofer_id IS NULL AND u.employee_id IS NULL`,
    [tenantId],
  );
}
