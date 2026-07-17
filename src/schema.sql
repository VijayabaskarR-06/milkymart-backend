-- Milky Mart schema. Safe to run repeatedly (idempotent-ish for a demo).

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  role          TEXT NOT NULL DEFAULT 'customer',      -- 'customer' | 'rider'
  phone         TEXT NOT NULL,
  name          TEXT NOT NULL,
  wallet_balance NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (role, phone)
);

CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  size        TEXT NOT NULL,
  price       NUMERIC(10,2) NOT NULL,
  mrp         NUMERIC(10,2),
  image       TEXT,
  badge       TEXT,
  description TEXT,
  category    TEXT NOT NULL DEFAULT 'Milk',
  stock       INTEGER NOT NULL DEFAULT 100,
  active      BOOLEAN NOT NULL DEFAULT true,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS addresses (
  id       SERIAL PRIMARY KEY,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label    TEXT NOT NULL,
  detail   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  phone        TEXT,
  status       TEXT NOT NULL DEFAULT 'Confirmed',      -- Confirmed|Packed|Out for delivery|Delivered|Cancelled
  total        NUMERIC(10,2) NOT NULL DEFAULT 0,
  item_count   INTEGER NOT NULL DEFAULT 0,
  items        JSONB NOT NULL DEFAULT '[]',
  address      TEXT,
  slot         TEXT,
  payment      TEXT,
  date         TEXT,
  rider_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  amount     NUMERIC(10,2) NOT NULL,
  type       TEXT NOT NULL,                              -- 'credit' | 'debit'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT,
  unread     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admins (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT 'Administrator'
);

CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id);
