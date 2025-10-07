-- Embedded seed copied from scripts/sql/seed.sql (idempotent)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY,
    email text UNIQUE NOT NULL,
    full_name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    name text NOT NULL,
    institution text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS merchants (
    id uuid PRIMARY KEY,
    name text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    account_id uuid NOT NULL REFERENCES accounts(id),
    merchant_id uuid NOT NULL REFERENCES merchants(id),
    amount numeric(12,2) NOT NULL,
    currency char(3) NOT NULL DEFAULT 'USD',
    occurred_at timestamptz NOT NULL,
    authorized_at timestamptz,
    category text NOT NULL,
    description text,
    pending boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Minimal seed (subset of original) to avoid bloating production with demo data.
INSERT INTO users (id, email, full_name)
VALUES ('0f08d2b9-28b3-4b28-bd33-41a36161e9ab', 'demo@safepocket.app', 'Demo User')
ON CONFLICT (id) DO NOTHING;

INSERT INTO merchants (id, name) VALUES
    ('b5f6fcb0-4a2f-4a97-82bd-9f76c788f1e3', 'Amazon')
ON CONFLICT (id) DO NOTHING;

INSERT INTO accounts (id, user_id, name, institution) VALUES
('f27a9a4d-6a43-4726-8db1-43d2e8fa923a', '0f08d2b9-28b3-4b28-bd33-41a36161e9ab', 'Primary Checking', 'Sandbox')
ON CONFLICT (id) DO NOTHING;

INSERT INTO transactions (id, user_id, account_id, merchant_id, amount, occurred_at, authorized_at, category, description, pending)
VALUES ('1d0c0ab9-e8f5-4199-89cf-6bc6c703cbef', '0f08d2b9-28b3-4b28-bd33-41a36161e9ab', 'f27a9a4d-6a43-4726-8db1-43d2e8fa923a', 'b5f6fcb0-4a2f-4a97-82bd-9f76c788f1e3', -120.45, now() - interval '2 days', now() - interval '2 days', 'Shopping', 'Amazon order', false)
ON CONFLICT (id) DO NOTHING;
