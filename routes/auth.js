const express = require('express');
const rateLimit = require('express-rate-limit');
const { getOAuth2Client, SCOPES, setTokens, getTokens } = require('../lib/gmail');
const { verifyGoogleToken } = require('../lib/auth');

const router = express.Router();

// Auth endpoints are sensitive — apply a tight rate limit
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication requests, please try again later.' },
});

/**
 * GET /auth/google
 * Redirect the browser to Google's OAuth2 consent screen.
 * Scopes: Gmail + openid/profile/email
 */
router.get('/google', authLimiter, (req, res) => {
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
router.get('/google/callback', authLimiter, async (req, res) => {
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
router.post('/verify-token', authLimiter, async (req, res) => {
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
 * Returns current connection status for the frontend
 */
router.get('/status', (req, res) => {
  res.json({
    gmailConnected: getTokens() !== null,
  });
});

module.exports = router;
