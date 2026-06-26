-- ============================================================
-- TENANTS TABLE
-- Multi-tenant isolation — each tenant (identified by catchall
-- email prefix) gets their own agent config and data scope.
-- ============================================================

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,                     -- e.g. "clienta" from clienta@trumoveinc.com
  display_name TEXT,                             -- Friendly name for UI
  email TEXT,                                    -- Full catchall address
  domain TEXT,                                   -- The catchall domain
  -- AI Agent configuration per tenant
  ai_provider TEXT DEFAULT 'gemini' CHECK (ai_provider IN ('gemini', 'claude')),
  ai_system_prompt TEXT,                         -- Custom system prompt for this tenant's agent
  ai_temperature NUMERIC(3,2) DEFAULT 0.7,
  ai_max_tokens INTEGER DEFAULT 2048,
  -- Metadata
  is_active BOOLEAN DEFAULT TRUE,
  settings JSONB DEFAULT '{}',                   -- Extensible key-value config
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug);
CREATE INDEX IF NOT EXISTS idx_tenants_email ON tenants(email);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access - tenants" ON tenants FOR ALL USING (auth.role() = 'service_role');

CREATE TRIGGER update_tenants_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Add tenant_id to existing tables for scoping
-- ============================================================
ALTER TABLE clients ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
ALTER TABLE internal_messages ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);

CREATE INDEX IF NOT EXISTS idx_clients_tenant ON clients(tenant_id);
CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages(tenant_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_tenant ON activity_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_internal_messages_tenant ON internal_messages(tenant_id);
