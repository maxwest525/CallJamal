const express = require('express');
const { getOAuth2Client, SCOPES, setTokens, getTokens } = require('../lib/gmail');
const { verifyGoogleToken } = require('../lib/auth');

const router = express.Router();

/**
 * GET /auth/google
 * Redirect the browser to Google's OAuth2 consent screen.
 * Scopes: Gmail + openid/profile/email
 */
router.get('/google', (req, res) => {
  try {
    const oauth2Client = getOAuth2Client();
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: [
        'openid',
        'profile',
        'email',
        ...SCOPES,
      ],
      prompt: 'consent',
    });
    res.redirect(url);
  } catch (err) {
    res.status(500).send(`OAuth configuration error: ${err.message}`);
  }
});

/**
 * GET /auth/google/callback
 * OAuth2 callback — exchanges the code for tokens, stores them, then redirects to app.
 */
router.get('/google/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.redirect(`/?auth_error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return res.status(400).send('Missing authorization code');
  }

  try {
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    setTokens(tokens);

    // Redirect back to the app with a success flag
    res.redirect('/?gmail_connected=1');
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.redirect(`/?auth_error=${encodeURIComponent(err.message)}`);
  }
});

/**
 * POST /auth/verify-token
 * Verify a Google ID token from the frontend (for SSO login flow).
 * Body: { idToken }
 * Returns: { user: { id, email, name, picture } }
 */
router.post('/verify-token', async (req, res) => {
  const { idToken } = req.body;

  if (!idToken) {
    return res.status(400).json({ error: 'idToken is required' });
  }

  try {
    const payload = await verifyGoogleToken(idToken);
    res.json({
      user: {
        id: payload.sub,
        email: payload.email,
        name: payload.name,
        picture: payload.picture,
        domain: payload.hd,
      },
    });
  } catch (err) {
    console.error('Token verification error:', err.message);
    res.status(401).json({ error: err.message });
  }
});

/**
 * GET /auth/status
 * Returns current auth/connection status for the frontend
 */
router.get('/status', (req, res) => {
  res.json({
    gmailConnected: getTokens() !== null,
    authRequired: process.env.GOOGLE_AUTH_REQUIRED === 'true',
    workspaceDomain: process.env.GOOGLE_WORKSPACE_DOMAIN || null,
  });
});

module.exports = router;
