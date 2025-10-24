-- Align tx_embeddings to JSONB storage (pgvector optional). This mirrors the generic V3.
DROP TABLE IF EXISTS tx_embeddings CASCADE;

CREATE TABLE tx_embeddings (
    tx_id uuid PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    yyyymm char(7) NOT NULL,
    category text NOT NULL,
    amount_cents integer NOT NULL,
    merchant_id uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    merchant_normalized text NOT NULL,
    embedding jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tx_embeddings_user_month_category_idx
    ON tx_embeddings (user_id, yyyymm, category);

CREATE INDEX IF NOT EXISTS tx_embeddings_merchant_idx
    ON tx_embeddings (merchant_id);

ALTER TABLE tx_embeddings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'tx_embeddings'
          AND policyname = 'tx_embeddings_rls'
    ) THEN
        EXECUTE $rls$
            CREATE POLICY tx_embeddings_rls
            ON tx_embeddings
            USING (
                user_id = coalesce(
                    NULLIF(current_setting('appsec.user_id', true), '')::uuid,
                    '00000000-0000-0000-0000-000000000000'::uuid
                )
            )
            WITH CHECK (
                user_id = coalesce(
                    NULLIF(current_setting('appsec.user_id', true), '')::uuid,
                    '00000000-0000-0000-0000-000000000000'::uuid
                )
            );
        $rls$;
    END IF;
END$$;
