import { query } from './db.js'
import { log } from './logger.js'

// Records who-did-what in the admin panel — wallet credits, product edits,
// rider approvals, password changes. Read via GET /admin/audit-log. Logging
// must never break the request it's attached to, so failures are swallowed.
export async function recordAudit(req, action, { targetType = null, targetId = null, meta = {} } = {}) {
  try {
    await query(
      `INSERT INTO admin_audit_log (admin_id, admin_email, action, target_type, target_id, meta, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        req.admin?.id ?? null,
        req.admin?.email ?? null,
        action,
        targetType,
        targetId != null ? String(targetId) : null,
        JSON.stringify(meta),
        req.ip || null,
      ],
    )
  } catch (err) {
    log.error('audit.write_failed', { action, error: err.message })
  }
}
