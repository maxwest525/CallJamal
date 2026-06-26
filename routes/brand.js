const express = require('express');
const { supabase, logActivity } = require('../lib/supabase');

const router = express.Router();

/** Validate a hex or named CSS color. Only allows #hex format to prevent CSS injection. */
function isValidColor(value) {
  return /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(value);
}

/** Validate that a string is an http or https URL. */
function isValidHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

/**
 * GET /api/brand
 * Retrieve the current brand settings (returns empty object if not yet configured).
 */
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('brand_settings')
      .select('*')
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(error.message);

    res.json({ brand: data || null });
  } catch (err) {
    console.error('brand get error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/brand
 * Create or update the brand settings (upserts the single brand row).
 * Body: { company_name?, logo_url?, primary_color?, secondary_color?, tagline?, footer_text? }
 */
router.put('/', async (req, res) => {
  const { company_name, logo_url, primary_color, secondary_color, tagline, footer_text } = req.body;

  const allowed = ['company_name', 'logo_url', 'primary_color', 'secondary_color', 'tagline', 'footer_text'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No brand fields provided' });
  }

  // Validate logo_url
  if (updates.logo_url && !isValidHttpUrl(updates.logo_url)) {
    return res.status(400).json({ error: 'logo_url must be a valid http or https URL' });
  }

  // Validate color fields (must be #hex format to prevent CSS injection)
  for (const colorField of ['primary_color', 'secondary_color']) {
    if (updates[colorField] !== undefined && !isValidColor(updates[colorField])) {
      return res.status(400).json({ error: `${colorField} must be a valid hex color (e.g. #4F46E5)` });
    }
  }

  try {
    // Fetch the existing row id (if any) so we can upsert properly
    const { data: existing } = await supabase
      .from('brand_settings')
      .select('id')
      .limit(1)
      .maybeSingle();

    let data, error;

    if (existing) {
      ({ data, error } = await supabase
        .from('brand_settings')
        .update(updates)
        .eq('id', existing.id)
        .select()
        .single());
    } else {
      ({ data, error } = await supabase
        .from('brand_settings')
        .insert(updates)
        .select()
        .single());
    }

    if (error) throw new Error(error.message);

    await logActivity({
      userId: req.user?.id || null,
      action: existing ? 'brand_updated' : 'brand_created',
      entityType: 'brand_settings',
      entityId: data.id,
      details: { fields: Object.keys(updates) },
      ipAddress: req.ip,
    });

    res.json({ brand: data });
  } catch (err) {
    console.error('brand update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
