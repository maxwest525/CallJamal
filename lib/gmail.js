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
    .replace(/=/g, '');  // strip padding (safe: base64url uses no padding)
}

/**
 * Escape a string for safe insertion into HTML content.
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build a branded HTML email and return it as a base64url-encoded raw RFC-2822 message.
 * Falls back to a plain-text message when no brand is supplied.
 *
 * @param {object} opts
 * @param {string} opts.to
 * @param {string} opts.subject
 * @param {string} opts.body       Plain-text or simple HTML body content
 * @param {string} opts.from
 * @param {object} [opts.brand]    Brand settings from the brand_settings table
 * @returns {string} base64url-encoded raw message
 */
function buildHtmlEmail({ to, subject, body, from, brand }) {
  if (!brand) return buildRawEmail({ to, subject, body, from });

  const {
    logo_url,
    primary_color = '#4F46E5',
    secondary_color = '#7C3AED',
  } = brand;

  // Escape brand text values to prevent XSS
  const companyName = escapeHtml(brand.company_name);
  const tagline = escapeHtml(brand.tagline);
  const footerText = escapeHtml(brand.footer_text);

  // Validate logo URL — only allow http/https to prevent javascript: and data: URIs
  let safeLogoUrl = null;
  if (logo_url) {
    try {
      const parsed = new URL(logo_url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        safeLogoUrl = logo_url;
      }
    } catch (_) { /* ignore invalid URL */ }
  }

  // Body is always treated as plain text and escaped to prevent XSS.
  // HTML bodies are not supported through this path; callers that need
  // to send pre-built HTML content should use buildRawEmail directly.
  const htmlBody = escapeHtml(body).replace(/\n/g, '<br>');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(subject)}</title>
<style>
  body { margin: 0; padding: 0; background-color: #f4f4f5; font-family: Arial, Helvetica, sans-serif; }
  .wrapper { max-width: 600px; margin: 32px auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
  .header { background: ${primary_color}; padding: 24px 32px; text-align: center; }
  .header img { max-height: 60px; margin-bottom: 8px; display: block; margin-left: auto; margin-right: auto; }
  .header h1 { margin: 0; color: #ffffff; font-size: 22px; font-weight: 700; letter-spacing: 0.5px; }
  .header p { margin: 4px 0 0; color: rgba(255,255,255,0.85); font-size: 13px; }
  .content { padding: 32px; color: #374151; font-size: 15px; line-height: 1.7; }
  .footer { background: #f9fafb; border-top: 1px solid #e5e7eb; padding: 16px 32px; text-align: center; font-size: 12px; color: #6b7280; }
  .accent { color: ${secondary_color}; }
</style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    ${safeLogoUrl ? `<img src="${safeLogoUrl}" alt="${companyName} logo">` : ''}
    ${companyName ? `<h1>${companyName}</h1>` : ''}
    ${tagline ? `<p>${tagline}</p>` : ''}
  </div>
  <div class="content">${htmlBody}</div>
  <div class="footer">
    ${footerText ? `<p>${footerText}</p>` : ''}
    <p>Sent via <span class="accent">CallJamal Virtual Office</span></p>
  </div>
</div>
</body>
</html>`;

  const boundary = `----=_Part_${Date.now()}`;
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    body,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    html,
    '',
    `--${boundary}--`,
  ];

  return Buffer.from(lines.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

module.exports = { getOAuth2Client, getAuthenticatedClient, setTokens, getTokens, SCOPES, extractBody, buildRawEmail, buildHtmlEmail, escapeHtml };
