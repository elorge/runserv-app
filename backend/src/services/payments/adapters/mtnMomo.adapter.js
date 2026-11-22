// backend/src/services/payments/adapters/mtnMomo.adapter.js
//
// MTN MoMo "Collection" adapter (Request-to-Pay).
//
// ── STATUS: SANDBOX DRAFT — DISABLED BY DEFAULT ──────────────────────────────────────────────────────────────────
// Written against MTN's public MoMo Open API (collection: token, requesttopay, requesttopay/{referenceId}). The exact
// NIGERIAN product, onboarding route, currencies, limits, settlement and refund support are NOT confirmed (recommendation
// doc §7, stages A–E). Until MTN confirms them in writing this adapter:
//   • is never reachable by customers (providerConfig.service refuses it unless enabled + eligible), and
//   • cannot be switched on for LIVE (needs onboardingStatus PRODUCTION_APPROVED + a second Super Admin).
// Re-check every call below against the official docs MTN issues to Elorge before certification.
//
// What is NOT assumed: callbacks are not signed in the public API, so a callback is only a "go and look" nudge — the status
// is always read back from MTN server-side (verifyCollection) before anything is settled. No PIN/OTP is ever handled here:
// the customer approves on their own handset.
//
// Credentials (names follow MTN's own API terms; confirm against the docs MTN issues):
//   MTN_MOMO_SUBSCRIPTION_KEY   Ocp-Apim-Subscription-Key for the Collection product
//   MTN_MOMO_API_USER           API user (UUID) created via the provisioning API / portal
//   MTN_MOMO_API_KEY            API key for that user
//   MTN_MOMO_CALLBACK_SECRET    OUR secret, used to sign our own callback URL (not an MTN value)
// Non-secret (Admin → provider safe config, or env): MTN_MOMO_BASE_URL, MTN_MOMO_TARGET_ENVIRONMENT.
'use strict';
const axios = require('axios');
const crypto = require('crypto');
const { AppError } = require('../../../middleware/errorHandler');
const { isWholeUnitCurrency } = require('../../../utils/currency');

const KEY = 'mtn_momo';
const INTEGRATION_VERSION = 'sandbox-draft-0';
const SECRET_NAMES = ['subscriptionKey', 'apiUser', 'apiKey', 'callbackSecret'];
const ENV_FOR = {
  subscriptionKey: 'MTN_MOMO_SUBSCRIPTION_KEY',
  apiUser: 'MTN_MOMO_API_USER',
  apiKey: 'MTN_MOMO_API_KEY',
  callbackSecret: 'MTN_MOMO_CALLBACK_SECRET',
};

const tokenCache = new Map(); // `${apiUser}` -> { token, exp }

/** @param {{secrets:Record<string,string>, safeConfig?:object, environment:'SANDBOX'|'LIVE'}} ctx */
const settings = (ctx) => {
  const s = ctx.secrets || {};
  const c = ctx.safeConfig || {};
  const sandbox = ctx.environment !== 'LIVE';
  return {
    baseUrl: String(c.baseUrl || process.env.MTN_MOMO_BASE_URL || (sandbox ? 'https://sandbox.momodeveloper.mtn.com' : '')).replace(/\/+$/, ''),
    targetEnvironment: c.targetEnvironment || process.env.MTN_MOMO_TARGET_ENVIRONMENT || (sandbox ? 'sandbox' : ''),
    subscriptionKey: s.subscriptionKey, apiUser: s.apiUser, apiKey: s.apiKey,
  };
};

const missing = (ctx) => {
  const st = settings(ctx);
  const out = [];
  if (!st.baseUrl) out.push('baseUrl');
  if (!st.targetEnvironment) out.push('targetEnvironment');
  for (const n of ['subscriptionKey', 'apiUser', 'apiKey']) if (!st[n]) out.push(n);
  return out;
};
const isConfigured = (ctx) => missing(ctx).length === 0;

const http = () => axios.create({ timeout: 15000 });

const getToken = async (ctx) => {
  const st = settings(ctx);
  const ck = `${st.baseUrl}|${st.apiUser}`;
  const hit = tokenCache.get(ck);
  if (hit && hit.exp > Date.now() + 30000) return hit.token;
  const basic = Buffer.from(`${st.apiUser}:${st.apiKey}`).toString('base64');
  const { data } = await http().post(`${st.baseUrl}/collection/token/`, null, {
    headers: { Authorization: `Basic ${basic}`, 'Ocp-Apim-Subscription-Key': st.subscriptionKey },
  });
  tokenCache.set(ck, { token: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 });
  return data.access_token;
};

const authHeaders = async (ctx) => {
  const st = settings(ctx);
  return {
    Authorization: `Bearer ${await getToken(ctx)}`,
    'X-Target-Environment': st.targetEnvironment,
    'Ocp-Apim-Subscription-Key': st.subscriptionKey,
  };
};

/** Decimal string with no float arithmetic on the way out ("1500" for whole-unit currencies, "12.50" otherwise). */
const amountString = (amount, currency) => {
  const minor = Math.round(Number(amount) * 100);
  if (!Number.isFinite(minor) || minor <= 0) throw new AppError('Invalid amount.', 400);
  if (isWholeUnitCurrency(currency)) return String(Math.round(minor / 100));
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
};

// ── signed callback URL (OUR token, since MTN's public API does not sign callbacks) ──────────────────────────────
const callbackToken = (referenceId, secret) => crypto.createHmac('sha256', secret).update(String(referenceId)).digest('base64url');
const verifyCallbackToken = (referenceId, token, secret) => {
  if (!secret || !token) return false;
  const a = Buffer.from(callbackToken(referenceId, secret)); const b = Buffer.from(String(token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const getCapabilities = () => ({
  key: KEY, name: 'MTN MoMo', integrationVersion: INTEGRATION_VERSION,
  operations: { collection: true, verify: true, webhook: true, refund: false, payout: false },
  // Refunds / payouts are deliberately false: not confirmed for the Nigerian product. Admin must not be shown them.
  methods: ['MOBILE_MONEY'],
  secretNames: SECRET_NAMES,
  secretEnvNames: ENV_FOR,
});

/**
 * Start a collection. The referenceId is OURS (UUID) so the request stays queryable even if the HTTP response is lost.
 * @returns {{ accepted:true, providerReference:string }}   throws AppError(code 'PROVIDER_REJECTED' | 'PROVIDER_UNREACHABLE')
 */
const createCollection = async (ctx, { referenceId, amount, currency, externalId, msisdn, payerMessage, payeeNote, callbackUrl }) => {
  if (!isConfigured(ctx)) throw Object.assign(new AppError('MTN MoMo is not configured.', 503), { code: 'NOT_CONFIGURED' });
  const st = settings(ctx);
  try {
    const headers = { ...(await authHeaders(ctx)), 'X-Reference-Id': referenceId, 'Content-Type': 'application/json' };
    if (callbackUrl && /^https:\/\//i.test(callbackUrl)) headers['X-Callback-Url'] = callbackUrl;
    await http().post(`${st.baseUrl}/collection/v1_0/requesttopay`, {
      amount: amountString(amount, currency), currency, externalId,
      payer: { partyIdType: 'MSISDN', partyId: String(msisdn) },
      payerMessage: String(payerMessage || 'Runserv payment').slice(0, 80),
      payeeNote: String(payeeNote || externalId).slice(0, 80),
    }, { headers });
    return { accepted: true, providerReference: referenceId };
  } catch (err) {
    if (err instanceof AppError) throw err;
    const status = err?.response?.status;
    // A definite 4xx from MTN means nothing was started. Anything else (timeout, 5xx, no response) is AMBIGUOUS: the request
    // may have been accepted, so the caller leaves the attempt PENDING and lets verification decide.
    if (status && status >= 400 && status < 500 && status !== 429) {
      throw Object.assign(new AppError('MTN MoMo rejected the payment request.', 400), { code: 'PROVIDER_REJECTED', providerStatus: status });
    }
    throw Object.assign(new AppError('MTN MoMo could not be reached.', 502), { code: 'PROVIDER_UNREACHABLE' });
  }
};

/** @returns {{ status:'SUCCESSFUL'|'FAILED'|'PENDING'|'UNKNOWN', amount?:string, currency?:string, externalId?:string, reason?:string, raw:string }} */
const verifyCollection = async (ctx, referenceId) => {
  if (!isConfigured(ctx)) throw Object.assign(new AppError('MTN MoMo is not configured.', 503), { code: 'NOT_CONFIGURED' });
  const st = settings(ctx);
  try {
    const { data } = await http().get(`${st.baseUrl}/collection/v1_0/requesttopay/${encodeURIComponent(referenceId)}`, { headers: await authHeaders(ctx) });
    const raw = String(data?.status || '').toUpperCase();
    const status = ['SUCCESSFUL', 'FAILED', 'PENDING'].includes(raw) ? raw : 'UNKNOWN';
    return {
      status, raw, amount: data?.amount != null ? String(data.amount) : undefined, currency: data?.currency,
      externalId: data?.externalId, reason: typeof data?.reason === 'string' ? data.reason : data?.reason?.code,
    };
  } catch (err) {
    if (err?.response?.status === 404) return { status: 'UNKNOWN', raw: 'NOT_FOUND' };
    throw Object.assign(new AppError('MTN MoMo status could not be read.', 502), { code: 'PROVIDER_UNREACHABLE' });
  }
};

module.exports = {
  KEY, INTEGRATION_VERSION, SECRET_NAMES, ENV_FOR, settings, missing, isConfigured,
  getCapabilities, createCollection, verifyCollection, amountString, callbackToken, verifyCallbackToken,
};
