ALTER TABLE chat_messages
    ADD COLUMN IF NOT EXISTS metadata_json text;
