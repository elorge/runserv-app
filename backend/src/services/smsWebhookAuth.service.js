// backend/src/services/smsWebhookAuth.service.js — authenticity for SMS delivery-receipt webhooks. Fail closed: no secret configured = refuse.
// Accepts EITHER an HMAC-SHA256 hex signature of the raw body (x-sms-signature / x-termii-signature / x-signature, optional "sha256=" prefix)
// OR a shared token ("Authorization: Bearer <token>" / x-sms-webhook-token). Configure whichever the provider can send.
'use strict';
const crypto = require('crypto');
const safeEq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };

function verifySms(headers, rawBody, env = process.env) {
  const secret = env.SMS_WEBHOOK_SECRET;
  if (!secret) return { ok: false, status: 503, reason: 'SMS_WEBHOOK_SECRET is not configured' };
  const token = /^Bearer (.+)$/.exec(String(headers.authorization || ''))?.[1] || headers['x-sms-webhook-token'] || '';
  if (token && safeEq(token, secret)) return { ok: true };
  const sig = String(headers['x-sms-signature'] || headers['x-termii-signature'] || headers['x-signature'] || '').replace(/^sha256=/i, '');
  if (sig && Buffer.isBuffer(rawBody)) {
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (safeEq(sig.toLowerCase(), expected)) return { ok: true };
  }
  return { ok: false, status: 401, reason: 'bad token or signature' };
}
module.exports = { verifySms };
