const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
}

// Admin client with service role key - bypasses Row Level Security
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

/**
 * Log an activity to the audit trail
 */
async function logActivity({ userId, action, entityType, entityId, details, ipAddress }) {
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

module.exports = { supabase, logActivity, upsertConversation };
