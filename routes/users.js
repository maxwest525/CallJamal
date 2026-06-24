const express = require('express');
const { google } = require('googleapis');
const { supabase, logActivity } = require('../lib/supabase');

const router = express.Router();

/**
 * GET /api/users
 * Get all active users with optional team member info
 */
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select(`
        *,
        team_member:team_members(id, employee_number, extension, role, can_send_sms, can_receive_sms)
      `)
      .eq('is_active', true)
      .order('name');

    if (error) throw new Error(error.message);
    res.json({ users: data });
  } catch (err) {
    console.error('get users error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/users/team
 * Get all team members (up to 5 employees)
 */
router.get('/team', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('team_members')
      .select(`
        *,
        user:user_id(id, name, email, phone, avatar_url, status, status_message, last_seen_at, job_title, department)
      `)
      .order('employee_number');

    if (error) throw new Error(error.message);
    res.json({ team: data });
  } catch (err) {
    console.error('get team error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/users/:id/status
 * Update a user's online status
 * Body: { status, statusMessage }
 */
router.patch('/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, statusMessage } = req.body;

  const validStatuses = ['online', 'away', 'busy', 'offline'];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
  }

  try {
    const updates = { last_seen_at: new Date().toISOString() };
    if (status) updates.status = status;
    if (statusMessage !== undefined) updates.status_message = statusMessage;

    const { data, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw new Error(error.message);

    await logActivity({
      userId: id,
      action: 'status_updated',
      entityType: 'user',
      entityId: id,
      details: { status, statusMessage },
      ipAddress: req.ip,
    });

    res.json({ user: data });
  } catch (err) {
    console.error('update status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/users/sync
 * Sync users from Google Workspace directory
 */
router.post('/sync', async (req, res) => {
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  const domain = process.env.GOOGLE_WORKSPACE_DOMAIN;
  const adminEmail = process.env.GOOGLE_WORKSPACE_ADMIN_EMAIL || `admin@${domain}`;

  if (!keyFile || !domain) {
    return res.status(500).json({ error: 'Google Workspace not configured. Set GOOGLE_SERVICE_ACCOUNT_KEY_FILE and GOOGLE_WORKSPACE_DOMAIN.' });
  }

  try {
    const auth = new google.auth.GoogleAuth({
      keyFile,
      scopes: ['https://www.googleapis.com/auth/admin.directory.user.readonly'],
      subject: adminEmail,
    });

    const admin = google.admin({ version: 'directory_v1', auth });
    const listResponse = await admin.users.list({
      domain,
      maxResults: 100,
      orderBy: 'givenName',
    });

    const googleUsers = listResponse.data.users || [];
    let synced = 0;
    let errors = 0;

    for (const gUser of googleUsers) {
      const userData = {
        google_id: gUser.id,
        email: gUser.primaryEmail,
        name: gUser.name?.fullName || gUser.primaryEmail,
        first_name: gUser.name?.givenName || null,
        last_name: gUser.name?.familyName || null,
        avatar_url: gUser.thumbnailPhotoUrl || null,
        is_active: !gUser.suspended,
      };

      const { error } = await supabase
        .from('users')
        .upsert(userData, { onConflict: 'google_id', ignoreDuplicates: false });

      if (error) {
        console.error(`Failed to sync user ${gUser.primaryEmail}:`, error.message);
        errors++;
      } else {
        synced++;
      }
    }

    await logActivity({
      action: 'google_workspace_sync',
      details: { total: googleUsers.length, synced, errors },
      ipAddress: req.ip,
    });

    res.json({ success: true, total: googleUsers.length, synced, errors });
  } catch (err) {
    console.error('Google Workspace sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/users
 * Manually create a user
 * Body: { email, name, firstName, lastName, phone, department, jobTitle }
 */
router.post('/', async (req, res) => {
  const { email, name, firstName, lastName, phone, department, jobTitle } = req.body;

  if (!email || !name) {
    return res.status(400).json({ error: 'email and name are required' });
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .insert({
        email,
        name,
        first_name: firstName || null,
        last_name: lastName || null,
        phone: phone || null,
        department: department || null,
        job_title: jobTitle || null,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    await logActivity({
      action: 'user_created',
      entityType: 'user',
      entityId: data.id,
      details: { email, name },
      ipAddress: req.ip,
    });

    res.status(201).json({ user: data });
  } catch (err) {
    console.error('create user error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
