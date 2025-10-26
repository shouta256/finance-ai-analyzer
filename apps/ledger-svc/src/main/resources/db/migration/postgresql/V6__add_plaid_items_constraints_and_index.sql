DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'plaid_items_item_unique'
    ) THEN
        ALTER TABLE plaid_items
            ADD CONSTRAINT plaid_items_item_unique UNIQUE (item_id);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'plaid_items_user_item_unique'
    ) THEN
        ALTER TABLE plaid_items
            ADD CONSTRAINT plaid_items_user_item_unique UNIQUE (user_id, item_id);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS plaid_items_user_idx ON plaid_items(user_id);
