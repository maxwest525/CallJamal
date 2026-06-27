const express = require('express');
const { sendSms, sendBulkSms } = require('../lib/slicktext');
const { supabase, logActivity, upsertConversation } = require('../lib/supabase');
const { triggerOutbound } = require('../lib/webhooks');

const router = express.Router();

const SLICKTEXT_MAIN_NUMBER = process.env.SLICKTEXT_MAIN_NUMBER;

/**
 * POST /api/sms/send-external
 * Send an SMS to an external client phone number
 * Body: { to, message, senderId, clientId }
 */
router.post('/send-external', async (req, res) => {
  const { to, message, senderId, clientId } = req.body;

  if (!to || !message) {
    return res.status(400).json({ error: 'to and message are required' });
  }

  try {
    const slicktextResponse = await sendSms({ to, message, from: SLICKTEXT_MAIN_NUMBER });

    const conversation = await upsertConversation({
      phoneNumber: to,
      clientId,
      lastMessage: message,
    });

    // Auto-assign conversation to the sender so it shows in their inbox
    if (senderId && !conversation.assigned_to) {
      await supabase.from('sms_conversations').update({ assigned_to: senderId }).eq('id', conversation.id);
    }

    const { data: msg, error: msgError } = await supabase.from('messages').insert({
      conversation_id: conversation.id,
      direction: 'outbound',
      message_type: 'external',
      from_number: SLICKTEXT_MAIN_NUMBER,
      to_number: to,
      body: message,
      status: 'sent',
      sender_id: senderId || null,
      client_id: clientId || null,
      slicktext_message_id: slicktextResponse.data?.id || null,
    }).select().single();

    if (msgError) throw new Error(msgError.message);

    if (clientId) {
      await supabase.from('clients').update({ last_contacted_at: new Date().toISOString() }).eq('id', clientId);
    }

    await logActivity({
      userId: senderId,
      action: 'sms_sent_external',
      entityType: 'message',
      entityId: msg.id,
      details: { to, messagePreview: message.slice(0, 50) },
      ipAddress: req.ip,
    });

    triggerOutbound('sms_sent', { to, messagePreview: message.slice(0, 100), clientId, messageId: msg.id }).catch(() => {});

    res.json({ success: true, message: msg, slicktextResponse: slicktextResponse.data });
  } catch (err) {
    console.error('send-external error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sms/send-internal
 * Send an internal alert SMS to a team member's phone
 * Body: { to, message, senderId }
 */
router.post('/send-internal', async (req, res) => {
  const { to, message, senderId } = req.body;

  if (!to || !message) {
    return res.status(400).json({ error: 'to and message are required' });
  }

  try {
    const slicktextResponse = await sendSms({
      to,
      message: `[INTERNAL] ${message}`,
      from: SLICKTEXT_MAIN_NUMBER,
    });

    const { data: msg, error: msgError } = await supabase.from('messages').insert({
      direction: 'outbound',
      message_type: 'internal',
      from_number: SLICKTEXT_MAIN_NUMBER,
      to_number: to,
      body: message,
      status: 'sent',
      sender_id: senderId || null,
      slicktext_message_id: slicktextResponse.data?.id || null,
    }).select().single();

    if (msgError) throw new Error(msgError.message);

    await logActivity({
      userId: senderId,
      action: 'sms_sent_internal',
      entityType: 'message',
      entityId: msg.id,
      details: { to, messagePreview: message.slice(0, 50) },
      ipAddress: req.ip,
    });

    res.json({ success: true, message: msg, slicktextResponse: slicktextResponse.data });
  } catch (err) {
    console.error('send-internal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sms/broadcast
 * Send a broadcast SMS to all active clients (or a list of numbers)
 * Body: { message, senderId, numbers? }
 */
router.post('/broadcast', async (req, res) => {
  const { message, senderId, numbers } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }

  try {
    let recipients = numbers;

    if (!recipients || recipients.length === 0) {
      const { data: clients, error } = await supabase
        .from('clients')
        .select('phone')
        .eq('is_active', true)
        .not('phone', 'is', null);
      if (error) throw new Error(error.message);
      recipients = clients.map((c) => c.phone);
    }

    if (recipients.length === 0) {
      return res.status(400).json({ error: 'No recipients found' });
    }

    const slicktextResponse = await sendBulkSms({
      numbers: recipients,
      message,
      from: SLICKTEXT_MAIN_NUMBER,
    });

    const broadcastRecords = recipients.map((phone) => ({
      direction: 'outbound',
      message_type: 'broadcast',
      from_number: SLICKTEXT_MAIN_NUMBER,
      to_number: phone,
      body: message,
      status: 'sent',
      sender_id: senderId || null,
    }));

    const { error: insertError } = await supabase.from('messages').insert(broadcastRecords);
    if (insertError) throw new Error(`Broadcast DB insert failed: ${insertError.message}`);

    await logActivity({
      userId: senderId,
      action: 'sms_broadcast',
      details: { recipientCount: recipients.length, messagePreview: message.slice(0, 50) },
      ipAddress: req.ip,
    });

    res.json({ success: true, recipientCount: recipients.length, slicktextResponse: slicktextResponse.data });
  } catch (err) {
    console.error('broadcast error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sms/webhook
 * Incoming SMS webhook from SlickText
 * SlickText will POST here when a client replies to the shared number.
 * Set SMS_WEBHOOK_SECRET env var and pass it as ?secret=… or X-Webhook-Secret header
 * to authenticate inbound webhooks.
 */
router.post('/webhook', async (req, res) => {
  const webhookSecret = process.env.SMS_WEBHOOK_SECRET;
  if (webhookSecret) {
    const provided = req.query.secret || req.headers['x-webhook-secret'] || '';
    if (provided !== webhookSecret) {
      return res.status(401).json({ error: 'Unauthorized webhook request' });
    }
  }

  const { from, to, body: messageBody, id: slicktextId } = req.body;

  if (!from || !messageBody) {
    return res.status(400).json({ error: 'Invalid webhook payload' });
  }

  try {
    const { data: client } = await supabase
      .from('clients')
      .select('id, name, assigned_to')
      .eq('phone', from)
      .maybeSingle();

    const conversation = await upsertConversation({
      phoneNumber: from,
      clientId: client?.id || null,
      lastMessage: messageBody,
    });

    // Auto-assign conversation to the client's assigned team member
    if (client?.assigned_to && !conversation.assigned_to) {
      await supabase.from('sms_conversations').update({ assigned_to: client.assigned_to }).eq('id', conversation.id);
    }

    const { error: rpcError } = await supabase.rpc('increment_unread_count', { conversation_id: conversation.id });
    if (rpcError) console.error('increment_unread_count error:', rpcError.message);

    await supabase.from('messages').insert({
      conversation_id: conversation.id,
      direction: 'inbound',
      message_type: 'external',
      from_number: from,
      to_number: to || SLICKTEXT_MAIN_NUMBER,
      body: messageBody,
      status: 'received',
      client_id: client?.id || null,
      slicktext_message_id: slicktextId || null,
    });

    triggerOutbound('sms_received', {
      from,
      clientName: client?.name || null,
      clientId: client?.id || null,
      messagePreview: messageBody.slice(0, 100),
      conversationId: conversation.id,
    }).catch(() => {});

    res.json({ success: true });
  } catch (err) {
    console.error('webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sms/messages
 * Get recent messages with optional filters
 * Query: { type, direction, limit, offset }
 */
router.get('/messages', async (req, res) => {
  const { type, direction, limit = 50, offset = 0 } = req.query;

  try {
    let query = supabase
      .from('messages')
      .select(`
        *,
        sender:sender_id(id, name, email, avatar_url),
        client:client_id(id, name, phone, company)
      `)
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (type) query = query.eq('message_type', type);
    if (direction) query = query.eq('direction', direction);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    res.json({ messages: data });
  } catch (err) {
    console.error('get messages error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sms/conversations/:id/messages
 * Get all messages for a specific conversation, plus conversation metadata.
 * Query: { limit=100, offset=0 }
 */
router.get('/conversations/:id/messages', async (req, res) => {
  const { id } = req.params;
  const { limit = 100, offset = 0 } = req.query;

  try {
    const { data: conversation, error: convError } = await supabase
      .from('sms_conversations')
      .select(`
        *,
        client:client_id(id, name, company, phone),
        assigned_user:assigned_to(id, name, email, avatar_url)
      `)
      .eq('id', id)
      .single();

    if (convError || !conversation) return res.status(404).json({ error: 'Conversation not found' });

    const { data: messages, error: msgError } = await supabase
      .from('messages')
      .select(`
        *,
        sender:sender_id(id, name, email, avatar_url)
      `)
      .eq('conversation_id', id)
      .order('created_at', { ascending: true })
      .range(Number(offset), Number(offset) + Math.min(Number(limit), 200) - 1);

    if (msgError) throw new Error(msgError.message);

    res.json({ conversation, messages: messages || [] });
  } catch (err) {
    console.error('get conversation messages error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sms/conversations/:id/reply
 * Send an outbound SMS reply in a conversation thread.
 * Body: { message, senderId? }
 */
router.post('/conversations/:id/reply', async (req, res) => {
  const { id } = req.params;
  const { message, senderId } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }

  try {
    const { data: conversation, error: convError } = await supabase
      .from('sms_conversations')
      .select('id, phone_number, client_id, assigned_to')
      .eq('id', id)
      .single();

    if (convError || !conversation) return res.status(404).json({ error: 'Conversation not found' });

    const slicktextResponse = await sendSms({
      to: conversation.phone_number,
      message,
      from: SLICKTEXT_MAIN_NUMBER,
    });

    const { data: msg, error: msgError } = await supabase.from('messages').insert({
      conversation_id: id,
      direction: 'outbound',
      message_type: 'external',
      from_number: SLICKTEXT_MAIN_NUMBER,
      to_number: conversation.phone_number,
      body: message,
      status: 'sent',
      sender_id: senderId || null,
      client_id: conversation.client_id || null,
      slicktext_message_id: slicktextResponse.data?.id || null,
    }).select().single();

    if (msgError) throw new Error(msgError.message);

    // Update conversation last message + auto-assign to replier if unassigned
    const convUpdate = { last_message: message, last_message_at: new Date().toISOString() };
    if (senderId && !conversation.assigned_to) convUpdate.assigned_to = senderId;
    await supabase.from('sms_conversations').update(convUpdate).eq('id', id);

    if (conversation.client_id) {
      await supabase.from('clients').update({ last_contacted_at: new Date().toISOString() }).eq('id', conversation.client_id);
    }

    await logActivity({
      userId: senderId,
      action: 'sms_reply_sent',
      entityType: 'conversation',
      entityId: id,
      details: { to: conversation.phone_number, messagePreview: message.slice(0, 50) },
    });

    res.json({ success: true, message: msg });
  } catch (err) {
    console.error('conversation reply error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/sms/conversations/:id/read
 * Mark a conversation as read (reset unread count to 0)
 */
router.patch('/conversations/:id/read', async (req, res) => {
  const { id } = req.params;

  try {
    const { error } = await supabase
      .from('sms_conversations')
      .update({ unread_count: 0 })
      .eq('id', id);

    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err) {
    console.error('mark read error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/sms/conversations/:id/assign
 * Assign a conversation to a team member
 * Body: { userId } — pass null to unassign
 */
router.patch('/conversations/:id/assign', async (req, res) => {
  const { id } = req.params;
  const { userId } = req.body;

  try {
    const { error } = await supabase
      .from('sms_conversations')
      .update({ assigned_to: userId || null })
      .eq('id', id);

    if (error) throw new Error(error.message);

    if (userId) {
      const { data: conv } = await supabase
        .from('sms_conversations')
        .select('client_id')
        .eq('id', id)
        .single();
      if (conv?.client_id) {
        await supabase.from('clients').update({ assigned_to: userId }).eq('id', conv.client_id);
      }
    }

    await logActivity({
      userId: req.user?.id,
      action: userId ? 'conversation_assigned' : 'conversation_unassigned',
      entityType: 'conversation',
      entityId: id,
      details: { assignedTo: userId },
      ipAddress: req.ip,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('assign conversation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sms/status
 * Returns whether SlickText is configured
 */
router.get('/status', (req, res) => {
  res.json({
    configured: Boolean(process.env.SLICKTEXT_PUBLIC_KEY && process.env.SLICKTEXT_PRIVATE_KEY),
    mainNumber: process.env.SLICKTEXT_MAIN_NUMBER || null,
  });
});

module.exports = router;

