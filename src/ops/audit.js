import { nowIso, redact } from './util.js';

// يسجل الحدث بعد إخفاء الأسرار والبيانات الشخصية
export function audit(db, { tenantId = null, userId = null, runId = null, event, tool = null, detail = {} }) {
  db.prepare('INSERT INTO audit_log (tenant_id, user_id, run_id, event, tool, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(tenantId, userId, runId, event, tool, JSON.stringify(redact(detail)), nowIso());
}

export function listAudit(db, tenantId, { limit = 100, runId } = {}) {
  const rows = runId
    ? db.prepare('SELECT * FROM audit_log WHERE tenant_id = ? AND run_id = ? ORDER BY id').all(tenantId, runId)
    : db.prepare('SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY id DESC LIMIT ?').all(tenantId, limit);
  return rows.map((r) => ({ ...r, detail: JSON.parse(r.detail || '{}') }));
}
