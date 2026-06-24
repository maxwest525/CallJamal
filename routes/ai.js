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
    res.status(500).json({ error: err.message });
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
    // If headers already sent (streaming started), we can only close connection
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  }
});

module.exports = router;
