// backend/src/services/emailProviders.service.js
//
// M16.1: provider-neutral transactional email. Two providers behind one interface: Brevo (primary) and Resend (second tier).
// Server-side only: API keys are read from the environment at call time and never leave this module (not logged, not returned).
// Every failure is mapped to a category so the outbox can decide, without guessing, whether to retry, fail over or give up:
//   INVALID_ADDRESS  permanent: the recipient is wrong. Never retried.
//   QUOTA            the provider says its own daily/monthly allowance is used up. Never called again in this window.
//   AUTH             API key / sender not accepted. Provider is parked for a while; not the recipient's fault.
//   TRANSIENT        provider answered with a server error / refused the connection: certainly NOT sent, safe to fail over.
//   TIMEOUT          no answer: AMBIGUOUS (the provider may have sent it). Retried on the SAME provider only.
//   CONFIG           our own configuration is wrong (missing key / sender / bad base URL).
'use strict';
const axios = require('axios');

const PROVIDERS = Object.freeze(['brevo', 'resend']);
const DEFAULT_BASE = Object.freeze({ brevo: 'https://api.brevo.com/v3', resend: 'https://api.resend.com' });
const ALLOWED_HOST = Object.freeze({ brevo: 'api.brevo.com', resend: 'api.resend.com' });

class ProviderError extends Error {
  constructor(message, { category, status = null, ambiguous = false, provider = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.category = category; this.status = status; this.ambiguous = ambiguous; this.provider = provider;
  }
}

const truthy = (v) => String(v || '').toLowerCase() === 'true';
const timeoutMs = (env) => Math.min(Math.max(Number(env.EMAIL_PROVIDER_TIMEOUT_MS) || 8000, 1000), 30000);

/** Base URL is configuration, never user input: https only, and the host must be the provider's own API host. */
function baseUrl(provider, env = process.env) {
  const raw = provider === 'brevo' ? env.BREVO_API_BASE_URL : env.RESEND_API_BASE_URL;
  if (!raw) return DEFAULT_BASE[provider];
  let u; try { u = new URL(raw); } catch { throw new ProviderError(`${provider} base URL is not a valid URL`, { category: 'CONFIG', provider }); }
  if (u.protocol !== 'https:' || u.hostname !== ALLOWED_HOST[provider]) throw new ProviderError(`${provider} base URL must be https://${ALLOWED_HOST[provider]}`, { category: 'CONFIG', provider });
  return u.toString().replace(/\/$/, '');
}

/** { email, name } of the verified sender for a provider, or null. */
function sender(provider, env = process.env) {
  const email = provider === 'brevo' ? env.BREVO_SENDER_EMAIL : (env.RESEND_SENDER_EMAIL || env.BREVO_SENDER_EMAIL);
  const name = (provider === 'brevo' ? env.BREVO_SENDER_NAME : (env.RESEND_SENDER_NAME || env.BREVO_SENDER_NAME)) || 'Runserv';
  return email ? { email: String(email).trim(), name: String(name).trim() } : null;
}

const apiKey = (provider, env = process.env) => (provider === 'brevo' ? env.BREVO_API_KEY : env.RESEND_API_KEY) || null;
/** A provider can be used only when it is switched on AND has a key AND a sender. */
const isEnabled = (provider, env = process.env) => truthy(provider === 'brevo' ? env.BREVO_ENABLED : env.RESEND_ENABLED);
const isConfigured = (provider, env = process.env) => !!(apiKey(provider, env) && sender(provider, env));

const QUOTA_RE = /daily|quota|credit|monthly|limit (reached|exceeded)|exceeded.*(limit|quota)/i;
const ADDRESS_RE = /e-?mail|recipient|address|"to"|\bto\b.*invalid|invalid.*\bto\b/i;

/** Map an HTTP answer (or the absence of one) to a ProviderError. Pure: unit-tested without a network. */
function classify(provider, { status, body, code }) {
  const text = String((body && (body.message || body.error?.message || body.error || body.name)) || '').slice(0, 300);
  const bodyCode = String((body && (body.code || body.name)) || '');
  const mk = (category, ambiguous = false) => new ProviderError(`${provider}: ${text || `HTTP ${status || code || 'no response'}`}`.slice(0, 300), { category, status: status || null, ambiguous, provider });
  if (!status) {
    // Nothing came back. A refused / unresolvable connection means the request never left: safe. Anything else (timeout, reset) is ambiguous.
    if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED_BEFORE_SEND'].includes(code)) return mk('TRANSIENT');
    return mk('TIMEOUT', true);
  }
  if (status === 402) return mk('QUOTA');
  if (status === 429) return QUOTA_RE.test(`${text} ${bodyCode}`) ? mk('QUOTA') : mk('TRANSIENT');
  if (status === 401) return mk('AUTH');
  if (status === 403) return QUOTA_RE.test(`${text} ${bodyCode}`) ? mk('QUOTA') : mk('AUTH');
  if (status === 400 || status === 422) return ADDRESS_RE.test(`${text} ${bodyCode}`) ? mk('INVALID_ADDRESS') : mk('CONFIG');
  if (status >= 500) return mk('TRANSIENT');
  return mk('CONFIG');
}

/**
 * Send one email. message = { to, subject, text, html, idempotencyKey? }. Resolves { provider, messageId } when the provider ACCEPTED it
 * (accepted is not delivered: delivery is learned later from webhooks). Rejects with ProviderError.
 */
async function sendTransactionalEmail(provider, message, { env = process.env, http = axios } = {}) {
  if (!PROVIDERS.includes(provider)) throw new ProviderError(`unknown provider ${provider}`, { category: 'CONFIG', provider });
  const key = apiKey(provider, env); const from = sender(provider, env);
  if (!key || !from) throw new ProviderError(`${provider} is not configured (API key or sender missing)`, { category: 'CONFIG', provider });
  const base = baseUrl(provider, env);
  const cfg = { timeout: timeoutMs(env), validateStatus: () => true };
  let res;
  try {
    if (provider === 'brevo') {
      res = await http.post(`${base}/smtp/email`, {
        sender: { name: from.name, email: from.email }, to: [{ email: message.to }], subject: message.subject,
        textContent: message.text, htmlContent: message.html, tags: ['guest-otp'],
      }, { ...cfg, headers: { 'api-key': key, accept: 'application/json', 'content-type': 'application/json' } });
    } else {
      res = await http.post(`${base}/emails`, {
        from: `${from.name} <${from.email}>`, to: [message.to], subject: message.subject, text: message.text, html: message.html, tags: [{ name: 'type', value: 'guest-otp' }],
      }, { ...cfg, headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(message.idempotencyKey ? { 'Idempotency-Key': String(message.idempotencyKey) } : {}) } });
    }
  } catch (e) {
    throw classify(provider, { code: e.code || (/timeout/i.test(e.message) ? 'ETIMEDOUT' : 'UNKNOWN') });
  }
  if (res.status >= 200 && res.status < 300) {
    const messageId = provider === 'brevo' ? res.data?.messageId : res.data?.id;
    if (!messageId) throw new ProviderError(`${provider}: accepted but returned no message id`, { category: 'TIMEOUT', ambiguous: true, status: res.status, provider });
    return { provider, messageId: String(messageId) };
  }
  throw classify(provider, { status: res.status, body: res.data });
}

module.exports = { PROVIDERS, ProviderError, baseUrl, sender, apiKey, isEnabled, isConfigured, classify, sendTransactionalEmail };
