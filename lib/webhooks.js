const axios = require('axios');

/**
 * Fire-and-forget outbound webhook to Zapier and/or n8n.
 * Errors are logged but never thrown — outbound webhooks must not break app flow.
 *
 * @param {string} event    Event name, e.g. 'sms_received', 'client_created'
 * @param {object} payload  Event data
 */
async function triggerOutbound(event, payload) {
  const urls = [
    process.env.ZAPIER_WEBHOOK_URL,
    process.env.N8N_WEBHOOK_URL,
  ].filter(Boolean);

  if (!urls.length) return;

  const body = {
    event,
    payload,
    timestamp: new Date().toISOString(),
    source: 'noah-connect-virtual-office',
  };

  await Promise.allSettled(
    urls.map((url) =>
      axios.post(url, body, {
        timeout: 10000,
        headers: { 'Content-Type': 'application/json' },
      }).catch((err) => {
        console.error(`[webhooks] Failed to POST to ${url}: ${err.message}`);
      })
    )
  );
}

/**
 * Synchronous request-response outbound webhook to Zapier and/or n8n.
 * Returns the first successful response body, or null if all requests fail.
 * Useful when the caller needs to read data that the automation returns (e.g. an AI reply).
 *
 * @param {string} event    Event name
 * @param {object} payload  Event data
 * @returns {Promise<object|null>} First successful response data, or null
 */
async function triggerOutboundWithResponse(event, payload) {
  const urls = [
    process.env.ZAPIER_WEBHOOK_URL,
    process.env.N8N_WEBHOOK_URL,
  ].filter(Boolean);

  if (!urls.length) return null;

  const body = {
    event,
    payload,
    timestamp: new Date().toISOString(),
    source: 'noah-connect-virtual-office',
  };

  const results = await Promise.allSettled(
    urls.map((url) =>
      axios.post(url, body, {
        timeout: 15000,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      return result.value.data || null;
    }
    console.error(`[webhooks] triggerOutboundWithResponse failed: ${result.reason?.message}`);
  }
  return null;
}

module.exports = { triggerOutbound, triggerOutboundWithResponse };
