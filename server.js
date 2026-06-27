// ── Boot-time vault injection ────────────────────────────────────────────────
// Load keys saved via the in-app Integrations vault BEFORE dotenv and before
// any route file is required. This lets the server start without a .env file.
const fs = require('fs');
const path = require('path');
const VAULT_PATH = path.join(__dirname, 'config', 'vault.json');
try {
  if (fs.existsSync(VAULT_PATH)) {
    const vault = JSON.parse(fs.readFileSync(VAULT_PATH, 'utf8'));
    for (const [k, v] of Object.entries(vault)) {
      // Vault wins over env so saved UI keys always take effect
      if (v !== null && v !== undefined && v !== '') process.env[k] = String(v);
    }
    console.log('✅ Vault loaded from config/vault.json');
  }
} catch (e) {
  console.warn('⚠️  Could not load vault:', e.message);
}
// ────────────────────────────────────────────────────────────────────────────

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
// path already required above

const smsRoutes = require('./routes/sms');
const usersRoutes = require('./routes/users');
const clientsRoutes = require('./routes/clients');
const gmailRoutes = require('./routes/gmail');
const slackRoutes = require('./routes/slack');
const aiRoutes = require('./routes/ai');
const webhooksRoutes = require('./routes/webhooks');
const authRoutes = require('./routes/auth');
const internalChatRoutes = require('./routes/internal-chat');
const meetingsRoutes = require('./routes/meetings');
const integrationsConfigRoutes = require('./routes/integrations-config');
const templatesRoutes = require('./routes/templates');
const brandRoutes = require('./routes/brand');
const activityRoutes = require('./routes/activity');
const tenantsRoutes = require('./routes/tenants');
const phoneNumbersRoutes = require('./routes/phone-numbers');
const ringcentralRoutes = require('./routes/ringcentral');
const { authMiddleware } = require('./lib/auth');
const { resolveTenant } = require('./lib/tenants');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({
  verify: (req, _res, buf) => {
    // Preserve raw body for Slack HMAC signature verification
    if (req.url && req.url.startsWith('/api/slack/events')) {
      req.rawBody = buf.toString('utf8');
    }
  },
}));
app.use(express.urlencoded({ extended: true }));

// Rate limiting for API routes
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// Stricter limit for SMS sending endpoints to prevent abuse
const smsLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'SMS rate limit exceeded, please slow down.' },
});

app.use('/api/', apiLimiter);
app.use('/api/sms/send-external', smsLimiter);
app.use('/api/sms/send-internal', smsLimiter);
app.use('/api/sms/broadcast', smsLimiter);
app.use('/api/clients/:id/sms', smsLimiter);

// Optional Google Workspace auth middleware (non-blocking unless GOOGLE_AUTH_REQUIRED=true)
app.use('/api/', authMiddleware);

// Multi-tenant resolution (sets req.tenant from header, query param, or email)
app.use('/api/', resolveTenant);

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Noah Connect Virtual Office',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
});

// Guard routes that require a working Supabase connection.
// If keys aren't configured yet the frontend will show a helpful message
// instead of a cryptic 500 / unhandled-promise crash.
const DB_ROUTES = ['/api/sms', '/api/users', '/api/clients', '/api/internal-chat', '/api/templates', '/api/brand', '/api/activity'];
app.use(DB_ROUTES, (req, res, next) => {
  // Import lazily so vault-injected env is picked up; use getSupabaseClient() for live check
  const { getSupabaseClient } = require('./lib/supabase');
  if (!getSupabaseClient()) {
    return res.status(503).json({
      error: 'Database not configured. Open the Integrations tab and add your Supabase URL and Service Role Key.',
    });
  }
  next();
});

// API routes
app.use('/api/sms', smsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/clients', clientsRoutes);
app.use('/api/gmail', gmailRoutes);
app.use('/api/slack', slackRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/webhooks', webhooksRoutes);
app.use('/api/internal-chat', internalChatRoutes);
app.use('/api/meetings', meetingsRoutes);
app.use('/api/integrations-config', integrationsConfigRoutes);
app.use('/api/templates', templatesRoutes);
app.use('/api/brand', brandRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/tenants', tenantsRoutes);
app.use('/api/phone-numbers', phoneNumbersRoutes);
app.use('/api/ringcentral', ringcentralRoutes);

// Auth routes (OAuth callbacks live outside /api/)
app.use('/auth', authRoutes);

// Catch-all: serve frontend for any non-API route (SPA support)
app.get('*', apiLimiter, (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'API endpoint not found' });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  const message = process.env.NODE_ENV === 'development' ? err.message : 'Internal server error';
  res.status(500).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`\nNoah Connect Virtual Office running on port ${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log(`   Health:    http://localhost:${PORT}/health`);
  console.log(`   API:       http://localhost:${PORT}/api\n`);
});

module.exports = app;
