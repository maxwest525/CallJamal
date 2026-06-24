const { WebClient } = require('@slack/web-api');

function getSlackClient() {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error('SLACK_BOT_TOKEN not configured');
  }
  return new WebClient(token);
}

/**
 * Post a message to a Slack channel
 * @param {string} channel  Channel ID or name (e.g. #general)
 * @param {string} text     Message text
 */
async function postMessage({ channel, text }) {
  const client = getSlackClient();
  return client.chat.postMessage({ channel, text });
}

/**
 * List all channels the bot has access to
 */
async function listChannels() {
  const client = getSlackClient();
  const result = await client.conversations.list({
    types: 'public_channel,private_channel',
    limit: 200,
    exclude_archived: true,
  });
  return result.channels || [];
}

/**
 * Fetch recent messages for a channel
 * @param {string} channelId  Slack channel ID
 * @param {number} limit      Number of messages to fetch
 */
async function getChannelHistory(channelId, limit = 50) {
  const client = getSlackClient();
  const result = await client.conversations.history({ channel: channelId, limit });
  return result.messages || [];
}

/**
 * Verify a Slack request signature
 * @param {string} signingSecret
 * @param {string} signature     X-Slack-Signature header
 * @param {string} timestamp     X-Slack-Request-Timestamp header
 * @param {string} rawBody       Raw request body string
 */
function verifySlackSignature(signingSecret, signature, timestamp, rawBody) {
  const crypto = require('crypto');
  const fiveMinutes = 5 * 60;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > fiveMinutes) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const expected = 'v0=' + crypto.createHmac('sha256', signingSecret).update(baseString).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

module.exports = { getSlackClient, postMessage, listChannels, getChannelHistory, verifySlackSignature };
