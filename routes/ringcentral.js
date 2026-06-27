const express = require('express');
const rc = require('../lib/ringcentral');
const { supabase, logActivity } = require('../lib/supabase');
const { triggerOutbound } = require('../lib/webhooks');

const router = express.Router();

/**
 * GET /api/ringcentral/status
 * Check if RingCentral is configured
 */
router.get('/status', (req, res) => {
  res.json({
    configured: rc.isConfigured(),
    sandbox: process.env.RINGCENTRAL_SANDBOX === 'true',
  });
});

/**
 * GET /api/ringcentral/extensions
 * List all user extensions (each agent's phone number)
 */
router.get('/extensions', async (req, res) => {
  try {
    const extensions = await rc.getExtensions();
    res.json({ extensions });
  } catch (err) {
    console.error('RC extensions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/ringcentral/presence
 * Get live presence for all extensions — maps to office room placement
 */
router.get('/presence', async (req, res) => {
  try {
    const presenceData = await rc.getAllPresence();
    const mapped = presenceData.map(ext => ({
      ...ext,
      officeStatus: rc.mapPresenceToOfficeStatus(ext.presence),
      activeCalls: ext.presence?.activeCalls || [],
      onCall: ext.presence?.telephonyStatus === 'CallConnected',
      ringing: ext.presence?.telephonyStatus === 'Ringing',
      talkingTo: ext.presence?.activeCalls?.[0]
        ? (ext.presence.activeCalls[0].direction === 'Inbound'
          ? ext.presence.activeCalls[0].from
          : ext.presence.activeCalls[0].to)
        : null,
    }));
    res.json({ presence: mapped });
  } catch (err) {
    console.error('RC presence error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/ringcentral/sms
 * Send SMS from an agent's RingCentral number
 * Body: { to, message, from?, senderId?, clientId? }
 */
router.post('/sms', async (req, res) => {
  const { to, message, from, senderId, clientId } = req.body;

  if (!to || !message) {
    return res.status(400).json({ error: 'to and message are required' });
  }

  try {
    const result = await rc.sendSms({
      to,
      message,
      from: from || process.env.RINGCENTRAL_MAIN_NUMBER,
    });

    await logActivity({
      userId: senderId,
      action: 'rc_sms_sent',
      entityType: 'message',
      details: { to, messagePreview: message.slice(0, 50), provider: 'ringcentral' },
      ipAddress: req.ip,
    });

    triggerOutbound('sms_sent', {
      to,
      messagePreview: message.slice(0, 100),
      clientId,
      provider: 'ringcentral',
    }).catch(() => {});

    res.json({ success: true, result });
  } catch (err) {
    console.error('RC SMS error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/ringcentral/call
 * Initiate a RingOut call (rings agent's phone, then connects to target)
 * Body: { to, from? }
 */
router.post('/call', async (req, res) => {
  const { to, from } = req.body;

  if (!to) {
    return res.status(400).json({ error: 'to is required' });
  }

  try {
    const result = await rc.makeCall({
      to,
      from: from || process.env.RINGCENTRAL_MAIN_NUMBER,
    });
    res.json({ success: true, result });
  } catch (err) {
    console.error('RC call error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/ringcentral/call-log
 * Get call history with optional filters
 * Query: { extensionId?, dateFrom?, dateTo?, perPage? }
 */
router.get('/call-log', async (req, res) => {
  const { extensionId, dateFrom, dateTo, perPage } = req.query;

  try {
    const records = await rc.getCallLog({
      extensionId,
      dateFrom,
      dateTo,
      perPage: perPage ? Number(perPage) : 50,
    });
    res.json({ callLog: records });
  } catch (err) {
    console.error('RC call-log error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/ringcentral/call-log/activity
 * Get a live activity feed — recent calls with active call indicators
 */
router.get('/call-log/activity', async (req, res) => {
  try {
    const now = new Date();
    const oneHourAgo = new Date(now - 60 * 60 * 1000);
    const [callLog, presenceData] = await Promise.all([
      rc.getCallLog({ dateFrom: oneHourAgo.toISOString(), perPage: 30 }),
      rc.getAllPresence(),
    ]);

    const activeCalls = presenceData
      .filter(ext => ext.presence?.telephonyStatus === 'CallConnected')
      .map(ext => ({
        agent: ext.name,
        extensionId: ext.id,
        direction: ext.presence.activeCalls?.[0]?.direction || 'Unknown',
        talkingTo: ext.presence.activeCalls?.[0]?.direction === 'Inbound'
          ? ext.presence.activeCalls[0].from
          : ext.presence.activeCalls?.[0]?.to,
        sessionId: ext.presence.activeCalls?.[0]?.sessionId,
      }));

    res.json({ activeCalls, recentCalls: callLog });
  } catch (err) {
    console.error('RC activity feed error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/ringcentral/webhook
 * Inbound webhook from RingCentral (SMS received, call events, etc.)
 * Configure in RingCentral Developer Portal → Webhooks
 */
router.post('/webhook', async (req, res) => {
  const validationToken = req.headers['validation-token'];
  if (validationToken) {
    res.setHeader('Validation-Token', validationToken);
    return res.status(200).end();
  }

  const event = req.body;
  const eventType = event?.event;

  try {
    if (eventType?.includes('/message-store')) {
      const msg = event.body;
      if (msg?.type === 'SMS' && msg?.direction === 'Inbound') {
        const fromNumber = msg.from?.phoneNumber;
        const messageBody = msg.subject || '';

        triggerOutbound('sms_received', {
          from: fromNumber,
          messagePreview: messageBody.slice(0, 100),
          provider: 'ringcentral',
        }).catch(() => {});
      }
    }

    if (eventType?.includes('/presence')) {
      const presence = event.body;
      triggerOutbound('presence_changed', {
        extensionId: presence?.extensionId,
        telephonyStatus: presence?.telephonyStatus,
        userStatus: presence?.userStatus,
        provider: 'ringcentral',
      }).catch(() => {});
    }

    res.json({ success: true });
  } catch (err) {
    console.error('RC webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/ringcentral/ai/call-summary
 * Generate AI summary, sentiment, and coaching tips for a call recording
 * Body: { callId, transcript? }
 */
router.post('/ai/call-summary', async (req, res) => {
  const { callId, transcript } = req.body;

  if (!callId && !transcript) {
    return res.status(400).json({ error: 'callId or transcript is required' });
  }

  try {
    const ai = require('../lib/ai');
    let callTranscript = transcript;

    if (!callTranscript && callId) {
      callTranscript = `[Call ID: ${callId} — transcript would be fetched from RingCentral AI API when connected]`;
    }

    const prompt = `Analyze this call and provide a JSON response with these fields:
- summary: 2-3 sentence call summary
- sentiment: "positive", "neutral", or "negative"
- sentimentScore: 1-10
- keyTopics: array of main topics discussed
- actionItems: array of follow-up tasks
- coachingTips: array of 2-3 coaching suggestions for the agent
- clientSatisfaction: "satisfied", "neutral", or "dissatisfied"

Call transcript/context:
${callTranscript}`;

    const result = await ai.generate({
      prompt,
      systemPrompt: 'You are a call center AI analyst. Return valid JSON only, no markdown.',
      maxTokens: 1000,
    });

    let analysis;
    try {
      analysis = JSON.parse(result.text || result);
    } catch {
      analysis = {
        summary: result.text || result,
        sentiment: 'neutral',
        sentimentScore: 5,
        keyTopics: [],
        actionItems: [],
        coachingTips: [],
        clientSatisfaction: 'neutral',
      };
    }

    res.json({ success: true, analysis });
  } catch (err) {
    console.error('RC AI summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
