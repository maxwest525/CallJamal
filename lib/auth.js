const { google } = require('googleapis');

/**
 * Verify a Google ID token and return its payload.
 * Optionally enforces hd (hosted domain) restriction from GOOGLE_WORKSPACE_DOMAIN.
 */
async function verifyGoogleToken(idToken) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID not configured');

  const client = new google.auth.OAuth2(clientId);
  const ticket = await client.verifyIdToken({ idToken, audience: clientId });
  const payload = ticket.getPayload();

  const domain = process.env.GOOGLE_WORKSPACE_DOMAIN;
  if (domain && payload.hd !== domain) {
    throw new Error(`Account must belong to ${domain}`);
  }

  return payload;
}

/**
 * Express middleware — reads ****** from Authorization header,
 * verifies it, and attaches the Google user payload to req.user.
 *
 * Behaviour:
 *  - If GOOGLE_AUTH_REQUIRED=true: blocks unauthenticated requests with 401.
 *  - Otherwise: sets req.user if a valid token is present, passes through if absent.
 *    This allows the existing app to work without a login flow until auth is wired up.
 */
function authMiddleware(req, res, next) {
  const required = process.env.GOOGLE_AUTH_REQUIRED === 'true';
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    if (required) {
      return res.status(401).json({ error: 'Authentication required. Provide a Bearer token (Google ID token) in the Authorization header.' });
    }
    return next();
  }

  const token = authHeader.slice(7);
  verifyGoogleToken(token)
    .then((payload) => {
      req.user = {
        id: payload.sub,
        email: payload.email,
        name: payload.name,
        picture: payload.picture,
        domain: payload.hd,
      };
      next();
    })
    .catch((err) => {
      if (required) {
        return res.status(401).json({ error: `Invalid token: ${err.message}` });
      }
      // Token present but invalid — pass through in non-required mode
      next();
    });
}

module.exports = { authMiddleware, verifyGoogleToken };
