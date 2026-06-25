const express = require('express');
const { supabase, logActivity } = require('../lib/supabase');

const router = express.Router();

/**
 * Interpolate {{variable}} placeholders in a string using the provided values map.
 * Unmatched placeholders are left as-is.
 *
 * Note: replacement values are inserted verbatim. Callers that render the result
 * in an HTML context (e.g. email bodies) must HTML-escape values before passing
 * them in to prevent XSS.
 *
 * @param {string} text   Template string containing {{var}} placeholders
 * @param {object} values Map of variable name → replacement value
 * @returns {string}      Interpolated string
 */
function interpolate(text, values) {
  if (!text) return text;
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
  );
}

/**
 * Auto-detect {{variable}} placeholders from a template body and optional subject.
 *
 * @param {string} body
 * @param {string} [subject]
 * @returns {string[]} Unique variable names
 */
function detectTemplateVariables(body, subject) {
  const fromBody = (body || '').match(/\{\{(\w+)\}\}/g) || [];
  const fromSubject = (subject || '').match(/\{\{(\w+)\}\}/g) || [];
  return [...new Set([...fromBody, ...fromSubject])].map((v) => v.slice(2, -2));
}

/**
 * GET /api/templates
 * List all message templates, optionally filtered by type
 * Query: { type? } — 'email' or 'sms'
 */
router.get('/', async (req, res) => {
  const { type } = req.query;

  try {
    let query = supabase
      .from('message_templates')
      .select('*')
      .order('name', { ascending: true });

    if (type) query = query.eq('type', type);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    res.json({ templates: data });
  } catch (err) {
    console.error('templates list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/templates/:id
 * Get a single template by ID
 */
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from('message_templates')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: 'Template not found' });

    res.json({ template: data });
  } catch (err) {
    console.error('templates get error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/templates
 * Create a new message template
 * Body: { name, type, subject?, body, variables? }
 */
router.post('/', async (req, res) => {
  const { name, type, subject, body, variables } = req.body;

  if (!name || !type || !body) {
    return res.status(400).json({ error: 'name, type, and body are required' });
  }

  if (!['email', 'sms'].includes(type)) {
    return res.status(400).json({ error: 'type must be "email" or "sms"' });
  }

  if (type === 'email' && !subject) {
    return res.status(400).json({ error: 'subject is required for email templates' });
  }

  try {
    // Auto-detect variables from {{...}} placeholders if not supplied
    const templateVars = variables || detectTemplateVariables(body, subject);

    const { data, error } = await supabase
      .from('message_templates')
      .insert({ name, type, subject: subject || null, body, variables: templateVars })
      .select()
      .single();

    if (error) throw new Error(error.message);

    await logActivity({
      userId: req.user?.id || null,
      action: 'template_created',
      entityType: 'message_template',
      entityId: data.id,
      details: { name, type },
      ipAddress: req.ip,
    });

    res.status(201).json({ template: data });
  } catch (err) {
    console.error('templates create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/templates/:id
 * Update an existing template
 * Body: { name?, type?, subject?, body?, variables? }
 */
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, type, subject, body, variables } = req.body;

  if (type && !['email', 'sms'].includes(type)) {
    return res.status(400).json({ error: 'type must be "email" or "sms"' });
  }

  try {
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (type !== undefined) updates.type = type;
    if (subject !== undefined) updates.subject = subject;
    if (body !== undefined) {
      updates.body = body;
      // Re-detect variables if body changes and variables not explicitly provided
      if (variables === undefined) {
        const detected = detectTemplateVariables(body, subject);
        if (detected.length > 0) updates.variables = detected;
      }
    }
    if (variables !== undefined) updates.variables = variables;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const { data, error } = await supabase
      .from('message_templates')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: 'Template not found' });

    await logActivity({
      userId: req.user?.id || null,
      action: 'template_updated',
      entityType: 'message_template',
      entityId: id,
      details: { fields: Object.keys(updates) },
      ipAddress: req.ip,
    });

    res.json({ template: data });
  } catch (err) {
    console.error('templates update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/templates/:id
 * Delete a template
 */
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const { error } = await supabase
      .from('message_templates')
      .delete()
      .eq('id', id);

    if (error) throw new Error(error.message);

    await logActivity({
      userId: req.user?.id || null,
      action: 'template_deleted',
      entityType: 'message_template',
      entityId: id,
      ipAddress: req.ip,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('templates delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/templates/:id/render
 * Render a template by interpolating {{variable}} placeholders with provided values.
 * Body: { variables: { key: value, ... } }
 * Returns: { subject?, body } — the rendered strings ready to send
 */
router.post('/:id/render', async (req, res) => {
  const { id } = req.params;
  const { variables: values = {} } = req.body;

  try {
    const { data, error } = await supabase
      .from('message_templates')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: 'Template not found' });

    const rendered = {
      body: interpolate(data.body, values),
    };

    if (data.subject) {
      rendered.subject = interpolate(data.subject, values);
    }

    res.json({ rendered, template: { id: data.id, name: data.name, type: data.type } });
  } catch (err) {
    console.error('templates render error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
