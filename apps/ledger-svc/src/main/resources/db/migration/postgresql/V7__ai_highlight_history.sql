CREATE TABLE IF NOT EXISTS ai_monthly_highlights (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    month varchar(7) NOT NULL,
    title varchar(255) NOT NULL,
    summary text NOT NULL,
    sentiment varchar(16) NOT NULL,
    recommendations text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_monthly_highlights
    ADD COLUMN IF NOT EXISTS id uuid;

UPDATE ai_monthly_highlights target
SET id = (
    substr(hash_value, 1, 8) || '-' ||
    substr(hash_value, 9, 4) || '-' ||
    substr(hash_value, 13, 4) || '-' ||
    substr(hash_value, 17, 4) || '-' ||
    substr(hash_value, 21, 12)
)::uuid
FROM (
    SELECT user_id, month, md5(user_id::text || '-' || month || '-ai') AS hash_value
    FROM ai_monthly_highlights
) source
WHERE target.id IS NULL
  AND target.user_id = source.user_id
  AND target.month = source.month;

ALTER TABLE ai_monthly_highlights
    ALTER COLUMN id SET NOT NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE table_name = 'ai_monthly_highlights'
          AND constraint_type = 'PRIMARY KEY'
          AND constraint_name = 'ai_monthly_highlights_pkey'
    ) THEN
        EXECUTE 'ALTER TABLE ai_monthly_highlights DROP CONSTRAINT ai_monthly_highlights_pkey';
    END IF;
EXCEPTION
    WHEN undefined_table THEN
        NULL;
END $$;

ALTER TABLE ai_monthly_highlights
    ADD CONSTRAINT ai_monthly_highlights_pkey PRIMARY KEY (id);

ALTER TABLE ai_monthly_highlights
    ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE ai_monthly_highlights
    ADD CONSTRAINT ai_monthly_highlights_user_month_unique UNIQUE (user_id, month);
