const twilio = require('twilio');

let _client = null;

function getTwilioClient() {
  if (_client) return _client;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return null;
  _client = twilio(accountSid, authToken);
  return _client;
}

function isTwilioConfigured() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
}

async function sendSmsTwilio({ to, message, from }) {
  const client = getTwilioClient();
  if (!client) throw new Error('Twilio not configured');
  return client.messages.create({
    body: message,
    to,
    from,
  });
}

async function searchAvailableNumbers({ areaCode, country = 'US', limit = 10 }) {
  const client = getTwilioClient();
  if (!client) throw new Error('Twilio not configured');
  const params = { smsEnabled: true, limit };
  if (areaCode) params.areaCode = areaCode;
  const numbers = await client.availablePhoneNumbers(country).local.list(params);
  return numbers.map((n) => ({
    phoneNumber: n.phoneNumber,
    friendlyName: n.friendlyName,
    locality: n.locality,
    region: n.region,
  }));
}

async function provisionNumber({ phoneNumber, webhookUrl }) {
  const client = getTwilioClient();
  if (!client) throw new Error('Twilio not configured');
  const incoming = await client.incomingPhoneNumbers.create({
    phoneNumber,
    smsUrl: webhookUrl,
    smsMethod: 'POST',
  });
  return {
    sid: incoming.sid,
    phoneNumber: incoming.phoneNumber,
    friendlyName: incoming.friendlyName,
  };
}

async function releaseNumber(sid) {
  const client = getTwilioClient();
  if (!client) throw new Error('Twilio not configured');
  await client.incomingPhoneNumbers(sid).remove();
}

async function listOwnedNumbers() {
  const client = getTwilioClient();
  if (!client) throw new Error('Twilio not configured');
  const numbers = await client.incomingPhoneNumbers.list({ limit: 50 });
  return numbers.map((n) => ({
    sid: n.sid,
    phoneNumber: n.phoneNumber,
    friendlyName: n.friendlyName,
    smsUrl: n.smsUrl,
  }));
}

module.exports = { getTwilioClient, isTwilioConfigured, sendSmsTwilio, searchAvailableNumbers, provisionNumber, releaseNumber, listOwnedNumbers };
