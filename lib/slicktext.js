const axios = require('axios');

const SLICKTEXT_API_BASE = 'https://api.slicktext.com/v1';

function getSlicktextCredentials() {
  const publicKey = process.env.SLICKTEXT_PUBLIC_KEY;
  const privateKey = process.env.SLICKTEXT_PRIVATE_KEY;

  if (!publicKey || !privateKey) {
    throw new Error('Missing SLICKTEXT_PUBLIC_KEY or SLICKTEXT_PRIVATE_KEY environment variables');
  }

  return { publicKey, privateKey };
}

function slicktextHeaders() {
  const { publicKey, privateKey } = getSlicktextCredentials();
  const credentials = Buffer.from(`${publicKey}:${privateKey}`).toString('base64');
  return { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json' };
}

async function sendSms({ to, message, from }) {
  const headers = slicktextHeaders();
  return axios.post(`${SLICKTEXT_API_BASE}/send`, { number: to, message, from }, { headers });
}

async function sendBulkSms({ numbers, message, from }) {
  const headers = slicktextHeaders();
  return axios.post(`${SLICKTEXT_API_BASE}/send-bulk`, { numbers, message, from }, { headers });
}

module.exports = { sendSms, sendBulkSms };
