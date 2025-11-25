-- Core schema to bootstrap empty databases before feature-specific migrations.
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

CREATE INDEX IF NOT EXISTS idx_transactions_user_occurred_at ON transactions(user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_transactions_account_occurred_at ON transactions(account_id, occurred_at);
