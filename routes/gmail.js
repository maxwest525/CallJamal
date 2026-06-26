const express = require('express');
const rateLimit = require('express-rate-limit');
const { google } = require('googleapis');
const { getOAuth2Client, getAuthenticatedClient, setTokens, getTokens, SCOPES, extractBody, buildRawEmail, buildHtmlEmail } = require('../lib/gmail');
const { supabase, logActivity } = require('../lib/supabase');
const { triggerOutbound } = require('../lib/webhooks');

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
router.get('/status', async (req, res) => {
  const tokens = await getTokens(); res.json({ connected: tokens !== null });
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
  const { maxResults = 20, pageToken, labelIds } = req.query;

  try {
    const auth = await getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });

    const listParams = {
      userId: 'me',
      labelIds: labelIds ? [labelIds] : ['INBOX'],
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
    const auth = await getAuthenticatedClient();
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
    const auth = await getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });

    // Get the authenticated user's email address
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const from = profile.data.emailAddress;

    // Load brand settings (best-effort — fall back to plain text if unavailable)
    let brand = null;
    try {
      const { data: brandRow } = await supabase
        .from('brand_settings')
        .select('*')
        .limit(1)
        .maybeSingle();
      if (brandRow) brand = brandRow;
    } catch (_) { /* ignore — brand is optional */ }

    const raw = buildHtmlEmail({ to, subject, body, from, brand });
    const sendRes = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });

    await logActivity({
      userId: req.user?.id,
      action: 'gmail_sent',
      entityType: 'email',
      entityId: sendRes.data.id,
      details: { to, subject: subject.slice(0, 100) },
      ipAddress: req.ip,
    });

    triggerOutbound('email_sent', { to, subject: subject.slice(0, 100), messageId: sendRes.data.id }).catch(() => {});

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
    const auth = await getAuthenticatedClient();
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

/**
 * GET /api/gmail/labels
 * List all Gmail labels
 */
router.get('/labels', async (req, res) => {
  try {
    const auth = await getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });
    const r = await gmail.users.labels.list({ userId: 'me' });
    const labels = (r.data.labels || []).map((l) => ({
      id: l.id,
      name: l.name,
      type: l.type,
      messagesTotal: l.messagesTotal,
      messagesUnread: l.messagesUnread,
    }));
    res.json({ labels });
  } catch (err) {
    console.error('gmail labels error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/gmail/labels
 * Create a new Gmail label
 * Body: { name, labelListVisibility?, messageListVisibility? }
 */
router.post('/labels', async (req, res) => {
  const { name, labelListVisibility = 'labelShow', messageListVisibility = 'show' } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const auth = await getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });
    const r = await gmail.users.labels.create({
      userId: 'me',
      requestBody: { name, labelListVisibility, messageListVisibility },
    });
    res.json({ label: r.data });
  } catch (err) {
    console.error('gmail create label error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/gmail/message/:id/labels
 * Add or remove labels from a message
 * Body: { addLabelIds?: string[], removeLabelIds?: string[] }
 */
router.post('/message/:id/labels', async (req, res) => {
  const { id } = req.params;
  const { addLabelIds = [], removeLabelIds = [] } = req.body;

  try {
    const auth = await getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });
    await gmail.users.messages.modify({
      userId: 'me',
      id,
      requestBody: { addLabelIds, removeLabelIds },
    });
    res.json({ success: true });
  } catch (err) {
    console.error('gmail modify labels error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/gmail/search
 * Search emails using Gmail query syntax
 * Query: { q, maxResults=20, pageToken }
 */
router.get('/search', async (req, res) => {
  const { q, maxResults = 20, pageToken } = req.query;
  if (!q) return res.status(400).json({ error: 'q (search query) is required' });

  try {
    const auth = await getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });
    const listParams = {
      userId: 'me',
      q,
      maxResults: Math.min(Number(maxResults), 100),
    };
    if (pageToken) listParams.pageToken = pageToken;

    const listRes = await gmail.users.messages.list(listParams);
    const messages = listRes.data.messages || [];

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
      resultSizeEstimate: listRes.data.resultSizeEstimate || 0,
    });
  } catch (err) {
    console.error('gmail search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/gmail/drafts
 * List drafts
 * Query: { maxResults=20, pageToken }
 */
router.get('/drafts', async (req, res) => {
  const { maxResults = 20, pageToken } = req.query;
  try {
    const auth = await getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });
    const listParams = { userId: 'me', maxResults: Math.min(Number(maxResults), 50) };
    if (pageToken) listParams.pageToken = pageToken;

    const listRes = await gmail.users.drafts.list(listParams);
    const drafts = listRes.data.drafts || [];

    const details = await Promise.all(
      drafts.slice(0, 20).map((d) =>
        gmail.users.drafts.get({ userId: 'me', id: d.id, format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] })
          .then((r) => {
            const headers = {};
            (r.data.message?.payload?.headers || []).forEach((h) => { headers[h.name] = h.value; });
            return {
              draftId: d.id,
              messageId: r.data.message?.id,
              snippet: r.data.message?.snippet || '',
              from: headers['From'] || '',
              to: headers['To'] || '',
              subject: headers['Subject'] || '(no subject)',
              date: headers['Date'] || '',
            };
          })
          .catch(() => null)
      )
    );

    res.json({
      drafts: details.filter(Boolean),
      nextPageToken: listRes.data.nextPageToken || null,
    });
  } catch (err) {
    console.error('gmail drafts list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/gmail/drafts
 * Create a draft email
 * Body: { to, subject, body }
 */
router.post('/drafts', async (req, res) => {
  const { to, subject, body } = req.body;
  if (!to || !subject || !body) {
    return res.status(400).json({ error: 'to, subject, and body are required' });
  }

  try {
    const auth = await getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const from = profile.data.emailAddress;

    const raw = buildRawEmail({ to, subject, body, from });
    const r = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw } },
    });

    res.json({ success: true, draftId: r.data.id });
  } catch (err) {
    console.error('gmail create draft error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/gmail/drafts/:id
 * Delete a draft
 */
router.delete('/drafts/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const auth = await getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });
    await gmail.users.drafts.delete({ userId: 'me', id });
    res.json({ success: true });
  } catch (err) {
    console.error('gmail delete draft error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/gmail/drafts/:id/send
 * Send an existing draft
 */
router.post('/drafts/:id/send', async (req, res) => {
  const { id } = req.params;
  try {
    const auth = await getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });
    const r = await gmail.users.drafts.send({ userId: 'me', requestBody: { id } });

    await logActivity({
      userId: req.user?.id,
      action: 'gmail_draft_sent',
      entityType: 'email',
      entityId: r.data.id,
      ipAddress: req.ip,
    });

    triggerOutbound('email_sent', { messageId: r.data.id }).catch(() => {});
    res.json({ success: true, messageId: r.data.id });
  } catch (err) {
    console.error('gmail send draft error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/gmail/thread/:id
 * Get all messages in a thread
 */
router.get('/thread/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const auth = await getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });
    const r = await gmail.users.threads.get({ userId: 'me', id, format: 'full' });

    const messages = (r.data.messages || []).map((msg) => {
      const headers = {};
      (msg.payload?.headers || []).forEach((h) => { headers[h.name] = h.value; });
      return {
        id: msg.id,
        from: headers['From'] || '',
        to: headers['To'] || '',
        subject: headers['Subject'] || '(no subject)',
        date: headers['Date'] || '',
        body: extractBody(msg.payload),
        snippet: msg.snippet,
        labelIds: msg.labelIds || [],
      };
    });

    res.json({ threadId: id, messages });
  } catch (err) {
    console.error('gmail thread error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/gmail/message/:id/attachments
 * List attachments for a message
 */
router.get('/message/:id/attachments', async (req, res) => {
  const { id } = req.params;
  try {
    const auth = await getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });
    const r = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });

    const attachments = [];
    function walk(parts) {
      for (const part of parts || []) {
        if (part.filename && part.body?.attachmentId) {
          attachments.push({
            attachmentId: part.body.attachmentId,
            filename: part.filename,
            mimeType: part.mimeType,
            size: part.body.size || 0,
          });
        }
        if (part.parts) walk(part.parts);
      }
    }
    walk(r.data.payload?.parts);

    res.json({ attachments });
  } catch (err) {
    console.error('gmail attachments list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/gmail/message/:id/attachments/:attachmentId
 * Download an attachment (returns base64 data)
 */
router.get('/message/:id/attachments/:attachmentId', async (req, res) => {
  const { id, attachmentId } = req.params;
  try {
    const auth = await getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });
    const r = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId: id,
      id: attachmentId,
    });

    const data = r.data.data.replace(/-/g, '+').replace(/_/g, '/');
    res.json({ data, size: r.data.size });
  } catch (err) {
    console.error('gmail attachment download error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/gmail/message/:id/trash
 * Move a message to trash
 */
router.post('/message/:id/trash', async (req, res) => {
  const { id } = req.params;
  try {
    const auth = await getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });
    await gmail.users.messages.trash({ userId: 'me', id });
    res.json({ success: true });
  } catch (err) {
    console.error('gmail trash error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/gmail/message/:id/untrash
 * Remove a message from trash
 */
router.post('/message/:id/untrash', async (req, res) => {
  const { id } = req.params;
  try {
    const auth = await getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });
    await gmail.users.messages.untrash({ userId: 'me', id });
    res.json({ success: true });
  } catch (err) {
    console.error('gmail untrash error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/gmail/message/:id/archive
 * Archive a message (remove INBOX label)
 */
router.post('/message/:id/archive', async (req, res) => {
  const { id } = req.params;
  try {
    const auth = await getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });
    await gmail.users.messages.modify({
      userId: 'me',
      id,
      requestBody: { removeLabelIds: ['INBOX'] },
    });
    res.json({ success: true });
  } catch (err) {
    console.error('gmail archive error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/gmail/message/:id/star
 * Star / unstar a message
 * Body: { starred: boolean }
 */
router.post('/message/:id/star', async (req, res) => {
  const { id } = req.params;
  const { starred } = req.body;
  try {
    const auth = await getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });
    await gmail.users.messages.modify({
      userId: 'me',
      id,
      requestBody: starred
        ? { addLabelIds: ['STARRED'] }
        : { removeLabelIds: ['STARRED'] },
    });
    res.json({ success: true });
  } catch (err) {
    console.error('gmail star error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/gmail/reply
 * Reply to an email (sends in the same thread)
 * Body: { to, subject, body, threadId, inReplyTo?, references? }
 */
router.post('/reply', async (req, res) => {
  const { to, subject, body, threadId, inReplyTo, references } = req.body;
  if (!to || !subject || !body || !threadId) {
    return res.status(400).json({ error: 'to, subject, body, and threadId are required' });
  }

  try {
    const auth = await getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const from = profile.data.emailAddress;

    let brand = null;
    try {
      const { data: brandRow } = await supabase
        .from('brand_settings')
        .select('*')
        .limit(1)
        .maybeSingle();
      if (brandRow) brand = brandRow;
    } catch (_) {}

    const headerLines = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
    ];
    if (inReplyTo) headerLines.push(`In-Reply-To: ${inReplyTo}`);
    if (references) headerLines.push(`References: ${references}`);
    headerLines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body);

    const raw = Buffer.from(headerLines.join('\r\n'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    const sendRes = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw, threadId },
    });

    await logActivity({
      userId: req.user?.id,
      action: 'gmail_reply_sent',
      entityType: 'email',
      entityId: sendRes.data.id,
      details: { to, subject: subject.slice(0, 100) },
      ipAddress: req.ip,
    });

    triggerOutbound('email_sent', { to, subject: subject.slice(0, 100), messageId: sendRes.data.id }).catch(() => {});
    res.json({ success: true, messageId: sendRes.data.id });
  } catch (err) {
    console.error('gmail reply error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/gmail/contacts
 * Fetch Google contacts (People API)
 * Query: { pageSize=100, pageToken }
 */
router.get('/contacts', async (req, res) => {
  const { pageSize = 100, pageToken } = req.query;
  try {
    const auth = await getAuthenticatedClient();
    const people = google.people({ version: 'v1', auth });
    const r = await people.people.connections.list({
      resourceName: 'people/me',
      pageSize: Math.min(Number(pageSize), 200),
      pageToken: pageToken || undefined,
      personFields: 'names,emailAddresses,phoneNumbers,organizations,photos',
    });

    const contacts = (r.data.connections || []).map((c) => ({
      resourceName: c.resourceName,
      name: c.names?.[0]?.displayName || '',
      email: c.emailAddresses?.[0]?.value || '',
      phone: c.phoneNumbers?.[0]?.value || '',
      company: c.organizations?.[0]?.name || '',
      photo: c.photos?.[0]?.url || '',
    }));

    res.json({
      contacts,
      nextPageToken: r.data.nextPageToken || null,
      totalPeople: r.data.totalPeople || contacts.length,
    });
  } catch (err) {
    console.error('gmail contacts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/gmail/contacts/sync
 * Import Google contacts into the clients table
 */
router.post('/contacts/sync', async (req, res) => {
  try {
    const auth = await getAuthenticatedClient();
    const people = google.people({ version: 'v1', auth });

    let allContacts = [];
    let nextPageToken = null;
    do {
      const r = await people.people.connections.list({
        resourceName: 'people/me',
        pageSize: 200,
        pageToken: nextPageToken || undefined,
        personFields: 'names,emailAddresses,phoneNumbers,organizations',
      });
      allContacts = allContacts.concat(r.data.connections || []);
      nextPageToken = r.data.nextPageToken;
    } while (nextPageToken);

    let imported = 0;
    let skipped = 0;
    for (const c of allContacts) {
      const name = c.names?.[0]?.displayName;
      const email = c.emailAddresses?.[0]?.value;
      const phone = c.phoneNumbers?.[0]?.value;
      const company = c.organizations?.[0]?.name || null;

      if (!name || (!email && !phone)) { skipped++; continue; }

      const { error } = await supabase
        .from('clients')
        .upsert({
          name,
          email: email || null,
          phone: phone || null,
          company,
          source: 'google_contacts',
          is_active: true,
        }, { onConflict: 'email', ignoreDuplicates: true });

      if (error) { skipped++; } else { imported++; }
    }

    await logActivity({
      userId: req.user?.id,
      action: 'contacts_synced',
      details: { imported, skipped, total: allContacts.length },
      ipAddress: req.ip,
    });

    res.json({ success: true, imported, skipped, total: allContacts.length });
  } catch (err) {
    console.error('gmail contacts sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/gmail/profile
 * Get the authenticated Gmail user's profile
 */
router.get('/profile', async (req, res) => {
  try {
    const auth = await getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });
    const r = await gmail.users.getProfile({ userId: 'me' });
    res.json({
      emailAddress: r.data.emailAddress,
      messagesTotal: r.data.messagesTotal,
      threadsTotal: r.data.threadsTotal,
    });
  } catch (err) {
    console.error('gmail profile error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
