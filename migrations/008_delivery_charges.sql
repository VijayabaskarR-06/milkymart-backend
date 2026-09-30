-- A rider deducts the price of delivered goods from a customer's wallet. Unlike
-- cash_collections this moves money immediately, so the row records who did it.
CREATE TABLE IF NOT EXISTS delivery_charges (
  id              SERIAL PRIMARY KEY,
  customer_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rider_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  rider_name      TEXT,
  amount          NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  note            TEXT,
  transaction_id  INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  idempotency_key TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_charge_customer ON delivery_charges(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_charge_rider ON delivery_charges(rider_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_charge_idempotency
  ON delivery_charges(rider_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
