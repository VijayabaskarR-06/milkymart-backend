-- Who-did-what for the admin panel: wallet credits, product edits, rider
-- approvals, order status overrides, password changes. admin_id is nullable
-- so a deleted admin's history isn't lost.

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id          SERIAL PRIMARY KEY,
  admin_id    INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  admin_email TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  meta        JSONB NOT NULL DEFAULT '{}',
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON admin_audit_log(created_at DESC);
