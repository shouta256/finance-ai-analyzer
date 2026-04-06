-- Safepocket bootstrap data
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

-- 1-user-1-item (Phase1). item_id unique for potential multi-link future.
CREATE TABLE IF NOT EXISTS plaid_items (
    user_id uuid PRIMARY KEY REFERENCES users(id),
    item_id text NOT NULL UNIQUE,
    encrypted_access_token text NOT NULL,
    linked_at timestamptz NOT NULL DEFAULT now()
);

-- Chat messages (simple conversation storage). A conversation groups messages by conversation_id.
CREATE TABLE IF NOT EXISTS chat_messages (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id),
    role text NOT NULL CHECK (role IN ('USER','ASSISTANT')),
    content text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_messages_conversation_idx ON chat_messages(conversation_id, created_at);

-- Demo rows are generated at seed time from shared/demo/demo-profile.json.
