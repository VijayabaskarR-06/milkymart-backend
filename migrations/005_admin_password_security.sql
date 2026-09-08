-- Lets an admin change their own password, and makes a password change (or a
-- suspected compromise) actually invalidate every admin session, not just the
-- one that made the change.

ALTER TABLE admins ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
