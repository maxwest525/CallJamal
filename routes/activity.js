const express = require('express');
const { supabase } = require('../lib/supabase');

const router = express.Router();

/**
 * GET /api/activity
 * Retrieve recent activity log entries.
 * Query: { limit=50, offset=0, action?, entityType? }
 */
router.get('/', async (req, res) => {
  const { limit = 50, offset = 0, action, entityType } = req.query;

  try {
    let query = supabase
      .from('activity_log')
      .select(`
        *,
        user:user_id(id, name, email, avatar_url)
      `)
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Math.min(Number(limit), 200) - 1);

    if (action) query = query.eq('action', action);
    if (entityType) query = query.eq('entity_type', entityType);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    res.json({ activity: data || [] });
  } catch (err) {
    console.error('activity log error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
