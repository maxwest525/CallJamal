const axios = require('axios');

const RC_API_BASE = 'https://platform.ringcentral.com';
const RC_API_BASE_SANDBOX = 'https://platform.devtest.ringcentral.com';

function getConfig() {
  const clientId = process.env.RINGCENTRAL_CLIENT_ID;
  const clientSecret = process.env.RINGCENTRAL_CLIENT_SECRET;
  const jwtToken = process.env.RINGCENTRAL_JWT_TOKEN;
  const sandbox = process.env.RINGCENTRAL_SANDBOX === 'true';
  return { clientId, clientSecret, jwtToken, sandbox };
}

function isConfigured() {
  const { clientId, clientSecret, jwtToken } = getConfig();
  return Boolean(clientId && clientSecret && jwtToken);
}

function getBaseUrl() {
  return getConfig().sandbox ? RC_API_BASE_SANDBOX : RC_API_BASE;
}

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 30000) return cachedToken;

  const { clientId, clientSecret, jwtToken } = getConfig();
  if (!clientId || !clientSecret || !jwtToken) {
    throw new Error('RingCentral credentials not configured');
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const { data } = await axios.post(`${getBaseUrl()}/restapi/oauth/token`, new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwtToken,
  }).toString(), {
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in * 1000);
  return cachedToken;
}

async function rcApi(method, endpoint, body) {
  const token = await getAccessToken();
  const config = {
    method,
    url: `${getBaseUrl()}${endpoint}`,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  if (body) config.data = body;
  return axios(config);
}

async function sendSms({ to, message, from }) {
  const { data } = await rcApi('POST', '/restapi/v1.0/account/~/extension/~/sms', {
    from: { phoneNumber: from },
    to: [{ phoneNumber: to }],
    text: message,
  });
  return data;
}

async function sendBulkSms({ numbers, message, from }) {
  const results = await Promise.allSettled(
    numbers.map(phone => sendSms({ to: phone, message, from }))
  );
  return {
    sent: results.filter(r => r.status === 'fulfilled').length,
    failed: results.filter(r => r.status === 'rejected').length,
    details: results,
  };
}

async function getExtensions() {
  const { data } = await rcApi('GET', '/restapi/v1.0/account/~/extension?type=User&status=Enabled&perPage=100');
  return (data.records || []).map(ext => ({
    id: ext.id,
    extensionNumber: ext.extensionNumber,
    name: ext.name,
    email: ext.contact?.email || null,
    phone: ext.contact?.businessPhone || null,
    directNumber: (ext.phoneNumbers || []).find(p => p.usageType === 'DirectNumber')?.phoneNumber || null,
    status: ext.status,
  }));
}

async function getPresence(extensionId) {
  const { data } = await rcApi('GET', `/restapi/v1.0/account/~/extension/${extensionId}/presence?detailedTelephonyState=true`);
  return {
    presenceStatus: data.presenceStatus,
    telephonyStatus: data.telephonyStatus,
    userStatus: data.userStatus,
    dndStatus: data.dndStatus,
    message: data.message || '',
    activeCalls: (data.activeCalls || []).map(c => ({
      direction: c.direction,
      from: c.from?.phoneNumber || c.from?.name || null,
      to: c.to?.phoneNumber || c.to?.name || null,
      telephonyStatus: c.telephonyStatus,
      sessionId: c.sessionId,
    })),
  };
}

async function getAllPresence() {
  const extensions = await getExtensions();
  const presenceResults = await Promise.allSettled(
    extensions.map(async ext => {
      const presence = await getPresence(ext.id);
      return { ...ext, presence };
    })
  );
  return presenceResults
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);
}

async function getCallLog({ extensionId, dateFrom, dateTo, perPage = 50 }) {
  const params = new URLSearchParams({ perPage: String(perPage), view: 'Detailed' });
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);
  const ext = extensionId || '~';
  const { data } = await rcApi('GET', `/restapi/v1.0/account/~/extension/${ext}/call-log?${params}`);
  return (data.records || []).map(r => ({
    id: r.id,
    sessionId: r.sessionId,
    startTime: r.startTime,
    duration: r.duration,
    direction: r.direction,
    type: r.type,
    result: r.result,
    from: { name: r.from?.name, phone: r.from?.phoneNumber },
    to: { name: r.to?.name, phone: r.to?.phoneNumber },
    recording: r.recording ? { id: r.recording.id, contentUri: r.recording.contentUri } : null,
  }));
}

async function getRecordingContent(recordingId) {
  const token = await getAccessToken();
  const { data } = await axios.get(
    `${getBaseUrl()}/restapi/v1.0/account/~/recording/${recordingId}/content`,
    { headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer' }
  );
  return data;
}

async function makeCall({ from, to }) {
  const { data } = await rcApi('POST', '/restapi/v1.0/account/~/extension/~/ring-out', {
    from: { phoneNumber: from },
    to: { phoneNumber: to },
    playPrompt: true,
  });
  return data;
}

function mapPresenceToOfficeStatus(presence) {
  if (!presence) return 'offline';
  if (presence.telephonyStatus === 'Ringing' || presence.telephonyStatus === 'CallConnected') return 'busy';
  if (presence.dndStatus === 'DoNotAcceptAnyCalls' || presence.dndStatus === 'DoNotAcceptDepartmentCalls') return 'dnd';
  switch (presence.userStatus) {
    case 'Available': return 'online';
    case 'Busy': return 'busy';
    case 'DoNotDisturb': return 'dnd';
    case 'Offline': return 'offline';
    default: return 'away';
  }
}

module.exports = {
  isConfigured,
  sendSms,
  sendBulkSms,
  getExtensions,
  getPresence,
  getAllPresence,
  getCallLog,
  getRecordingContent,
  makeCall,
  mapPresenceToOfficeStatus,
};
