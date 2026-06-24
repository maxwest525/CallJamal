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
    source: 'calljamal-virtual-office',
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

module.exports = { triggerOutbound };
