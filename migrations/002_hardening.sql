-- Production hardening: idempotent order creation, session revocation,
-- and indexes for the queries the app and admin actually run.

-- Repeat submissions of the same checkout return the original order instead of
-- creating a duplicate (double-tap / retry safety).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency
  ON orders (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Bumping this invalidates every token already issued to the user (real logout).
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

-- Indexes for hot paths.
CREATE INDEX IF NOT EXISTS idx_orders_rider ON orders(rider_id);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_assigned_rider ON users(assigned_rider_id);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications(user_id) WHERE unread;
