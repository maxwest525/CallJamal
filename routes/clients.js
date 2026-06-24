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

/** Normalize phone number to E.164 format (digits only, with leading country code) */
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

/**
 * GET /api/clients
 * Get all clients with optional search and filters
 * Query: { search, assignedTo, isActive, limit, offset }
 */
router.get('/', async (req, res) => {
  const { search, assignedTo, isActive, limit = 50, offset = 0 } = req.query;

  try {
    let query = supabase
      .from('clients')
      .select(`
        *,
        assigned_user:assigned_to(id, name, email, avatar_url)
      `)
      .order('name')
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (search) query = query.or(`name.ilike.%${search}%,company.ilike.%${search}%,phone.ilike.%${search}%`);
    if (assignedTo) query = query.eq('assigned_to', assignedTo);
    if (isActive !== undefined) query = query.eq('is_active', isActive === 'true');

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    res.json({ clients: data });
  } catch (err) {
    console.error('get clients error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/clients/:id
 * Get a single client by ID
 */
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from('clients')
      .select(`
        *,
        assigned_user:assigned_to(id, name, email, avatar_url),
        conversation:sms_conversations(id, last_message, last_message_at, unread_count)
      `)
      .eq('id', id)
      .single();

    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: 'Client not found' });

    res.json({ client: data });
  } catch (err) {
    console.error('get client error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/clients
 * Create a new client
 * Body: { name, company, email, phone, notes, tags, assignedTo }
 */
router.post('/', async (req, res) => {
  const { name, company, email, phone, notes, tags, assignedTo } = req.body;

  if (!name || !phone) {
    return res.status(400).json({ error: 'name and phone are required' });
  }

  try {
    const { data, error } = await supabase
      .from('clients')
      .insert({
        name,
        company: company || null,
        email: email || null,
        phone,
        phone_normalized: normalizePhone(phone),
        notes: notes || null,
        tags: tags || null,
        assigned_to: assignedTo || null,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    await logActivity({
      action: 'client_created',
      entityType: 'client',
      entityId: data.id,
      details: { name, phone },
      ipAddress: req.ip,
    });

    res.status(201).json({ client: data });
  } catch (err) {
    console.error('create client error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/clients/:id
 * Update a client
 * Body: any client fields
 */
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, company, email, phone, notes, tags, assignedTo, isActive } = req.body;

  try {
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (company !== undefined) updates.company = company;
    if (email !== undefined) updates.email = email;
    if (phone !== undefined) {
      updates.phone = phone;
      updates.phone_normalized = normalizePhone(phone);
    }
    if (notes !== undefined) updates.notes = notes;
    if (tags !== undefined) updates.tags = tags;
    if (assignedTo !== undefined) updates.assigned_to = assignedTo;
    if (isActive !== undefined) updates.is_active = isActive;

    const { data, error } = await supabase
      .from('clients')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw new Error(error.message);

    await logActivity({
      action: 'client_updated',
      entityType: 'client',
      entityId: id,
      details: updates,
      ipAddress: req.ip,
    });

    res.json({ client: data });
  } catch (err) {
    console.error('update client error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/clients/:id
 * Soft-delete a client (sets is_active to false)
 */
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const { error } = await supabase.from('clients').update({ is_active: false }).eq('id', id);
    if (error) throw new Error(error.message);

    await logActivity({
      action: 'client_deleted',
      entityType: 'client',
      entityId: id,
      ipAddress: req.ip,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('delete client error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/clients/:id/sms
 * Send an SMS to a specific client
 * Body: { message, senderId }
 */
router.post('/:id/sms', async (req, res) => {
  const { id } = req.params;
  const { message, senderId } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }

  try {
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('id, name, phone')
      .eq('id', id)
      .single();

    if (clientError || !client) return res.status(404).json({ error: 'Client not found' });

    const slicktextResponse = await axios.post(
      `${SLICKTEXT_API_BASE}/send`,
      { number: client.phone, message, from: SLICKTEXT_MAIN_NUMBER },
      { headers: slicktextAuth() }
    );

    const conversation = await upsertConversation({
      phoneNumber: client.phone,
      clientId: client.id,
      lastMessage: message,
    });

    const { data: msg, error: msgError } = await supabase.from('messages').insert({
      conversation_id: conversation.id,
      direction: 'outbound',
      message_type: 'external',
      from_number: SLICKTEXT_MAIN_NUMBER,
      to_number: client.phone,
      body: message,
      status: 'sent',
      sender_id: senderId || null,
      client_id: client.id,
      slicktext_message_id: slicktextResponse.data?.id || null,
    }).select().single();

    if (msgError) throw new Error(msgError.message);

    await supabase.from('clients').update({ last_contacted_at: new Date().toISOString() }).eq('id', id);

    await logActivity({
      userId: senderId,
      action: 'sms_sent_to_client',
      entityType: 'client',
      entityId: id,
      details: { clientName: client.name, messagePreview: message.slice(0, 50) },
      ipAddress: req.ip,
    });

    res.json({ success: true, message: msg });
  } catch (err) {
    console.error('client sms error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/clients/:id/conversations
 * Get SMS conversation history for a client
 * Query: { limit, offset }
 */
router.get('/:id/conversations', async (req, res) => {
  const { id } = req.params;
  const { limit = 50, offset = 0 } = req.query;

  try {
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('id, phone')
      .eq('id', id)
      .single();

    if (clientError || !client) return res.status(404).json({ error: 'Client not found' });

    const { data: conversation } = await supabase
      .from('sms_conversations')
      .select('id')
      .eq('client_id', id)
      .maybeSingle();

    if (!conversation) return res.json({ messages: [] });

    const { data: messages, error: msgError } = await supabase
      .from('messages')
      .select(`
        *,
        sender:sender_id(id, name, email, avatar_url)
      `)
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: true })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (msgError) throw new Error(msgError.message);

    res.json({ messages });
  } catch (err) {
    console.error('get conversations error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/clients/conversations/all
 * Get all SMS conversations grouped by thread
 * Query: { limit, offset }
 */
router.get('/conversations/all', async (req, res) => {
  const { limit = 20, offset = 0 } = req.query;

  try {
    const { data, error } = await supabase
      .from('sms_conversations')
      .select(`
        *,
        client:client_id(id, name, company, phone),
        assigned_user:assigned_to(id, name, email, avatar_url)
      `)
      .order('last_message_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (error) throw new Error(error.message);

    res.json({ conversations: data });
  } catch (err) {
    console.error('get all conversations error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
