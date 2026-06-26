const { createClient } = require('@supabase/supabase-js');

// ── Lazy-initialised client ───────────────────────────────────────────────────
// The client is created on first use (or re-created if keys change). This lets
// the vault UI save Supabase credentials and have them take effect immediately,
// without requiring a server restart.

let _client = null;
let _configuredUrl = null;
let _configuredKey = null;

/**
 * Returns the live Supabase admin client, or null when keys are not configured.
 * Call this whenever you need to check connectivity (e.g. the DB route guard).
 */
function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  if (_client && url === _configuredUrl && key === _configuredKey) return _client;
  // Keys present and either first-init or changed — (re-)create client
  _configuredUrl = url;
  _configuredKey = key;
  try {
    _client = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    console.log('✅ Supabase client initialised');
  } catch (err) {
    console.error('Supabase init error:', err.message);
    _client = null;
  }
  return _client;
}

// Stable proxy exported as `supabase` — all property accesses are forwarded to
// the real client on demand, so routes that destructured this at import time
// still work after vault keys are saved without restarting the server.
const supabase = new Proxy(Object.create(null), {
  get(_, prop) {
    const client = getSupabaseClient();
    if (!client) {
      // Return a thenable stub that rejects so callers get a clear error
      if (['from', 'rpc', 'auth', 'storage'].includes(prop)) {
        return () => {
          const notReady = Promise.reject(
            new Error('Database not configured. Open the Integrations tab and add your Supabase URL and Service Role Key.')
          );
          // Attach .select/.insert/etc. stubs so chaining before await doesn't throw
          notReady.select = notReady.insert = notReady.update = notReady.delete =
            notReady.upsert = notReady.single = notReady.maybeSingle =
            notReady.eq = notReady.or = notReady.order = notReady.range =
            notReady.limit = notReady.not = notReady.gt = notReady.lt = () => notReady;
          return notReady;
        };
      }
      return undefined;
    }
    const val = client[prop];
    return typeof val === 'function' ? val.bind(client) : val;
  },
});

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('⚠️  Supabase not configured — open the app and add keys in the Integrations tab.');
} else {
  // Eagerly create client if keys are already present at boot
  getSupabaseClient();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Log an activity to the audit trail
 */
async function logActivity({ userId, action, entityType, entityId, details, ipAddress }) {
  if (!getSupabaseClient()) return; // silently skip if DB not configured
  const { error } = await supabase.from('activity_log').insert({
    user_id: userId || null,
    action,
    entity_type: entityType || null,
    entity_id: entityId || null,
    details: details || null,
    ip_address: ipAddress || null,
  });
  if (error) {
    console.error('Failed to log activity:', error.message);
  }
}

/**
 * Upsert or update an SMS conversation thread
 */
async function upsertConversation({ phoneNumber, clientId, lastMessage, assignedTo }) {
  if (!getSupabaseClient()) throw new Error('Database not configured. Add Supabase keys in the Integrations tab.');
  const { data, error } = await supabase
    .from('sms_conversations')
    .upsert(
      {
        phone_number: phoneNumber,
        client_id: clientId || null,
        assigned_to: assignedTo || null,
        last_message: lastMessage,
        last_message_at: new Date().toISOString(),
      },
      { onConflict: 'phone_number', ignoreDuplicates: false }
    )
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to upsert conversation: ${error.message}`);
  }
  return data;
}

module.exports = { supabase, getSupabaseClient, logActivity, upsertConversation };
