const { google } = require('googleapis');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
];

function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or GOOGLE_REDIRECT_URI');
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// In-memory token store (single-user; replace with DB for multi-user)
let _tokens = null;

function setTokens(tokens) {
  _tokens = tokens;
}

function getTokens() {
  return _tokens;
}

function getAuthenticatedClient() {
  if (!_tokens) {
    throw new Error('Gmail not connected. Visit /api/gmail/auth-url to authorize.');
  }
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials(_tokens);
  // Auto-refresh tokens
  oauth2Client.on('tokens', (refreshed) => {
    _tokens = { ..._tokens, ...refreshed };
  });
  return oauth2Client;
}

/**
 * Decode a base64url-encoded Gmail message body
 */
function decodeBody(data) {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

/**
 * Extract plain-text or HTML body from a Gmail message payload
 */
function extractBody(payload) {
  if (!payload) return '';
  if (payload.body?.data) return decodeBody(payload.body.data);
  if (payload.parts) {
    // Prefer text/plain
    const plain = payload.parts.find((p) => p.mimeType === 'text/plain');
    if (plain?.body?.data) return decodeBody(plain.body.data);
    const html = payload.parts.find((p) => p.mimeType === 'text/html');
    if (html?.body?.data) return decodeBody(html.body.data);
    // Recurse into multipart
    for (const part of payload.parts) {
      const body = extractBody(part);
      if (body) return body;
    }
  }
  return '';
}

/**
 * Build a raw RFC-2822 email message in base64url format for the Gmail API
 */
function buildRawEmail({ to, subject, body, from }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ];
  return Buffer.from(lines.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

module.exports = { getOAuth2Client, getAuthenticatedClient, setTokens, getTokens, SCOPES, extractBody, buildRawEmail };
