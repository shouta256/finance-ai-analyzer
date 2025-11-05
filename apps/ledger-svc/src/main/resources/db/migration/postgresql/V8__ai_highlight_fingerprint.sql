ALTER TABLE ai_monthly_highlights
    ADD COLUMN IF NOT EXISTS fingerprint varchar(128);
