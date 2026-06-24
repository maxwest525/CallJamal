const express = require('express');
const { triggerOutbound } = require('../lib/webhooks');
const { supabase, logActivity } = require('../lib/supabase');

const router = express.Router();

/**
 * GET /api/webhooks/status
 * Returns configured webhook URLs (redacted) and integration status
 */
router.get('/status', (req, res) => {
  const zapierUrl = process.env.ZAPIER_WEBHOOK_URL;
  const n8nUrl = process.env.N8N_WEBHOOK_URL;

  function redact(url) {
    if (!url) return null;
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}${u.pathname.slice(0, 20)}…`;
    } catch {
      return url.slice(0, 30) + '…';
    }
  }

  res.json({
    zapier: { configured: Boolean(zapierUrl), url: redact(zapierUrl) },
    n8n: { configured: Boolean(n8nUrl), url: redact(n8nUrl) },
    inboundUrl: `${process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`}/api/webhooks/inbound`,
  });
});

/**
 * POST /api/webhooks/inbound
 * Generic inbound webhook endpoint for Zapier / n8n automations.
 * Expects a JSON body with at least a "type" field that identifies the event.
 *
 * Example payload:
 *   { "type": "new_lead", "name": "Alice", "email": "alice@example.com" }
 */
router.post('/inbound', async (req, res) => {
  const payload = req.body;
  const eventType = payload?.type || 'unknown';

  try {
    await logActivity({
      userId: req.user?.id || null,
      action: `webhook_inbound_${eventType}`,
      entityType: 'webhook',
      details: payload,
      ipAddress: req.ip,
    });

    // Route by type
    let result = { received: true, type: eventType };

    if (eventType === 'new_lead' || eventType === 'new_client') {
      const { name, email, phone, company, notes } = payload;
      if (name && phone) {
        const { data, error } = await supabase.from('clients').insert({
          name,
          email: email || null,
          phone,
          company: company || null,
          notes: notes || null,
        }).select().single();

        if (error) {
          console.error('webhook new_lead insert error:', error.message);
        } else {
          result.clientId = data.id;
          result.action = 'client_created';
        }
      }
    }

    res.json(result);
  } catch (err) {
    console.error('inbound webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/webhooks/test
 * Fire a test event to all configured outbound webhook URLs
 * Body: { event? }
 */
router.post('/test', async (req, res) => {
  const event = req.body?.event || 'test_event';
  try {
    await triggerOutbound(event, {
      message: 'This is a test webhook from CallJamal Virtual Office',
      timestamp: new Date().toISOString(),
    });

    await logActivity({
      userId: req.user?.id || null,
      action: 'webhook_test',
      details: { event },
      ipAddress: req.ip,
    });

    res.json({ success: true, event });
  } catch (err) {
    console.error('webhook test error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
