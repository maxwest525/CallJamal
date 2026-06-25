const express = require('express');
const { triggerOutbound, triggerOutboundWithResponse } = require('../lib/webhooks');
const { chat } = require('../lib/ai');
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

    // If the payload includes a prompt, generate an AI response
    if (payload.prompt) {
      try {
        const messages = [{ role: 'user', content: String(payload.prompt) }];
        result.aiResponse = await chat(messages);
      } catch (aiErr) {
        console.error('webhook inbound AI error:', aiErr.message);
        result.aiError = 'AI service unavailable';
      }
    }

    res.json(result);
  } catch (err) {
    console.error('inbound webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/webhooks/ai
 * Synchronous Gemini AI endpoint for Zapier / n8n automations.
 * Zapier can POST a prompt and receive the AI response in the same Zap step.
 *
 * Body: { prompt, context?, system? }
 *   prompt   – required – the user message sent to Gemini
 *   context  – optional – additional context prepended as a user turn
 *   system   – optional – system-level instruction prepended as the first user turn
 *
 * Returns: { response, provider, timestamp }
 */
router.post('/ai', async (req, res) => {
  const { prompt, context, system } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  try {
    const messages = [];

    if (system) {
      messages.push({ role: 'user', content: `[System instruction] ${system}` });
      messages.push({ role: 'assistant', content: 'Understood.' });
    }

    if (context) {
      messages.push({ role: 'user', content: `[Context] ${context}` });
      messages.push({ role: 'assistant', content: 'Got it.' });
    }

    messages.push({ role: 'user', content: prompt });

    const response = await chat(messages);

    await logActivity({
      userId: req.user?.id || null,
      action: 'webhook_ai_query',
      entityType: 'webhook',
      details: { promptPreview: prompt.slice(0, 100) },
      ipAddress: req.ip,
    });

    res.json({
      response,
      provider: process.env.AI_PROVIDER || 'gemini',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('webhook AI error:', err.message);
    const message = process.env.NODE_ENV === 'development' ? err.message : 'AI service error. Check server configuration.';
    res.status(500).json({ error: message });
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
