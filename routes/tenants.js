const express = require('express');
const { getSupabaseClient, logActivity } = require('../lib/supabase');
const { CATCHALL_DOMAIN } = require('../lib/tenants');

const router = express.Router();

/**
 * GET /api/tenants
 * List all tenants
 */
router.get('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });

    const { data, error } = await supabase
      .from('tenants')
      .select('*')
      .order('display_name');

    if (error) throw new Error(error.message);
    res.json({ tenants: data });
  } catch (err) {
    console.error('list tenants error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/tenants/current
 * Get the current tenant based on request context
 */
router.get('/current', async (req, res) => {
  const { slug } = req.tenant || {};
  if (!slug || slug === 'default') {
    return res.json({ tenant: { slug: 'default', display_name: 'Default', domain: CATCHALL_DOMAIN } });
  }

  try {
    const supabase = getSupabaseClient();
    if (!supabase) return res.json({ tenant: req.tenant });

    const { data, error } = await supabase
      .from('tenants')
      .select('*')
      .eq('slug', slug)
      .maybeSingle();

    if (error) throw new Error(error.message);
    res.json({ tenant: data || req.tenant });
  } catch (err) {
    console.error('get current tenant error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/tenants
 * Create a new tenant
 * Body: { slug, displayName, aiProvider, aiSystemPrompt, aiTemperature, aiMaxTokens }
 */
router.post('/', async (req, res) => {
  const { slug, displayName, aiProvider, aiSystemPrompt, aiTemperature, aiMaxTokens } = req.body;

  if (!slug) return res.status(400).json({ error: 'slug is required' });

  const sanitizedSlug = slug.toLowerCase().replace(/[^a-z0-9._-]/g, '');
  if (!sanitizedSlug) return res.status(400).json({ error: 'Invalid slug' });

  try {
    const supabase = getSupabaseClient();
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });

    const { data, error } = await supabase
      .from('tenants')
      .insert({
        slug: sanitizedSlug,
        display_name: displayName || sanitizedSlug,
        email: CATCHALL_DOMAIN ? `${sanitizedSlug}@${CATCHALL_DOMAIN}` : null,
        domain: CATCHALL_DOMAIN || null,
        ai_provider: aiProvider || 'gemini',
        ai_system_prompt: aiSystemPrompt || null,
        ai_temperature: aiTemperature || 0.7,
        ai_max_tokens: aiMaxTokens || 2048,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    await logActivity({
      action: 'tenant_created',
      entityType: 'tenant',
      entityId: data.id,
      details: { slug: sanitizedSlug },
      ipAddress: req.ip,
    });

    res.status(201).json({ tenant: data });
  } catch (err) {
    console.error('create tenant error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/tenants/:slug
 * Update a tenant's configuration (mainly AI agent settings)
 */
router.patch('/:slug', async (req, res) => {
  const { slug } = req.params;
  const { displayName, aiProvider, aiSystemPrompt, aiTemperature, aiMaxTokens, isActive, settings } = req.body;

  try {
    const supabase = getSupabaseClient();
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });

    const updates = {};
    if (displayName !== undefined) updates.display_name = displayName;
    if (aiProvider !== undefined) updates.ai_provider = aiProvider;
    if (aiSystemPrompt !== undefined) updates.ai_system_prompt = aiSystemPrompt;
    if (aiTemperature !== undefined) updates.ai_temperature = aiTemperature;
    if (aiMaxTokens !== undefined) updates.ai_max_tokens = aiMaxTokens;
    if (isActive !== undefined) updates.is_active = isActive;
    if (settings !== undefined) updates.settings = settings;

    const { data, error } = await supabase
      .from('tenants')
      .update(updates)
      .eq('slug', slug)
      .select()
      .single();

    if (error) throw new Error(error.message);

    await logActivity({
      action: 'tenant_updated',
      entityType: 'tenant',
      entityId: data.id,
      details: updates,
      ipAddress: req.ip,
    });

    res.json({ tenant: data });
  } catch (err) {
    console.error('update tenant error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/tenants/:slug
 * Soft-delete a tenant (deactivate)
 */
router.delete('/:slug', async (req, res) => {
  const { slug } = req.params;

  try {
    const supabase = getSupabaseClient();
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });

    const { error } = await supabase
      .from('tenants')
      .update({ is_active: false })
      .eq('slug', slug);

    if (error) throw new Error(error.message);

    await logActivity({
      action: 'tenant_deactivated',
      entityType: 'tenant',
      details: { slug },
      ipAddress: req.ip,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('delete tenant error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
