-- Flyway migration: enforce unique plaid item per user
ALTER TABLE IF EXISTS plaid_items
    ADD CONSTRAINT IF NOT EXISTS plaid_items_item_unique UNIQUE (item_id);
ALTER TABLE IF EXISTS plaid_items
    ADD CONSTRAINT IF NOT EXISTS plaid_items_user_item_unique UNIQUE (user_id, item_id);
CREATE INDEX IF NOT EXISTS plaid_items_user_idx ON plaid_items(user_id);
