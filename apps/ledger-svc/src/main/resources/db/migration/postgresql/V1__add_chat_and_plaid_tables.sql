-- Flyway migration: Add plaid_items and chat_messages tables (initial)
CREATE TABLE IF NOT EXISTS plaid_items (
    user_id uuid PRIMARY KEY REFERENCES users(id),
    item_id text NOT NULL,
    UNIQUE (user_id, item_id),
    encrypted_access_token text NOT NULL,
    linked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id uuid PRIMARY KEY,
    conversation_id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id),
    role text NOT NULL CHECK (role IN ('USER','ASSISTANT')),
    content text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_conversation_idx ON chat_messages(conversation_id, created_at);
