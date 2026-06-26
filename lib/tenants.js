/**
 * Multi-Tenant Resolution
 *
 * Uses a catchall email domain to isolate tenants.  The tenant slug is derived
 * from the local-part of the tenant's email on the catchall domain.
 *
 * Example: if CATCHALL_DOMAIN=trumoveinc.com
 *   clientA@trumoveinc.com  → tenant slug "clienta"
 *   clientB@trumoveinc.com  → tenant slug "clientb"
 *
 * Resolution order:
 *   1. X-Tenant header (explicit override)
 *   2. ?tenant= query parameter
 *   3. Authenticated user email prefix (from Google SSO)
 *   4. Falls back to "default" tenant (single-tenant mode)
 */

const CATCHALL_DOMAIN = (process.env.CATCHALL_DOMAIN || '').toLowerCase().trim();

/**
 * Extract tenant slug from an email on the catchall domain.
 * Returns null if the email doesn't belong to the catchall domain.
 */
function slugFromEmail(email) {
  if (!email || !CATCHALL_DOMAIN) return null;
  const lower = email.toLowerCase().trim();
  if (!lower.endsWith(`@${CATCHALL_DOMAIN}`)) return null;
  const local = lower.slice(0, lower.indexOf('@'));
  // Sanitize: only allow alphanumeric, hyphens, underscores, dots
  const slug = local.replace(/[^a-z0-9._-]/g, '');
  return slug || null;
}

/**
 * Express middleware that attaches `req.tenant` with { slug, email, domain }.
 * Non-blocking: if no tenant can be resolved, defaults to "default".
 */
function resolveTenant(req, res, next) {
  let slug = null;

  // 1. Explicit header
  const headerTenant = req.headers['x-tenant'];
  if (headerTenant) {
    slug = headerTenant.toLowerCase().replace(/[^a-z0-9._-]/g, '');
  }

  // 2. Query param
  if (!slug && req.query.tenant) {
    slug = String(req.query.tenant).toLowerCase().replace(/[^a-z0-9._-]/g, '');
  }

  // 3. Authenticated email (set by auth middleware)
  if (!slug && req.user?.email) {
    slug = slugFromEmail(req.user.email);
  }

  // 4. Default
  if (!slug) slug = 'default';

  req.tenant = {
    slug,
    email: CATCHALL_DOMAIN ? `${slug}@${CATCHALL_DOMAIN}` : null,
    domain: CATCHALL_DOMAIN || null,
  };

  next();
}

/**
 * Filter Gmail messages to only those addressed to the tenant's catchall email.
 * Useful for per-tenant inbox views.
 *
 * @param {Array} messages - Array of Gmail message objects
 * @param {string} tenantEmail - The tenant's email (e.g. clientA@trumoveinc.com)
 * @returns {Array} Filtered messages
 */
function filterMessagesForTenant(messages, tenantEmail) {
  if (!tenantEmail || !messages) return messages || [];
  const target = tenantEmail.toLowerCase();
  return messages.filter((msg) => {
    const headers = msg.payload?.headers || [];
    const toHeader = headers.find((h) => h.name.toLowerCase() === 'to');
    const ccHeader = headers.find((h) => h.name.toLowerCase() === 'cc');
    const combined = `${toHeader?.value || ''} ${ccHeader?.value || ''}`.toLowerCase();
    return combined.includes(target);
  });
}

module.exports = { resolveTenant, slugFromEmail, filterMessagesForTenant, CATCHALL_DOMAIN };
