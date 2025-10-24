-- Flyway migration: enforce unique plaid item per user
ALTER TABLE IF EXISTS plaid_items
    ADD CONSTRAINT IF NOT EXISTS plaid_items_user_item_uniq UNIQUE (user_id, item_id);
