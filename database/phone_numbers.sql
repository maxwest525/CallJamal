-- User Phone Numbers — Twilio-provisioned numbers for personal SMS
-- Each team member can have their own phone number to text clients from.

CREATE TABLE IF NOT EXISTS user_phone_numbers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone_number TEXT NOT NULL UNIQUE,
  twilio_sid TEXT,
  label TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_phone_numbers_user ON user_phone_numbers(user_id);
CREATE INDEX IF NOT EXISTS idx_user_phone_numbers_phone ON user_phone_numbers(phone_number);

-- Add trigger for updated_at (reuses the trigger function from schema.sql)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at_user_phone_numbers'
  ) THEN
    CREATE TRIGGER set_updated_at_user_phone_numbers
      BEFORE UPDATE ON user_phone_numbers
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;
