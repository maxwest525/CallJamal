const express = require('express');
const axios = require('axios');
const { supabase, logActivity, upsertConversation } = require('../lib/supabase');

const router = express.Router();

const SLICKTEXT_API_BASE = 'https://api.slicktext.com/v1';
const SLICKTEXT_PUBLIC_KEY = process.env.SLICKTEXT_PUBLIC_KEY;
const SLICKTEXT_PRIVATE_KEY = process.env.SLICKTEXT_PRIVATE_KEY;
const SLICKTEXT_MAIN_NUMBER = process.env.SLICKTEXT_MAIN_NUMBER;

function slicktextAuth() {
  const credentials = Buffer.from(`${SLICKTEXT_PUBLIC_KEY}:${SLICKTEXT_PRIVATE_KEY}`).toString('base64');
  return { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json' };
}

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
    const slicktextResponse = await axios.post(
      `${SLICKTEXT_API_BASE}/send`,
      { number: to, message, from: SLICKTEXT_MAIN_NUMBER },
      { headers: slicktextAuth() }
    );

    const conversation = await upsertConversation({
      phoneNumber: to,
      clientId,
      lastMessage: message,
    });

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
    const slicktextResponse = await axios.post(
      `${SLICKTEXT_API_BASE}/send`,
      { number: to, message: `[INTERNAL] ${message}`, from: SLICKTEXT_MAIN_NUMBER },
      { headers: slicktextAuth() }
    );

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

    const slicktextResponse = await axios.post(
      `${SLICKTEXT_API_BASE}/send-bulk`,
      { numbers: recipients, message, from: SLICKTEXT_MAIN_NUMBER },
      { headers: slicktextAuth() }
    );

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
    if (insertError) console.error('Broadcast insert error:', insertError.message);

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
 * SlickText will POST here when a client replies to the shared number
 */
router.post('/webhook', async (req, res) => {
  const { from, to, body: messageBody, id: slicktextId } = req.body;

  if (!from || !messageBody) {
    return res.status(400).json({ error: 'Invalid webhook payload' });
  }

  try {
    const { data: client } = await supabase
      .from('clients')
      .select('id, name')
      .eq('phone', from)
      .maybeSingle();

    const conversation = await upsertConversation({
      phoneNumber: from,
      clientId: client?.id || null,
      lastMessage: messageBody,
    });

    await supabase.rpc('increment_unread_count', { conversation_id: conversation.id });

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

module.exports = router;
