const express = require('express');

const router = express.Router();

const DAILY_API_KEY = () => process.env.DAILY_CO_API_KEY;
const DAILY_DOMAIN  = () => process.env.DAILY_CO_DOMAIN;

/**
 * GET /api/meetings/status
 * Returns whether Daily.co is configured
 */
router.get('/status', (req, res) => {
  res.json({
    configured: Boolean(DAILY_API_KEY() && DAILY_DOMAIN()),
    domain: DAILY_DOMAIN() || null,
  });
});

/**
 * POST /api/meetings/create
 * Create a new Daily.co room and return its join URL
 * Body: { name? } — optional custom room name (alphanumeric + hyphens)
 */
router.post('/create', async (req, res) => {
  if (!DAILY_API_KEY() || !DAILY_DOMAIN()) {
    return res.status(503).json({
      error: 'Daily.co not configured. Set DAILY_CO_API_KEY and DAILY_CO_DOMAIN in .env.',
      notConfigured: true,
    });
  }

  // Sanitise the provided name — only allow safe characters
  const userProvidedName = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const roomName = userProvidedName.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40) || `huddle-${Date.now()}`;

  try {
    const response = await fetch('https://api.daily.co/v1/rooms', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + DAILY_API_KEY(),
      },
      body: JSON.stringify({
        name: roomName,
        properties: {
          exp: Math.floor(Date.now() / 1000) + 3600, // expires in 1 hour
          enable_screenshare: true,
          enable_chat: true,
          start_video_off: false,
          start_audio_off: false,
        },
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `Daily.co API error: ${response.status}`);
    }

    const room = await response.json();
    res.json({ name: room.name, url: room.url });
  } catch (err) {
    console.error('Create meeting error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/meetings/rooms
 * List active Daily.co rooms (non-expired, newest 20)
 */
router.get('/rooms', async (req, res) => {
  if (!DAILY_API_KEY()) {
    return res.status(503).json({ error: 'Daily.co not configured.', notConfigured: true });
  }

  try {
    const response = await fetch('https://api.daily.co/v1/rooms?limit=20', {
      headers: { Authorization: 'Bearer ' + DAILY_API_KEY(),},
    });

    if (!response.ok) {
      throw new Error(`Daily.co API error: ${response.status}`);
    }

    const data = await response.json();
    const now = Math.floor(Date.now() / 1000);
    const active = (data.data || []).filter(r => !r.config?.exp || r.config.exp > now);
    res.json({ rooms: active.map(r => ({ name: r.name, url: r.url })) });
  } catch (err) {
    console.error('List rooms error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
