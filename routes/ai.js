const express = require('express');
const { chat, chatStream } = require('../lib/ai');

const router = express.Router();

/**
 * GET /api/ai/status
 * Returns AI provider configuration status
 */
router.get('/status', (req, res) => {
  const provider = process.env.AI_PROVIDER || 'gemini';
  const configured =
    provider === 'claude'
      ? Boolean(process.env.ANTHROPIC_API_KEY)
      : Boolean(process.env.GEMINI_API_KEY);

  res.json({ provider, configured });
});

/**
 * POST /api/ai/chat
 * Non-streaming AI chat completion
 * Body: { messages: [{ role: 'user'|'assistant', content: string }] }
 */
router.post('/chat', async (req, res) => {
  const { messages } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  try {
    const response = await chat(messages);
    res.json({ response });
  } catch (err) {
    console.error('AI chat error:', err.message);
    const message = process.env.NODE_ENV === 'development' ? err.message : 'AI service error. Check server configuration.';
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/ai/chat/stream
 * Streaming AI chat via Server-Sent Events (SSE)
 * Body: { messages: [{ role: 'user'|'assistant', content: string }] }
 *
 * The client receives events in the form:
 *   data: {"text": "chunk..."}\n\n
 *   data: [DONE]\n\n
 */
router.post('/chat/stream', async (req, res) => {
  const { messages } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  try {
    await chatStream(messages, res);
    res.end();
  } catch (err) {
    console.error('AI chat stream error:', err.message);
    const message = process.env.NODE_ENV === 'development' ? err.message : 'AI service error. Check server configuration.';
    // If headers already sent (streaming started), we can only close connection
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    } else {
      res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
      res.end();
    }
  }
});

/**
 * POST /api/ai/generate
 * Generate a contextual message draft for SMS, email, or template.
 * Body: {
 *   type: 'sms' | 'email' | 'email-reply' | 'template',
 *   context: {
 *     recipientName?, recipientCompany?, conversationHistory?,
 *     subject?, originalMessage?, tone?, purpose?,
 *     templateType? ('sms'|'email'), templatePurpose?
 *   }
 * }
 * Returns: { subject?, body, variables? }
 */
router.post('/generate', async (req, res) => {
  const { type, context = {} } = req.body;

  if (!type || !['sms', 'email', 'email-reply', 'template'].includes(type)) {
    return res.status(400).json({ error: 'type must be sms, email, email-reply, or template' });
  }

  const tone = context.tone || 'professional and friendly';
  let systemPrompt = '';
  let userPrompt = '';

  if (type === 'sms') {
    systemPrompt = 'You are a business SMS assistant. Write concise, professional text messages under 160 characters when possible. Do not include greetings like "Dear" — keep it conversational. Return ONLY the message text, no quotes or labels.';
    const parts = [];
    if (context.recipientName) parts.push(`Recipient: ${context.recipientName}`);
    if (context.recipientCompany) parts.push(`Company: ${context.recipientCompany}`);
    if (context.conversationHistory) parts.push(`Recent conversation:\n${context.conversationHistory}`);
    if (context.purpose) parts.push(`Purpose: ${context.purpose}`);
    else parts.push('Purpose: follow up with the client');
    parts.push(`Tone: ${tone}`);
    userPrompt = parts.join('\n');
  } else if (type === 'email') {
    systemPrompt = 'You are a business email assistant. Write professional emails. Return your response as JSON: {"subject": "...", "body": "..."}. The body should be plain text (no HTML). Do not wrap in markdown code blocks.';
    const parts = [];
    if (context.recipientName) parts.push(`Recipient: ${context.recipientName}`);
    if (context.recipientCompany) parts.push(`Company: ${context.recipientCompany}`);
    if (context.purpose) parts.push(`Purpose: ${context.purpose}`);
    else parts.push('Purpose: professional outreach');
    parts.push(`Tone: ${tone}`);
    userPrompt = parts.join('\n');
  } else if (type === 'email-reply') {
    systemPrompt = 'You are a business email assistant. Draft a reply to the email below. Return ONLY the reply body as plain text (no subject line, no HTML, no quotes or labels).';
    const parts = [];
    if (context.originalMessage) parts.push(`Original email:\n${context.originalMessage}`);
    if (context.subject) parts.push(`Subject: ${context.subject}`);
    if (context.recipientName) parts.push(`Replying to: ${context.recipientName}`);
    if (context.purpose) parts.push(`Purpose of reply: ${context.purpose}`);
    parts.push(`Tone: ${tone}`);
    userPrompt = parts.join('\n');
  } else if (type === 'template') {
    const tType = context.templateType || 'sms';
    systemPrompt = `You are a business messaging assistant. Create a reusable ${tType} template. Use {{variable_name}} placeholders for personalization (e.g. {{client_name}}, {{company}}, {{date}}). Return your response as JSON: {"name": "...", "body": "..."${tType === 'email' ? ', "subject": "..."' : ''}, "variables": ["var1","var2"]}. Do not wrap in markdown code blocks.`;
    const parts = [];
    if (context.templatePurpose) parts.push(`Template purpose: ${context.templatePurpose}`);
    else parts.push('Template purpose: general client communication');
    parts.push(`Type: ${tType}`);
    parts.push(`Tone: ${tone}`);
    userPrompt = parts.join('\n');
  }

  try {
    const response = await chat([
      { role: 'user', content: `${systemPrompt}\n\n${userPrompt}` },
    ]);

    let result = {};

    if (type === 'sms') {
      result = { body: response.trim() };
    } else if (type === 'email' || type === 'template') {
      try {
        const cleaned = response.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
        result = JSON.parse(cleaned);
      } catch {
        result = { body: response.trim() };
      }
    } else if (type === 'email-reply') {
      result = { body: response.trim() };
    }

    res.json({ generated: result });
  } catch (err) {
    console.error('AI generate error:', err.message);
    res.status(500).json({ error: 'AI generation failed. Check your AI provider configuration.' });
  }
});

module.exports = router;
