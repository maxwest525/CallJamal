const express = require('express');

const router = express.Router();

const DAILY_API_KEY = () => process.env.DAILY_CO_API_KEY;
const DAILY_DOMAIN  = () => process.env.DAILY_CO_DOMAIN;

// Clamp a number between min and max
function clamp(val, min, max) {
  return Math.min(Math.max(Number(val) || min, min), max);
}

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
 * Create a new Daily.co room and return its join URL.
 * Body:
 *   name?             — optional custom room name (alphanumeric + hyphens)
 *   expiryMinutes?    — room lifetime in minutes (15–480, default 60)
 *   startVideoOff?    — default camera-off on join (bool)
 *   startAudioOff?    — default mic-off on join (bool)
 *   maxParticipants?  — cap on number of participants (2–50)
 *   enableRecording?  — enable cloud recording (bool)
 *   waitingRoom?      — enable knocking / waiting room (bool)
 */
router.post('/create', async (req, res) => {
  if (!DAILY_API_KEY() || !DAILY_DOMAIN()) {
    return res.status(503).json({
      error: 'Daily.co not configured. Set DAILY_CO_API_KEY and DAILY_CO_DOMAIN in .env.',
      notConfigured: true,
    });
  }

  // Sanitise room name — only allow safe characters
  const userProvidedName = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const roomName = userProvidedName.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40) || `huddle-${Date.now()}`;

  const expiryMinutes = clamp(req.body.expiryMinutes ?? 60, 15, 480);
  const maxParticipants = req.body.maxParticipants ? clamp(req.body.maxParticipants, 2, 50) : undefined;
  const enableRecording = Boolean(req.body.enableRecording);
  const waitingRoom = Boolean(req.body.waitingRoom);
  const startVideoOff = Boolean(req.body.startVideoOff);
  const startAudioOff = Boolean(req.body.startAudioOff);

  try {
    const properties = {
      exp: Math.floor(Date.now() / 1000) + expiryMinutes * 60,
      enable_screenshare: true,
      enable_chat: true,
      start_video_off: startVideoOff,
      start_audio_off: startAudioOff,
      ...(maxParticipants && { max_participants: maxParticipants }),
      ...(enableRecording && { enable_recording: 'cloud' }),
      ...(waitingRoom && { enable_knocking: true }),
    };

    const response = await fetch('https://api.daily.co/v1/rooms', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + DAILY_API_KEY(),
      },
      body: JSON.stringify({ name: roomName, properties }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `Daily.co API error: ${response.status}`);
    }

    const room = await response.json();
    res.json({
      name: room.name,
      url: room.url,
      expiresAt: new Date((properties.exp) * 1000).toISOString(),
      waitingRoom: waitingRoom,
      recordingEnabled: enableRecording,
    });
  } catch (err) {
    console.error('Create meeting error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/meetings/token
 * Generate a Daily.co meeting token that gates entry to a specific room.
 * Only clients that request a token through this server can join.
 * Body:
 *   roomName         — room to grant access to
 *   userName?        — display name for the participant
 *   isOwner?         — grant owner/host privileges (bool, default false)
 *   startAudioOff?   — default mic-off (bool)
 *   startVideoOff?   — default camera-off (bool)
 */
router.post('/token', async (req, res) => {
  if (!DAILY_API_KEY()) {
    return res.status(503).json({ error: 'Daily.co not configured.', notConfigured: true });
  }

  const { roomName, userName, isOwner = false, startAudioOff = false, startVideoOff = false } = req.body;

  if (!roomName || typeof roomName !== 'string' || !roomName.trim()) {
    return res.status(400).json({ error: 'roomName is required.' });
  }

  try {
    const properties = {
      room_name: roomName.trim(),
      is_owner: Boolean(isOwner),
      start_audio_off: Boolean(startAudioOff),
      start_video_off: Boolean(startVideoOff),
      exp: Math.floor(Date.now() / 1000) + 7200, // token valid for 2 hours
    };

    if (userName && typeof userName === 'string' && userName.trim()) {
      properties.user_name = userName.trim().slice(0, 50);
    }

    const response = await fetch('https://api.daily.co/v1/meeting-tokens', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + DAILY_API_KEY(),
      },
      body: JSON.stringify({ properties }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `Daily.co API error: ${response.status}`);
    }

    const data = await response.json();
    res.json({ token: data.token, roomName: roomName.trim() });
  } catch (err) {
    console.error('Create token error:', err.message);
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
      headers: { Authorization: 'Bearer ' + DAILY_API_KEY() },
    });

    if (!response.ok) {
      throw new Error(`Daily.co API error: ${response.status}`);
    }

    const data = await response.json();
    const now = Math.floor(Date.now() / 1000);
    const active = (data.data || []).filter(r => !r.config?.exp || r.config.exp > now);
    res.json({
      rooms: active.map(r => ({
        name: r.name,
        url: r.url,
        expiresAt: r.config?.exp ? new Date(r.config.exp * 1000).toISOString() : null,
        waitingRoom: Boolean(r.config?.enable_knocking),
        recordingEnabled: Boolean(r.config?.enable_recording),
      })),
    });
  } catch (err) {
    console.error('List rooms error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
