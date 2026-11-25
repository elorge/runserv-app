// backend/src/services/smsOutbox.service.js
//
// M16: durable SMS for guest bookings (tracking link to the guest, hand-over code to the parcel recipient).
// Rows are written INSIDE the booking transaction (enqueueTx), so a booking can never exist without its notification being queued.
// A worker delivers with retry, exponential back-off and a dead-letter state; Admin can see dead rows and re-queue them.
//
// What is deliberately NOT stored: the message text, the hand-over code and the tracking token. They are derived again at send time from
// the booking, so a database dump of this table contains no secret. The destination phone is kept only while it is needed:
// cleared on SENT / SKIPPED, and on DEAD after SCRUB_DEAD_DAYS (Admin can still re-queue a dead row inside that window).
// The OTP is NOT sent through here: the person is waiting on it, so it stays synchronous and fails closed.
'use strict';

const prisma = require('../lib/prisma');

const KINDS = Object.freeze({ GUEST_TRACKING: 'GUEST_TRACKING', RECIPIENT_CODE: 'RECIPIENT_CODE' });
const MAX_ATTEMPTS = Number(process.env.SMS_OUTBOX_MAX_ATTEMPTS) || 6;
const STALE_PROCESSING_MS = 5 * 60 * 1000;
const SCRUB_DEAD_DAYS = 14;
const backoffMs = (attempts) => Math.min(30000 * 2 ** Math.max(attempts - 1, 0), 30 * 60 * 1000);
// M16.2: delivery SMS has its own switch (SMS_DELIVERY_NOTIFICATIONS_ENABLED) so it is independent of the guest OTP flags. While it is
// unset the legacy ENABLE_SMS_DELIVERY still applies, so existing deployments keep working. Unset/false = SMS stays OFF (pilot default).
const enabled = (env = process.env) => String(env.SMS_DELIVERY_NOTIFICATIONS_ENABLED !== undefined && env.SMS_DELIVERY_NOTIFICATIONS_ENABLED !== '' ? env.SMS_DELIVERY_NOTIFICATIONS_ENABLED : env.ENABLE_SMS_DELIVERY).toLowerCase() === 'true';
const mask = (p) => { const d = String(p || '').replace(/[^\d+]/g, ''); return d.length > 6 ? `${d.slice(0, 4)}****${d.slice(-3)}` : '****'; };

/** Call INSIDE the booking transaction. Plain create: the (kind, bookingId) pair is new by construction. */
async function enqueueTx(tx, { kind, bookingId = null, deliveryId = null, phone, countryCode = null, idempotencyKey = null, env = process.env }) {
  if (!enabled(env)) return null;
  if (!KINDS[kind]) throw new Error(`unknown SMS kind ${kind}`);
  if (!bookingId && !deliveryId) throw new Error('SMS needs a bookingId or a deliveryId');
  let to = String(phone || '').replace(/[^\d+]/g, '');
  let invalid = null;
  try {
    const { checkPhoneForCountry } = require('../utils/phone');
    const identity = require('./guestIdentity.service');
    const cc = String(countryCode || 'NG').toUpperCase();
    if (!checkPhoneForCountry(to, cc).ok) invalid = 'Number is not valid for this country';
    else to = identity.toE164(to, cc);
  } catch (e) { invalid = `Number could not be normalised: ${e.message}`.slice(0, 200); }
  // A number we can never deliver to is recorded as DEAD at once, so support SEES it instead of it vanishing.
  return tx.smsOutbox.create({ data: { kind, ...(bookingId ? { bookingId } : { deliveryId }), idempotencyKey: idempotencyKey || null, toPhone: invalid ? null : to, toMasked: mask(phone), countryCode, ...(invalid ? { status: 'DEAD', lastError: invalid } : {}) } });
}

/**
 * WP-07: durable SMS for a REGISTERED customer's parcel (no guest booking). Replaces the old fire-and-forget direct send, so the status is persisted
 * (QUEUED/SENT/DELIVERED/FAILED, attempts, provider message id) and retried by the worker. Idempotent per (kind, delivery, code version): a repeat call
 * returns the existing row. Returns null when delivery SMS is switched off (the caller reports DISABLED, nothing is sent).
 */
async function enqueueForDelivery({ deliveryId, phone, countryCode = null, codeVersion = 1, env = process.env }) {
  if (!enabled(env)) return null;
  const idempotencyKey = `RECIPIENT_CODE:${deliveryId}:${codeVersion}`;
  const existing = await prisma.smsOutbox.findFirst({ where: { kind: KINDS.RECIPIENT_CODE, deliveryId } });
  if (existing) return existing;
  try { return await enqueueTx(prisma, { kind: KINDS.RECIPIENT_CODE, deliveryId, phone, countryCode, idempotencyKey, env }); }
  catch (e) { if (e?.code === 'P2002') return prisma.smsOutbox.findFirst({ where: { kind: KINDS.RECIPIENT_CODE, deliveryId } }); throw e; }
}

/** Build the message from the booking at send time. Returns null when sending would be wrong (cancelled, link revoked/expired). */
async function render(row, env = process.env, now = Date.now()) {
  if (!row.bookingId && row.deliveryId) {          // WP-07: registered parcel
    const d = await prisma.delivery.findUnique({ where: { id: row.deliveryId } });
    if (!d || d.status === 'CANCELLED' || d.podVerifiedAt || d.failedAt) return null;
    const pc = require('./podCode.service');
    if (pc.isExpired(d, now)) return null;
    return `A Runserv parcel is coming to you. Give the courier the code ${pc.codeFor(d, env)} ONLY when you have the parcel in your hands. Never share it before.`;
  }
  const gb = require('./guestBooking.service');
  const b = await prisma.guestBooking.findUnique({ where: { id: row.bookingId } });
  if (!b) return null;
  if (row.kind === KINDS.GUEST_TRACKING) {
    if (b.trackingRevokedAt || now >= new Date(b.trackingExpiresAt).getTime()) return null;
    const url = gb.trackingUrl(gb.deriveTrackingToken(b.id, b.trackingNonce, env), env);
    if (!url.startsWith('http')) throw new Error('GUEST_TRACKING_BASE_URL is not an absolute URL');
    return `Runserv booking ${b.reference}. Track it here: ${url}`;
  }
  if (row.kind === KINDS.RECIPIENT_CODE) {
    if (!b.deliveryId) return null;
    const d = await prisma.delivery.findUnique({ where: { id: b.deliveryId } });
    if (!d || d.status === 'CANCELLED' || d.podVerifiedAt || d.failedAt) return null;
    const pc = require('./podCode.service');
    if (pc.isExpired(d, now)) return null;                     // never send an expired code; Admin rotates instead
    return `A Runserv parcel is coming to you (ref ${b.reference}). Give the courier the code ${pc.codeFor(d, env)} ONLY when you have the parcel in your hands. Never share it before.`;
  }
  return null;
}

/** Claim and send one row. Safe to call concurrently: the claim is a conditional update. */
async function processEvent(id, { now = new Date(), env = process.env, sms = null } = {}) {
  const claim = await prisma.smsOutbox.updateMany({
    where: { id, OR: [{ status: 'PENDING', nextAttemptAt: { lte: now } }, { status: 'PROCESSING', updatedAt: { lt: new Date(now.getTime() - STALE_PROCESSING_MS) } }] },
    data: { status: 'PROCESSING', attempts: { increment: 1 } },
  });
  if (claim.count !== 1) return { skipped: true };
  const row = await prisma.smsOutbox.findUnique({ where: { id } });
  try {
    if (!enabled(env)) { await prisma.smsOutbox.update({ where: { id }, data: { status: 'SKIPPED', toPhone: null, lastError: 'SMS delivery is switched off' } }); return { skipped: true }; }
    const text = await render(row, env, now.getTime());
    if (text == null) { await prisma.smsOutbox.update({ where: { id }, data: { status: 'SKIPPED', toPhone: null, lastError: 'No longer needed (cancelled, completed or link turned off)' } }); return { skipped: true }; }
    if (!row.toPhone) throw new Error('No destination number');
    const gateway = sms || require('./termii.service');
    const res = await gateway.send(row.toPhone, text);
    const providerMessageId = res && (res.message_id ?? res.messageId ?? res.id) != null ? String(res.message_id ?? res.messageId ?? res.id).slice(0, 120) : null;
    await prisma.smsOutbox.update({ where: { id }, data: { status: 'SENT', sentAt: new Date(), toPhone: null, lastError: null, provider: gateway.providerName || (sms ? 'custom' : 'termii'), providerMessageId, deliveryStatus: 'ACCEPTED' } });
    return { done: true };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 300);
    if (row.attempts >= MAX_ATTEMPTS) { await prisma.smsOutbox.update({ where: { id }, data: { status: 'DEAD', lastError: msg, deliveryStatus: 'FAILED' } }); console.error('[sms-outbox] dead-lettered', row.kind, row.bookingId || row.deliveryId, msg);
      if (row.kind === 'RECIPIENT_CODE') require('./opsAlert.service').recipientHandoverFailed({ bookingId: row.bookingId || null, deliveryId: row.deliveryId || null, why: 'SMS_DEAD', category: 'SMS_FAILED' }).catch(() => {});   // M16.2.2: tell operations, best-effort
      return { dead: true }; }
    await prisma.smsOutbox.update({ where: { id }, data: { status: 'PENDING', lastError: msg, nextAttemptAt: new Date(now.getTime() + backoffMs(row.attempts)) } });
    return { retry: true };
  }
}

/** Immediate best-effort delivery right after the booking commits (keeps latency as before); the worker retries on failure. */
async function processForBooking(bookingId, opts = {}) {
  const rows = await prisma.smsOutbox.findMany({ where: { bookingId, status: 'PENDING' } });
  const out = [];
  for (const r of rows) out.push(await processEvent(r.id, opts));
  return out;
}

async function processForDelivery(deliveryId, opts = {}) {
  const rows = await prisma.smsOutbox.findMany({ where: { deliveryId, status: 'PENDING' } });
  const out = [];
  for (const r of rows) out.push(await processEvent(r.id, opts));
  return out;
}

/**
 * Provider delivery receipt (webhook / poller): DELIVERED or FAILED for a message the provider accepted. Matches by provider message id, is idempotent,
 * and never moves a DELIVERED message backwards. Returns { applied }.
 */
async function applyReceipt({ providerMessageId, status, at = new Date() }) {
  const st = String(status || '').toUpperCase();
  if (!providerMessageId || !['DELIVERED', 'FAILED'].includes(st)) return { applied: false };
  const r = await prisma.smsOutbox.updateMany({ where: { providerMessageId: String(providerMessageId), status: 'SENT', OR: [{ deliveryStatus: null }, { deliveryStatus: { not: 'DELIVERED' } }] }, data: { deliveryStatus: st, deliveryAt: at } });
  return { applied: r.count > 0 };
}

const DUE = (now) => ({ OR: [{ status: 'PENDING', nextAttemptAt: { lte: now } }, { status: 'PROCESSING', updatedAt: { lt: new Date(now.getTime() - STALE_PROCESSING_MS) } }] });

async function processDue({ limit = 25, now = new Date(), env = process.env, sms = null } = {}) {
  const due = await prisma.smsOutbox.findMany({ where: DUE(now), orderBy: { createdAt: 'asc' }, take: limit });
  const r = { processed: 0, sent: 0, retry: 0, dead: 0, skipped: 0 };
  for (const { id } of due) {
    const o = await processEvent(id, { now, env, sms });
    if (o.skipped) { r.skipped += 1; continue; }
    r.processed += 1; if (o.done) r.sent += 1; if (o.retry) r.retry += 1; if (o.dead) r.dead += 1;
  }
  return r;
}

/** Dead rows keep the number only for SCRUB_DEAD_DAYS (so Admin can re-queue), then it is removed. */
async function scrubDead({ now = new Date() } = {}) {
  const r = await prisma.smsOutbox.updateMany({ where: { status: 'DEAD', toPhone: { not: null }, updatedAt: { lt: new Date(now.getTime() - SCRUB_DEAD_DAYS * 86400000) } }, data: { toPhone: null } });
  return r.count;
}

/** Admin: put a DEAD row back in the queue. Fails if its number was already scrubbed or was never valid. */
async function requeue(id, { now = new Date() } = {}) {
  const row = await prisma.smsOutbox.findUnique({ where: { id } });
  if (!row) { const e = new Error('Message not found'); e.statusCode = 404; throw e; }
  if (row.status !== 'DEAD') { const e = new Error('Only failed messages can be re-queued.'); e.statusCode = 409; throw e; }
  if (!row.toPhone) { const e = new Error('The destination number is no longer stored, so this message cannot be re-sent. Ask the guest to confirm the number.'); e.statusCode = 409; throw e; }
  const r = await prisma.smsOutbox.updateMany({ where: { id, status: 'DEAD' }, data: { status: 'PENDING', attempts: 0, nextAttemptAt: now, lastError: null } });
  return { requeued: r.count === 1 };
}

/**
 * Admin resend of the recipient SMS: the SAME code, never a new one. The number comes from the delivery (it was cleared from the outbox row
 * after the first send). Resets the single (kind, booking) row to PENDING; a repeat is limited by the caller's cooldown.
 */
async function resetForResend(bookingId, { phone, countryCode, deliveryId = null, env = process.env } = {}) {
  if (!enabled(env)) return { resent: false, reason: 'DISABLED' };
  const { checkPhoneForCountry } = require('../utils/phone');
  const identity = require('./guestIdentity.service');
  const cc = String(countryCode || 'NG').toUpperCase();
  const raw = String(phone || '').replace(/[^\d+]/g, '');
  if (!checkPhoneForCountry(raw, cc).ok) return { resent: false, reason: 'INVALID_NUMBER' };
  const to = identity.toE164(raw, cc);
  const row = await prisma.smsOutbox.findFirst({ where: bookingId ? { bookingId, kind: KINDS.RECIPIENT_CODE } : { deliveryId, kind: KINDS.RECIPIENT_CODE } });
  if (!row) return { resent: false, reason: 'NOT_QUEUED' };
  if (['PENDING', 'PROCESSING'].includes(row.status)) return { resent: false, reason: 'ALREADY_QUEUED' };
  const r = await prisma.smsOutbox.updateMany({ where: { id: row.id, status: { in: ['SENT', 'DEAD', 'SKIPPED'] } }, data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null, toPhone: to, providerMessageId: null, deliveryStatus: null, deliveryAt: null } });
  return { resent: r.count === 1 };
}

/** What the guest's own status screen may learn: delivery state per kind, nothing else. */
async function noticesFor(bookingId) {
  const rows = await prisma.smsOutbox.findMany({ where: { bookingId } });
  const s = (k) => { const r = rows.find((x) => x.kind === k); return r ? (r.status === 'SKIPPED' ? 'SKIPPED' : r.status) : null; };
  return { trackingSms: s(KINDS.GUEST_TRACKING), recipientSms: s(KINDS.RECIPIENT_CODE) };
}

async function stats(now = new Date()) {
  const [pending, dead, oldest] = await Promise.all([
    prisma.smsOutbox.count({ where: { status: 'PENDING' } }), prisma.smsOutbox.count({ where: { status: 'DEAD' } }),
    prisma.smsOutbox.findFirst({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' } }),
  ]);
  const oldestAgeSeconds = oldest ? Math.floor((now.getTime() - new Date(oldest.createdAt).getTime()) / 1000) : 0;
  const alerts = [];
  if (dead > 0) alerts.push(`${dead} SMS message(s) failed permanently and need attention`);
  if (oldestAgeSeconds > 900) alerts.push(`Oldest queued SMS is ${Math.round(oldestAgeSeconds / 60)} minutes old`);
  return { pending, dead, oldestAgeSeconds, alerts };
}

let timer = null;
const startWorker = ({ intervalMs = 15000 } = {}) => {
  if (timer || process.env.SMS_OUTBOX_WORKER === 'off') return null;
  let busy = false; let ticks = 0;
  timer = setInterval(async () => {
    if (busy) return; busy = true;
    try { await processDue(); if (++ticks % 240 === 0) await scrubDead(); } catch (e) { console.error('[sms-outbox] worker error:', e.message); } finally { busy = false; }
  }, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
};
const stopWorker = () => { if (timer) { clearInterval(timer); timer = null; } };

module.exports = { enqueueForDelivery, processForDelivery, applyReceipt, resetForResend, KINDS, MAX_ATTEMPTS, SCRUB_DEAD_DAYS, backoffMs, enabled, mask, enqueueTx, render, processEvent, processForBooking, processDue, scrubDead, requeue, noticesFor, stats, startWorker, stopWorker };
