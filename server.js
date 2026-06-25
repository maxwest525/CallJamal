require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

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
const { authMiddleware } = require('./lib/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
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

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'CallJamal Virtual Office',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
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
  console.log(`\n🚀 CallJamal Virtual Office running on port ${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log(`   Health:    http://localhost:${PORT}/health`);
  console.log(`   API:       http://localhost:${PORT}/api\n`);
});

module.exports = app;
