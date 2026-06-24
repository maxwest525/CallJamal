const express = require('express');
const { postMessage, listChannels, getChannelHistory, verifySlackSignature } = require('../lib/slack');
const { logActivity } = require('../lib/supabase');

const router = express.Router();

/**
 * GET /api/slack/status
 * Returns whether Slack bot token is configured
 */
router.get('/status', (req, res) => {
  res.json({ connected: Boolean(process.env.SLACK_BOT_TOKEN) });
});

/**
 * GET /api/slack/channels
 * List all Slack channels the bot can access
 */
router.get('/channels', async (req, res) => {
  try {
    const channels = await listChannels();
    res.json({
      channels: channels.map((c) => ({
        id: c.id,
        name: c.name,
        topic: c.topic?.value || '',
        memberCount: c.num_members || 0,
        isPrivate: c.is_private || false,
      })),
    });
  } catch (err) {
    console.error('slack channels error:', err.message);
    if (err.message.includes('not configured')) {
      return res.status(501).json({ error: err.message, notConfigured: true });
    }
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/slack/channels/:channelId/history
 * Get recent messages for a Slack channel
 * Query: { limit=50 }
 */
router.get('/channels/:channelId/history', async (req, res) => {
  const { channelId } = req.params;
  const { limit = 50 } = req.query;

  try {
    const messages = await getChannelHistory(channelId, Math.min(Number(limit), 200));
    res.json({ messages });
  } catch (err) {
    console.error('slack history error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/slack/send
 * Send a message to a Slack channel
 * Body: { channel, text, senderId }
 */
router.post('/send', async (req, res) => {
  const { channel, text, senderId } = req.body;

  if (!channel || !text) {
    return res.status(400).json({ error: 'channel and text are required' });
  }

  try {
    const result = await postMessage({ channel, text });

    await logActivity({
      userId: senderId,
      action: 'slack_message_sent',
      entityType: 'slack_message',
      entityId: result.ts,
      details: { channel, textPreview: text.slice(0, 100) },
      ipAddress: req.ip,
    });

    res.json({ success: true, ts: result.ts, channel: result.channel });
  } catch (err) {
    console.error('slack send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/slack/events
 * Incoming Slack Events API webhook
 * Handles URL verification and message events
 *
 * Note: express.json() on the app level will parse the body before this route runs.
 * We use req.body directly (already parsed object) and skip raw-body signature verification.
 * For production, add a rawBody capture middleware before express.json() to enable
 * proper HMAC verification via verifySlackSignature().
 */
router.post('/events', (req, res) => {
  const payload = req.body;

  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  // Slack URL verification challenge
  if (payload.type === 'url_verification') {
    return res.json({ challenge: payload.challenge });
  }

  // Handle incoming events
  if (payload.type === 'event_callback') {
    const event = payload.event;
    // Log incoming message events (non-bot)
    if (event?.type === 'message' && !event.bot_id) {
      console.log(`[Slack] ${event.channel}: <${event.user}> ${event.text}`);
      // TODO: persist incoming Slack messages to DB if needed
    }
  }

  res.sendStatus(200);
});

module.exports = router;
