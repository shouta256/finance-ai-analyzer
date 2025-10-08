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

INSERT INTO users (id, email, full_name)
VALUES
    ('0f08d2b9-28b3-4b28-bd33-41a36161e9ab', 'demo@safepocket.app', 'Demo User')
ON CONFLICT (id) DO NOTHING;

INSERT INTO accounts (id, user_id, name, institution)
VALUES
    ('f27a9a4d-6a43-4726-8db1-43d2e8fa923a', '0f08d2b9-28b3-4b28-bd33-41a36161e9ab', 'Primary Checking', 'Plaid Sandbox'),
    ('c4d6f30d-2f5e-4f81-a0a0-4f7839f87f9f', '0f08d2b9-28b3-4b28-bd33-41a36161e9ab', 'High-Yield Savings', 'Plaid Sandbox'),
    ('6b358bb2-7e8f-48d9-a7ff-8f4c6c39e4db', '0f08d2b9-28b3-4b28-bd33-41a36161e9ab', 'Rewards Credit Card', 'Plaid Sandbox')
ON CONFLICT (id) DO NOTHING;

INSERT INTO merchants (id, name)
VALUES
    ('b5f6fcb0-4a2f-4a97-82bd-9f76c788f1e3', 'Amazon'),
    ('53a84d41-4b84-4bb4-9894-be9bb4d15228', 'Whole Foods Market'),
    ('b9729dc5-88cc-4e1b-b1a2-3a6e3fdc0fb1', 'Starbucks'),
    ('96400b38-496e-4ffc-8c5a-6f9756ec9f75', 'Uber Technologies'),
    ('f18a8c9e-6f76-42e9-8f23-4a8dd099b3c1', 'Lyft'),
    ('c5179186-1a68-4851-8c92-8c7fd1a3e55d', 'Netflix'),
    ('2e8f0fa5-84ca-4aaa-836c-4b6cb7467e28', 'Spotify'),
    ('d9b28b50-2f16-4829-9f2c-9a5d4bb8ad58', 'Trader Joes'),
    ('f741c4f4-0328-4a86-8053-4642c4f3a2aa', 'Blue Bottle Coffee'),
    ('a9d7d023-74c0-4dc5-93ce-4ea1adbbef36', 'Airbnb'),
    ('6f40ce7a-767e-4a2d-8d64-b6c1f8ebd4f4', 'Delta Airlines'),
    ('8869124b-4d46-41a5-8fda-5928a5241ff3', 'Apple'),
    ('50b5e02c-999a-47ca-8067-04dd4e85e46b', 'Stripe Payroll'),
    ('4c6df5a8-cbb5-4fc1-b4ec-77fb25f9adf3', 'Local Rent Co'),
    ('f9b75f4f-d8c1-45c8-a7cb-a9a8610fdf73', 'Utility Power Co')
ON CONFLICT (id) DO NOTHING;

INSERT INTO transactions (id, user_id, account_id, merchant_id, amount, occurred_at, authorized_at, category, description, pending)
VALUES
    ('1d0c0ab9-e8f5-4199-89cf-6bc6c703cbef', '0f08d2b9-28b3-4b28-bd33-41a36161e9ab', 'f27a9a4d-6a43-4726-8db1-43d2e8fa923a', 'b5f6fcb0-4a2f-4a97-82bd-9f76c788f1e3', -120.45, now() - interval '2 days', now() - interval '2 days', 'Shopping', 'Amazon order', false),
    ('d35a8da1-9975-431b-90ff-2e9001792d06', '0f08d2b9-28b3-4b28-bd33-41a36161e9ab', 'f27a9a4d-6a43-4726-8db1-43d2e8fa923a', '53a84d41-4b84-4bb4-9894-be9bb4d15228', -168.20, date_trunc('day', now()) - interval '7 days', date_trunc('day', now()) - interval '7 days', 'Groceries', 'Whole Foods monthly stock-up', false),
    ('0b315630-10f8-4d54-a2f0-0a5eb0bc5727', '0f08d2b9-28b3-4b28-bd33-41a36161e9ab', 'f27a9a4d-6a43-4726-8db1-43d2e8fa923a', 'b9729dc5-88cc-4e1b-b1a2-3a6e3fdc0fb1', -18.75, now() - interval '1 days', now() - interval '1 days', 'Dining', 'Starbucks client catch up', false),
    ('28c8545d-4cb2-4dfb-9871-1d0dfa6f4aa0', '0f08d2b9-28b3-4b28-bd33-41a36161e9ab', 'f27a9a4d-6a43-4726-8db1-43d2e8fa923a', '96400b38-496e-4ffc-8c5a-6f9756ec9f75', -42.10, now() - interval '3 days', now() - interval '3 days', 'Transport', 'Uber to airport', false),
    ('50ada20f-124b-4b73-946b-4925d86a8aa5', '0f08d2b9-28b3-4b28-bd33-41a36161e9ab', 'f27a9a4d-6a43-4726-8db1-43d2e8fa923a', 'f18a8c9e-6f76-42e9-8f23-4a8dd099b3c1', -18.30, now() - interval '10 days', now() - interval '10 days', 'Transport', 'Lyft to downtown', false),
    ('9f3e6d89-7fba-47a4-9e2b-57767187b9f3', '0f08d2b9-28b3-4b28-bd33-41a36161e9ab', 'f27a9a4d-6a43-4726-8db1-43d2e8fa923a', '50b5e02c-999a-47ca-8067-04dd4e85e46b', 4200.00, date_trunc('month', now()) + interval '5 days', date_trunc('month', now()) + interval '5 days', 'Income', 'Bi-weekly payroll deposit', false),
    ('1e987d90-5673-44b6-8c4f-58be34c4f0ec', '0f08d2b9-28b3-4b28-bd33-41a36161e9ab', '6b358bb2-7e8f-48d9-a7ff-8f4c6c39e4db', 'c5179186-1a68-4851-8c92-8c7fd1a3e55d', -15.99, date_trunc('month', now()) - interval '1 month' + interval '2 days', date_trunc('month', now()) - interval '1 month' + interval '2 days', 'Entertainment', 'Netflix subscription', false),
    ('71a9c4f5-5f13-4c80-8b0d-b3ac3742776d', '0f08d2b9-28b3-4b28-bd33-41a36161e9ab', '6b358bb2-7e8f-48d9-a7ff-8f4c6c39e4db', '2e8f0fa5-84ca-4aaa-836c-4b6cb7467e28', -9.99, date_trunc('month', now()) - interval '2 month' + interval '1 day', date_trunc('month', now()) - interval '2 month' + interval '1 day', 'Entertainment', 'Spotify subscription', false),
    ('a14bfad5-015f-4bdc-a260-2b7e0ac8d161', '0f08d2b9-28b3-4b28-bd33-41a36161e9ab', 'f27a9a4d-6a43-4726-8db1-43d2e8fa923a', '4c6df5a8-cbb5-4fc1-b4ec-77fb25f9adf3', -1850.00, date_trunc('month', now()) - interval '1 month' + interval '3 days', date_trunc('month', now()) - interval '1 month' + interval '3 days', 'Housing', 'Monthly rent', false),
    ('7c3ab70e-6c71-41fa-9b0e-7f9e80ef2de4', '0f08d2b9-28b3-4b28-bd33-41a36161e9ab', 'f27a9a4d-6a43-4726-8db1-43d2e8fa923a', 'f9b75f4f-d8c1-45c8-a7cb-a9a8610fdf73', -130.45, date_trunc('month', now()) - interval '1 month' + interval '8 days', date_trunc('month', now()) - interval '1 month' + interval '8 days', 'Utilities', 'Electric bill', false),
    ('8e74476c-50db-433a-b64c-8ff831cf7d4c', '0f08d2b9-28b3-4b28-bd33-41a36161e9ab', '6b358bb2-7e8f-48d9-a7ff-8f4c6c39e4db', '8869124b-4d46-41a5-8fda-5928a5241ff3', -89.99, date_trunc('month', now()) - interval '2 month' + interval '15 days', date_trunc('month', now()) - interval '2 month' + interval '15 days', 'Shopping', 'Apple accessories', false),
    ('5a13a1a8-b720-4dd6-b206-5ac4630d4a4e', '0f08d2b9-28b3-4b28-bd33-41a36161e9ab', 'c4d6f30d-2f5e-4f81-a0a0-4f7839f87f9f', '50b5e02c-999a-47ca-8067-04dd4e85e46b', 500.00, date_trunc('month', now()) - interval '1 month' + interval '6 days', date_trunc('month', now()) - interval '1 month' + interval '6 days', 'Transfer', 'Auto-transfer to savings', false),
    ('c4755efc-4457-4c2a-b119-0887a65a8f66', '0f08d2b9-28b3-4b28-bd33-41a36161e9ab', 'f27a9a4d-6a43-4726-8db1-43d2e8fa923a', 'd9b28b50-2f16-4829-9f2c-9a5d4bb8ad58', -94.36, date_trunc('month', now()) - interval '2 month' + interval '5 days', date_trunc('month', now()) - interval '2 month' + interval '5 days', 'Groceries', 'Trader Joes restock', false),
    ('d9710e8d-5fa9-474f-a9d3-1bdeb2618d9b', '0f08d2b9-28b3-4b28-bd33-41a36161e9ab', '6b358bb2-7e8f-48d9-a7ff-8f4c6c39e4db', 'f741c4f4-0328-4a86-8053-4642c4f3a2aa', -12.50, date_trunc('month', now()) - interval '15 days', date_trunc('month', now()) - interval '15 days', 'Dining', 'Blue Bottle latte', false),
    ('3bbcc02b-514c-4edb-8a5b-3d6f5a03fdfa', '0f08d2b9-28b3-4b28-bd33-41a36161e9ab', 'f27a9a4d-6a43-4726-8db1-43d2e8fa923a', '6f40ce7a-767e-4a2d-8d64-b6c1f8ebd4f4', -425.10, date_trunc('month', now()) - interval '3 month' + interval '10 days', date_trunc('month', now()) - interval '3 month' + interval '10 days', 'Travel', 'Delta flight to NYC', false),
    ('ab92e946-3166-4a30-a9ff-47d9770b3471', '0f08d2b9-28b3-4b28-bd33-41a36161e9ab', '6b358bb2-7e8f-48d9-a7ff-8f4c6c39e4db', 'a9d7d023-74c0-4dc5-93ce-4ea1adbbef36', -610.75, date_trunc('month', now()) - interval '3 month' + interval '15 days', date_trunc('month', now()) - interval '3 month' + interval '15 days', 'Travel', 'Airbnb reservation Manhattan', false),
    ('df56f8d2-2d72-4b50-93cc-1bfbf0b1a054', '0f08d2b9-28b3-4b28-bd33-41a36161e9ab', 'f27a9a4d-6a43-4726-8db1-43d2e8fa923a', '50b5e02c-999a-47ca-8067-04dd4e85e46b', 4200.00, date_trunc('month', now()) - interval '1 month' + interval '5 days', date_trunc('month', now()) - interval '1 month' + interval '5 days', 'Income', 'Bi-weekly payroll deposit', false)
ON CONFLICT (id) DO NOTHING;
