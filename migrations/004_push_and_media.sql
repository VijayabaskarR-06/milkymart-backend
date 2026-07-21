-- Push notification device registry and uploaded media bookkeeping.

CREATE TABLE IF NOT EXISTS device_tokens (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT UNIQUE NOT NULL,
  platform   TEXT NOT NULL DEFAULT 'android',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);

-- Where a product image lives once it is uploaded to object storage.
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_public_id TEXT;
