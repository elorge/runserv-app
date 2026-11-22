// backend/src/services/emailWebhookAuth.service.js — authenticity checks for provider webhooks. Fail closed: no secret configured = refuse.
'use strict';
const crypto = require('crypto');

const safeEq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };

/** Brevo: a shared token sent as "Authorization: Bearer <token>" (configured on the webhook in the Brevo dashboard). */
function verifyBrevo(headers, env = process.env) {
  const secret = env.BREVO_WEBHOOK_SECRET;
  if (!secret) return { ok: false, status: 503, reason: 'BREVO_WEBHOOK_SECRET is not configured' };
  const h = String(headers.authorization || '');
  const token = /^Bearer (.+)$/.exec(h)?.[1] || headers['x-brevo-webhook-token'] || '';
  return safeEq(token, secret) ? { ok: true } : { ok: false, status: 401, reason: 'bad token' };
}

/** Resend signs webhooks with Svix: HMAC-SHA256 over "<id>.<timestamp>.<raw body>", key = base64 part of the "whsec_…" secret. */
function verifyResend(headers, rawBody, env = process.env, now = Date.now()) {
  const secret = env.RESEND_WEBHOOK_SECRET;
  if (!secret) return { ok: false, status: 503, reason: 'RESEND_WEBHOOK_SECRET is not configured' };
  const id = headers['svix-id']; const ts = headers['svix-timestamp']; const sigs = String(headers['svix-signature'] || '');
  if (!id || !ts || !sigs || !Buffer.isBuffer(rawBody)) return { ok: false, status: 401, reason: 'missing signature headers' };
  if (Math.abs(now / 1000 - Number(ts)) > 300) return { ok: false, status: 401, reason: 'timestamp outside tolerance' };
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${rawBody.toString('utf8')}`).digest('base64');
  const ok = sigs.split(' ').some((s) => safeEq(s.replace(/^v1,/, ''), expected));
  return ok ? { ok: true } : { ok: false, status: 401, reason: 'bad signature' };
}

module.exports = { verifyBrevo, verifyResend };
