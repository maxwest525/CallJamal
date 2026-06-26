/**
 * AI provider proxy supporting Google Gemini and Anthropic Claude.
 * Set AI_PROVIDER=gemini|claude in your environment (defaults to gemini).
 *
 * Streaming: call chatStream(messages, res) to pipe SSE events to an Express response.
 * Non-streaming: call chat(messages) to get the full text response.
 */

const AI_PROVIDER = () => process.env.AI_PROVIDER || 'gemini';

// ── Gemini ──────────────────────────────────────────────────────────────────

async function geminiChat(messages) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  // Convert our message format {role, content} → Gemini format
  const history = messages.slice(0, -1).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const lastMessage = messages[messages.length - 1];

  const chat = model.startChat({ history });
  const result = await chat.sendMessage(lastMessage.content);
  return result.response.text();
}

async function geminiChatStream(messages, res) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  const history = messages.slice(0, -1).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const lastMessage = messages[messages.length - 1];

  const chat = model.startChat({ history });
  const result = await chat.sendMessageStream(lastMessage.content);

  for await (const chunk of result.stream) {
    const text = chunk.text();
    if (text) {
      res.write(`data: ${JSON.stringify({ text })}\n\n`);
    }
  }
  res.write('data: [DONE]\n\n');
}

// ── Claude ───────────────────────────────────────────────────────────────────

async function claudeChat(messages) {
  const Anthropic = require('@anthropic-ai/sdk');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const client = new Anthropic.default({ apiKey });
  const response = await client.messages.create({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 1024,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });
  return response.content[0]?.text || '';
}

async function claudeChatStream(messages, res) {
  const Anthropic = require('@anthropic-ai/sdk');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const client = new Anthropic.default({ apiKey });
  const stream = client.messages.stream({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 1024,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
    }
  }
  res.write('data: [DONE]\n\n');
}

// ── Public API ───────────────────────────────────────────────────────────────

async function chat(messages) {
  const provider = AI_PROVIDER();
  if (provider === 'claude') return claudeChat(messages);
  return geminiChat(messages);
}

async function chatStream(messages, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const provider = AI_PROVIDER();
  if (provider === 'claude') return claudeChatStream(messages, res);
  return geminiChatStream(messages, res);
}

module.exports = { chat, chatStream };
