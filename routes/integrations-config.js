const express = require('express');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');

const router = express.Router();

const VAULT_PATH = path.join(__dirname, '..', 'config', 'vault.json');

// Strict rate limiter for vault write endpoint — prevent PIN brute-force
const vaultWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many vault save attempts. Please try again in 15 minutes.' },
});

// Groups of configurable env vars exposed through the vault UI
const CONFIG_GROUPS = [
  {
    key: 'ringcentral',
    title: 'RingCentral',
    vars: [
      { name: 'RINGCENTRAL_CLIENT_ID', label: 'Client ID (App)', type: 'text' },
      { name: 'RINGCENTRAL_CLIENT_SECRET', label: 'Client Secret', type: 'password' },
      { name: 'RINGCENTRAL_JWT_TOKEN', label: 'JWT Token (Service Auth)', type: 'password' },
      { name: 'RINGCENTRAL_MAIN_NUMBER', label: 'Main Company Number', type: 'tel' },
      { name: 'RINGCENTRAL_SANDBOX', label: 'Sandbox Mode (true/false)', type: 'text' },
    ],
  },
  {
    key: 'google',
    title: 'Google / Gmail',
    vars: [
      { name: 'GOOGLE_CLIENT_ID', label: 'OAuth Client ID', type: 'text' },
      { name: 'GOOGLE_CLIENT_SECRET', label: 'OAuth Client Secret', type: 'password' },
      { name: 'GOOGLE_WORKSPACE_DOMAIN', label: 'Workspace Domain (e.g. company.com)', type: 'text' },
      { name: 'GOOGLE_WORKSPACE_ADMIN_EMAIL', label: 'Admin Email', type: 'email' },
    ],
  },
  {
    key: 'ai',
    title: 'AI Assistant',
    vars: [
      { name: 'AI_PROVIDER', label: 'Provider (gemini or claude)', type: 'text' },
      { name: 'GEMINI_API_KEY', label: 'Gemini API Key', type: 'password' },
      { name: 'ANTHROPIC_API_KEY', label: 'Anthropic API Key', type: 'password' },
    ],
  },
  {
    key: 'zapier',
    title: 'Zapier',
    vars: [
      { name: 'ZAPIER_WEBHOOK_URL', label: 'Outbound Webhook URL', type: 'url' },
    ],
  },
  {
    key: 'clicksend',
    title: 'ClickSend',
    vars: [
      { name: 'CLICKSEND_USERNAME', label: 'API Username', type: 'text' },
      { name: 'CLICKSEND_API_KEY', label: 'API Key', type: 'password' },
      { name: 'CLICKSEND_SENDER_ID', label: 'Sender ID / Number', type: 'text' },
    ],
  },
  {
    key: 'supabase',
    title: 'Supabase',
    vars: [
      { name: 'SUPABASE_URL', label: 'Project URL', type: 'url' },
      { name: 'SUPABASE_ANON_KEY', label: 'Anon Key', type: 'password' },
      { name: 'SUPABASE_SERVICE_ROLE_KEY', label: 'Service Role Key', type: 'password' },
    ],
  },
];

// Allowed var names (whitelist)
const ALLOWED_VARS = new Set(CONFIG_GROUPS.flatMap(g => g.vars.map(v => v.name)));

function readVault() {
  try {
    if (fs.existsSync(VAULT_PATH)) {
      return JSON.parse(fs.readFileSync(VAULT_PATH, 'utf8'));
    }
  } catch { /* ignore parse errors */ }
  return {};
}

function writeVault(data) {
  const dir = path.dirname(VAULT_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(VAULT_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function maskValue(val) {
  if (!val) return '';
  // Always use a fixed number of bullet dots regardless of actual length
  // to avoid revealing secret length. Show only last 4 characters.
  if (val.length <= 4) return '••••••••';
  return '••••••••' + val.slice(-4);
}

function checkAdminPin(req, res) {
  const crypto = require('crypto');
  const pin = process.env.ADMIN_PIN;
  if (!pin) {
    res.status(503).json({
      error: 'ADMIN_PIN is not configured. Set ADMIN_PIN in your .env file to enable the vault.',
    });
    return false;
  }
  const provided = (req.headers['x-admin-pin'] || req.body?.adminPin || '').toString().trim();
  if (!provided) {
    res.status(401).json({ error: 'Invalid admin PIN.' });
    return false;
  }
  const pinBuf = Buffer.from(pin);
  const providedBuf = Buffer.from(provided);
  if (pinBuf.length !== providedBuf.length || !crypto.timingSafeEqual(pinBuf, providedBuf)) {
    res.status(401).json({ error: 'Invalid admin PIN.' });
    return false;
  }
  return true;
}

/**
 * GET /api/integrations-config
 * Returns all config groups with masked values and source (vault | env | none).
 * No auth required — values are masked, no secrets exposed.
 */
router.get('/', (req, res) => {
  const vault = readVault();
  const groups = CONFIG_GROUPS.map(group => ({
    key: group.key,
    title: group.title,
    icon: group.icon,
    vars: group.vars.map(v => {
      const vaultVal = vault[v.name] || '';
      const envVal = process.env[v.name] || '';
      const effectiveVal = vaultVal || envVal;
      return {
        name: v.name,
        label: v.label,
        type: v.type,
        hasValue: Boolean(effectiveVal),
        maskedValue: maskValue(effectiveVal),
        source: vaultVal ? 'vault' : (envVal ? 'env' : 'none'),
      };
    }),
  }));

  res.json({
    groups,
    adminPinSet: Boolean(process.env.ADMIN_PIN),
  });
});

/**
 * POST /api/integrations-config
 * Saves one or more config values to the vault. Admin PIN required.
 * Body: { adminPin, updates: { VAR_NAME: "value", ... } }
 * Set a var to null or "" to clear it from the vault (env fallback remains).
 *
 * Rate-limited to 10 attempts per 15 minutes to prevent PIN brute-force.
 */
router.post('/', vaultWriteLimiter, (req, res) => {
  if (!checkAdminPin(req, res)) return;

  const { updates } = req.body;
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return res.status(400).json({ error: '"updates" object is required.' });
  }

  const vault = readVault();
  const changed = [];

  for (const [key, value] of Object.entries(updates)) {
    if (!ALLOWED_VARS.has(key)) continue; // silently skip unknown vars
    if (value === null || value === undefined || value === '') {
      delete vault[key]; // clear from vault (env fallback takes over)
    } else {
      vault[key] = String(value).trim();
      // Hot-reload into the running process (session-only; persisted via vault file above)
      process.env[key] = String(value).trim();
    }
    changed.push(key);
  }

  writeVault(vault);
  res.json({ ok: true, changed, message: `${changed.length} setting(s) saved.` });
});

module.exports = router;
