CREATE TABLE IF NOT EXISTS ai_monthly_highlights (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    month VARCHAR(7) NOT NULL,
    title VARCHAR(255) NOT NULL,
    summary TEXT NOT NULL,
    sentiment VARCHAR(16) NOT NULL,
    recommendations TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
