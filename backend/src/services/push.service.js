// backend/src/services/push.service.js
// WP-08: FCM push delivery. Lazily initialises firebase-admin from FIREBASE_SERVICE_ACCOUNT_JSON (raw JSON or base64). Without credentials
// every call is a logged-once no-op. Never throws into callers: push is best-effort on top of the DB notification.
'use strict';
const prisma = require('../lib/prisma');

const MAX_ATTEMPTS = () => Math.max(1, Number(process.env.PUSH_MAX_ATTEMPTS) || 3);
const BASE_BACKOFF_MS = 500;
const MAX_TOKENS = 500;
const INVALID_CODES = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-recipient']);   // mismatched-credential is OUR sender config, not a dead token: never revoke on it
const TRANSIENT_CODES = new Set(['messaging/internal-error', 'messaging/server-unavailable', 'messaging/unavailable', 'messaging/message-rate-exceeded', 'messaging/device-message-rate-exceeded', 'messaging/topics-message-rate-exceeded', 'messaging/quota-exceeded']);

const stats = { sent: 0, failed: 0, revoked: 0, retried: 0, skippedNoCredentials: 0, skippedNoTokens: 0, errors: 0 };
let messaging = null;      // cached firebase messaging instance
let initTried = false;
let warned = false;
let sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const warnOnce = (msg) => { if (!warned) { warned = true; console.warn(`[push] ${msg}`); } };

const parseCredentials = (raw) => {
  const s = String(raw || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) { /* maybe base64 */ }
  try { return JSON.parse(Buffer.from(s, 'base64').toString('utf8')); } catch (_) { return null; }
};

/** Returns a messaging client or null (not configured / init failed). Initialises once. */
const getMessaging = () => {
  if (messaging) return messaging;
  if (initTried) return null;
  initTried = true;
  const cred = parseCredentials(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (!cred) { warnOnce(process.env.FIREBASE_SERVICE_ACCOUNT_JSON ? 'FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON; push disabled' : 'FIREBASE_SERVICE_ACCOUNT_JSON not set; push notifications disabled'); return null; }
  try {
    const admin = require('firebase-admin');
    const app = admin.apps && admin.apps.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(cred) });
    messaging = admin.messaging(app);
    return messaging;
  } catch (e) { warnOnce(`firebase-admin init failed (${e.code || e.message}); push disabled`); return null; }
};

/** Where a notification should take the user. data.route is a stable screen key the apps map to navigation targets. */
const ROUTES = [
  [/^ride_/, 'ride'], [/^delivery_/, 'delivery'], [/^(wallet|payment)_/, 'wallet'], [/^(driver|partner)_/, 'account'],
  [/^(account|password)_/, 'account'], [/^ops_/, 'ops_alert'],
];
const routeFor = (type) => { const t = String(type || ''); const hit = ROUTES.find(([re]) => re.test(t)); return hit ? hit[1] : 'notifications'; };

/** FCM data values must be strings; keep scalars only and cap size. */
const buildData = ({ type, data, notificationId }) => {
  const out = { type: String(type || ''), route: routeFor(type) };
  const src = data && typeof data === 'object' ? data : {};
  if (typeof src.route === 'string' && src.route) out.route = src.route.slice(0, 100);
  for (const k of ['rideId', 'deliveryId', 'bookingId', 'link', 'reference']) if (src[k] != null && typeof src[k] !== 'object') out[k] = String(src[k]).slice(0, 200);
  if (src.entityId != null && typeof src.entityId !== 'object') out.entityId = String(src.entityId).slice(0, 200);
  if (notificationId) out.notificationId = String(notificationId);
  return out;
};

const buildMessage = ({ tokens, title, body, data }) => ({
  tokens, notification: { title: String(title || ''), body: String(body || '') }, data,
  android: { priority: 'high', notification: { channelId: process.env.PUSH_ANDROID_CHANNEL_ID || 'runserv_default' } },
  apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
});

const revoke = async (tokens) => {
  if (!tokens.length) return;
  try { const r = await prisma.deviceToken.updateMany({ where: { token: { in: tokens }, revokedAt: null }, data: { revokedAt: new Date() } }); stats.revoked += r.count || 0; }
  catch (e) { console.error('[push] failed to revoke tokens:', e.message); }
};

/**
 * Push to every active device of a user. Returns { sent, failed, revoked, skipped? }; never throws.
 */
const sendToUser = async (userId, { title, body, type, data, notificationId } = {}) => {
  const result = { sent: 0, failed: 0, revoked: 0 };
  try {
    const m = getMessaging();
    if (!m) { stats.skippedNoCredentials += 1; return { ...result, skipped: 'NO_CREDENTIALS' }; }
    const rows = await prisma.deviceToken.findMany({ where: { userId, revokedAt: null }, take: MAX_TOKENS, select: { token: true } });
    let pending = [...new Set(rows.map((r) => r.token))];
    if (!pending.length) { stats.skippedNoTokens += 1; return { ...result, skipped: 'NO_TOKENS' }; }
    const payloadData = buildData({ type, data, notificationId });
    const dead = [];
    for (let attempt = 1; pending.length && attempt <= MAX_ATTEMPTS(); attempt += 1) {
      let resp;
      try { resp = await m.sendEachForMulticast(buildMessage({ tokens: pending, title, body, data: payloadData })); }
      catch (e) {                                   // whole call failed (network / auth): treat every pending token as transient
        const transient = /^app\/network-(error|timeout)$/.test(e.code || '') || !/^(app\/|messaging\/(authentication-error|invalid-argument|invalid-apns-credentials|third-party-auth-error))/.test(e.code || '');
        if (!transient || attempt >= MAX_ATTEMPTS()) { result.failed += pending.length; stats.failed += pending.length; stats.errors += 1; console.error('[push] send failed:', e.code || e.message); pending = []; break; }
        stats.retried += 1; await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1)); continue;
      }
      const retry = [];
      (resp.responses || []).forEach((r, i) => {
        const tok = pending[i];
        if (r.success) { result.sent += 1; stats.sent += 1; return; }
        const code = r.error && r.error.code;
        if (INVALID_CODES.has(code)) { dead.push(tok); result.failed += 1; stats.failed += 1; }
        else if (TRANSIENT_CODES.has(code) && attempt < MAX_ATTEMPTS()) retry.push(tok);
        else { result.failed += 1; stats.failed += 1; console.error('[push] token send failed:', code || 'unknown'); }
      });
      pending = retry;
      if (pending.length) { stats.retried += pending.length; await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1)); }
    }
    await revoke(dead); result.revoked = dead.length;
    return result;
  } catch (e) {
    stats.errors += 1; console.error('[push] unexpected error:', e.message);
    return { ...result, error: true };
  }
};

const getStats = () => ({ ...stats });
const _resetForTests = ({ messagingClient = null, sleepFn = null } = {}) => {
  messaging = messagingClient; initTried = !!messagingClient; warned = false;
  sleep = sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
  Object.keys(stats).forEach((k) => { stats[k] = 0; });
};

module.exports = { sendToUser, getStats, routeFor, buildData, _resetForTests };
