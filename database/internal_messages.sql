-- Migration: internal_messages table for floating team chat widget
-- Run this in the Supabase SQL Editor

CREATE TABLE IF NOT EXISTS internal_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
  sender_name TEXT NOT NULL DEFAULT 'Team Member',
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_internal_messages_created_at ON internal_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_internal_messages_sender ON internal_messages(sender_id);

-- Enable Row Level Security
ALTER TABLE internal_messages ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (used by backend)
CREATE POLICY "Service role full access - internal_messages"
  ON internal_messages FOR ALL
  USING (auth.role() = 'service_role');
