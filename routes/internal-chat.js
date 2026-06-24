const express = require('express');
const { supabase } = require('../lib/supabase');

const router = express.Router();

/**
 * GET /api/internal-chat/messages
 * Get recent internal chat messages
 * Query: { limit=50, since } (since = ISO timestamp)
 */
router.get('/messages', async (req, res) => {
  const { limit = 50, since } = req.query;

  try {
    let query = supabase
      .from('internal_messages')
      .select('*')
      .order('created_at', { ascending: true })
      .limit(Math.min(Number(limit), 200));

    if (since) {
      query = query.gt('created_at', since);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    res.json({ messages: data || [] });
  } catch (err) {
    console.error('internal chat get error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/internal-chat/send
 * Post a message to the internal team chat
 * Body: { body, senderId, senderName }
 */
router.post('/send', async (req, res) => {
  const { body, senderId, senderName } = req.body;

  if (!body) {
    return res.status(400).json({ error: 'body is required' });
  }

  try {
    const { data, error } = await supabase
      .from('internal_messages')
      .insert({
        body,
        sender_id: senderId || null,
        sender_name: senderName || 'Team Member',
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    res.status(201).json({ message: data });
  } catch (err) {
    console.error('internal chat send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
