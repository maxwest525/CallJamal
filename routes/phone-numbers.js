const express = require('express');
const { isTwilioConfigured, sendSmsTwilio, searchAvailableNumbers, provisionNumber, releaseNumber, listOwnedNumbers } = require('../lib/twilio');
const { supabase, logActivity, upsertConversation } = require('../lib/supabase');
const { triggerOutbound } = require('../lib/webhooks');

const router = express.Router();

/**
 * GET /api/phone-numbers/status
 * Check if Twilio is configured
 */
router.get('/status', (req, res) => {
  res.json({ configured: isTwilioConfigured() });
});

/**
 * GET /api/phone-numbers
 * List all phone numbers assigned to team members
 */
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('user_phone_numbers')
      .select(`
        *,
        user:user_id(id, name, email, avatar_url)
      `)
      .order('created_at', { ascending: true });

    if (error) throw new Error(error.message);
    res.json({ numbers: data || [] });
  } catch (err) {
    console.error('list phone numbers error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/phone-numbers/available
 * Search for available phone numbers to purchase
 * Query: { areaCode, country=US, limit=10 }
 */
router.get('/available', async (req, res) => {
  const { areaCode, country = 'US', limit = 10 } = req.query;
  try {
    const numbers = await searchAvailableNumbers({
      areaCode: areaCode || undefined,
      country,
      limit: Math.min(Number(limit), 20),
    });
    res.json({ numbers });
  } catch (err) {
    console.error('search numbers error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/phone-numbers/provision
 * Buy a phone number and assign it to a team member
 * Body: { phoneNumber, userId, label? }
 */
router.post('/provision', async (req, res) => {
  const { phoneNumber, userId, label } = req.body;
  if (!phoneNumber || !userId) {
    return res.status(400).json({ error: 'phoneNumber and userId are required' });
  }

  try {
    const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const webhookUrl = `${baseUrl}/api/phone-numbers/webhook`;

    const result = await provisionNumber({ phoneNumber, webhookUrl });

    const { data, error } = await supabase
      .from('user_phone_numbers')
      .insert({
        user_id: userId,
        phone_number: result.phoneNumber,
        twilio_sid: result.sid,
        label: label || result.friendlyName,
        is_active: true,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    await logActivity({
      userId: req.user?.id,
      action: 'phone_number_provisioned',
      entityType: 'phone_number',
      entityId: data.id,
      details: { phoneNumber: result.phoneNumber, assignedTo: userId },
      ipAddress: req.ip,
    });

    res.json({ success: true, number: data });
  } catch (err) {
    console.error('provision number error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/phone-numbers/:id
 * Release a phone number
 */
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { data: num, error: fetchErr } = await supabase
      .from('user_phone_numbers')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !num) return res.status(404).json({ error: 'Number not found' });

    if (num.twilio_sid) {
      await releaseNumber(num.twilio_sid).catch((e) =>
        console.error('Twilio release error (continuing):', e.message)
      );
    }

    await supabase.from('user_phone_numbers').delete().eq('id', id);

    await logActivity({
      userId: req.user?.id,
      action: 'phone_number_released',
      entityType: 'phone_number',
      details: { phoneNumber: num.phone_number },
      ipAddress: req.ip,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('release number error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/phone-numbers/send
 * Send an SMS from a team member's own number
 * Body: { to, message, userId, clientId? }
 */
router.post('/send', async (req, res) => {
  const { to, message, userId, clientId } = req.body;
  if (!to || !message || !userId) {
    return res.status(400).json({ error: 'to, message, and userId are required' });
  }

  try {
    const { data: userNum, error: numErr } = await supabase
      .from('user_phone_numbers')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();

    if (numErr || !userNum) {
      return res.status(400).json({ error: 'No phone number assigned to this user. Provision one first.' });
    }

    const twilioMsg = await sendSmsTwilio({
      to,
      message,
      from: userNum.phone_number,
    });

    const conversation = await upsertConversation({
      phoneNumber: to,
      clientId: clientId || null,
      lastMessage: message,
    });

    const { data: msg, error: msgError } = await supabase.from('messages').insert({
      conversation_id: conversation.id,
      direction: 'outbound',
      message_type: 'external',
      from_number: userNum.phone_number,
      to_number: to,
      body: message,
      status: 'sent',
      sender_id: userId,
      client_id: clientId || null,
    }).select().single();

    if (msgError) throw new Error(msgError.message);

    if (clientId) {
      await supabase.from('clients').update({ last_contacted_at: new Date().toISOString() }).eq('id', clientId);
    }

    await logActivity({
      userId,
      action: 'sms_sent_personal',
      entityType: 'message',
      entityId: msg.id,
      details: { to, from: userNum.phone_number, messagePreview: message.slice(0, 50) },
      ipAddress: req.ip,
    });

    triggerOutbound('sms_sent', { to, from: userNum.phone_number, messagePreview: message.slice(0, 100), clientId, messageId: msg.id }).catch(() => {});

    res.json({ success: true, message: msg, twilioSid: twilioMsg.sid });
  } catch (err) {
    console.error('personal send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/phone-numbers/webhook
 * Inbound SMS webhook from Twilio
 * Twilio sends form-encoded POST with From, To, Body, MessageSid
 */
router.post('/webhook', async (req, res) => {
  const { From: from, To: to, Body: messageBody, MessageSid: twilioSid } = req.body;

  if (!from || !messageBody) {
    return res.status(400).send('<Response></Response>');
  }

  try {
    const { data: numRecord } = await supabase
      .from('user_phone_numbers')
      .select('user_id, phone_number')
      .eq('phone_number', to)
      .eq('is_active', true)
      .maybeSingle();

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

    if (numRecord) {
      await supabase.from('sms_conversations').update({
        assigned_to: numRecord.user_id,
      }).eq('id', conversation.id);
    }

    const { error: rpcError } = await supabase.rpc('increment_unread_count', { conversation_id: conversation.id });
    if (rpcError) console.error('increment_unread_count error:', rpcError.message);

    await supabase.from('messages').insert({
      conversation_id: conversation.id,
      direction: 'inbound',
      message_type: 'external',
      from_number: from,
      to_number: to,
      body: messageBody,
      status: 'received',
      client_id: client?.id || null,
    });

    triggerOutbound('sms_received', {
      from,
      to,
      clientName: client?.name || null,
      clientId: client?.id || null,
      assignedTo: numRecord?.user_id || null,
      messagePreview: messageBody.slice(0, 100),
      conversationId: conversation.id,
    }).catch(() => {});

    res.type('text/xml').send('<Response></Response>');
  } catch (err) {
    console.error('twilio webhook error:', err.message);
    res.type('text/xml').status(500).send('<Response></Response>');
  }
});

/**
 * PATCH /api/phone-numbers/:id
 * Update a phone number assignment
 * Body: { userId?, label?, is_active? }
 */
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const updates = {};
  if (req.body.userId !== undefined) updates.user_id = req.body.userId;
  if (req.body.label !== undefined) updates.label = req.body.label;
  if (req.body.is_active !== undefined) updates.is_active = req.body.is_active;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  try {
    const { data, error } = await supabase
      .from('user_phone_numbers')
      .update(updates)
      .eq('id', id)
      .select(`*, user:user_id(id, name, email, avatar_url)`)
      .single();

    if (error) throw new Error(error.message);
    res.json({ success: true, number: data });
  } catch (err) {
    console.error('update phone number error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
