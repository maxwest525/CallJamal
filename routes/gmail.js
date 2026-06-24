const express = require('express');
const rateLimit = require('express-rate-limit');
const { google } = require('googleapis');
const { getOAuth2Client, getAuthenticatedClient, setTokens, getTokens, SCOPES, extractBody, buildRawEmail } = require('../lib/gmail');
const { logActivity } = require('../lib/supabase');

const router = express.Router();

// Tight limit for auth-initiating endpoint
const authUrlLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

/**
 * GET /api/gmail/status
 * Returns whether Gmail is connected
 */
router.get('/status', (req, res) => {
  res.json({ connected: getTokens() !== null });
});

/**
 * GET /api/gmail/auth-url
 * Returns the Google OAuth2 authorization URL for Gmail
 */
router.get('/auth-url', authUrlLimiter, (req, res) => {
  try {
    const oauth2Client = getOAuth2Client();
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
    });
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/gmail/inbox
 * List recent emails from the authenticated user's inbox
 * Query: { maxResults=20, pageToken }
 */
router.get('/inbox', async (req, res) => {
  const { maxResults = 20, pageToken } = req.query;

  try {
    const auth = getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });

    const listParams = {
      userId: 'me',
      labelIds: ['INBOX'],
      maxResults: Math.min(Number(maxResults), 100),
    };
    if (pageToken) listParams.pageToken = pageToken;

    const listRes = await gmail.users.messages.list(listParams);
    const messages = listRes.data.messages || [];

    // Fetch metadata for each message in parallel (capped at 20 to avoid timeouts)
    const details = await Promise.all(
      messages.slice(0, 20).map((m) =>
        gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] })
          .then((r) => {
            const headers = {};
            (r.data.payload?.headers || []).forEach((h) => { headers[h.name] = h.value; });
            return {
              id: m.id,
              threadId: m.threadId,
              snippet: r.data.snippet,
              from: headers['From'] || '',
              to: headers['To'] || '',
              subject: headers['Subject'] || '(no subject)',
              date: headers['Date'] || '',
              labelIds: r.data.labelIds || [],
              unread: (r.data.labelIds || []).includes('UNREAD'),
            };
          })
          .catch(() => null)
      )
    );

    res.json({
      messages: details.filter(Boolean),
      nextPageToken: listRes.data.nextPageToken || null,
    });
  } catch (err) {
    console.error('gmail inbox error:', err.message);
    if (err.message.includes('not connected')) {
      return res.status(401).json({ error: err.message, needsAuth: true });
    }
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/gmail/message/:id
 * Get full body of a single email
 */
router.get('/message/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const auth = getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });
    const r = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const headers = {};
    (r.data.payload?.headers || []).forEach((h) => { headers[h.name] = h.value; });

    res.json({
      id,
      threadId: r.data.threadId,
      from: headers['From'] || '',
      to: headers['To'] || '',
      subject: headers['Subject'] || '(no subject)',
      date: headers['Date'] || '',
      body: extractBody(r.data.payload),
      snippet: r.data.snippet,
      labelIds: r.data.labelIds || [],
    });
  } catch (err) {
    console.error('gmail get message error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/gmail/send
 * Send an email via the authenticated Gmail account
 * Body: { to, subject, body }
 */
router.post('/send', async (req, res) => {
  const { to, subject, body } = req.body;

  if (!to || !subject || !body) {
    return res.status(400).json({ error: 'to, subject, and body are required' });
  }

  try {
    const auth = getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });

    // Get the authenticated user's email address
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const from = profile.data.emailAddress;

    const raw = buildRawEmail({ to, subject, body, from });
    const sendRes = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });

    await logActivity({
      userId: req.user?.id,
      action: 'gmail_sent',
      entityType: 'email',
      entityId: sendRes.data.id,
      details: { to, subject: subject.slice(0, 100) },
      ipAddress: req.ip,
    });

    res.json({ success: true, messageId: sendRes.data.id });
  } catch (err) {
    console.error('gmail send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/gmail/message/:id/read
 * Mark an email as read
 */
router.patch('/message/:id/read', async (req, res) => {
  const { id } = req.params;
  try {
    const auth = getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });
    await gmail.users.messages.modify({
      userId: 'me',
      id,
      requestBody: { removeLabelIds: ['UNREAD'] },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
