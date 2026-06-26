-- Gmail OAuth Token Storage
-- Persists the catch-all account's OAuth tokens so they survive server restarts.
-- Run this in Supabase SQL Editor after running schema.sql.

CREATE TABLE IF NOT EXISTS gmail_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_email TEXT NOT NULL UNIQUE,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  scope TEXT,
  token_type TEXT DEFAULT 'Bearer',
  expiry_date BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gmail_tokens_email ON gmail_tokens(account_email);

ALTER TABLE gmail_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access - gmail_tokens" ON gmail_tokens FOR ALL USING (auth.role() = 'service_role');

CREATE TRIGGER update_gmail_tokens_updated_at
  BEFORE UPDATE ON gmail_tokens
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
