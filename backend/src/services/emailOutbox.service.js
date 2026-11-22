// backend/src/services/emailOutbox.service.js
//
// M16.1: durable EMAIL outbox (the email twin of smsOutbox.service.js). Used first for the guest verification OTP.
//   * The row is written INSIDE the same transaction as the OTP challenge (enqueueOtpTx), so a challenge can never exist without its email
//     being queued, and a rolled-back challenge never leaves an orphan email.
//   * NO code and NO message text is stored. The row points at the challenge (otpId) and the worker derives the code again at send time
//     (guestIdentity.deriveEmailCode). A database dump of this table contains no secret. The address is cleared on SENT / SKIPPED and on
//     DEAD after SCRUB_DEAD_DAYS.
//   * Worker: bounded retries with exponential back-off, dead-letter, idempotent (a retry never creates a second challenge and never
//     extends the expiry: it only re-renders the existing one). Provider choice and quota bookkeeping live in emailQuota.service.js.
//   * SENT means "a provider ACCEPTED it", not "the inbox has it". Delivery is learned later from webhooks (applyDeliveryEvent).
'use strict';
const prisma = require('../lib/prisma');
const providers = require('./emailProviders.service');
const quota = require('./emailQuota.service');

// M16.2: GUEST_OTP points at a challenge (otpId). RECIPIENT_CODE (hand-over code + tracking link, to the RECIPIENT) and GUEST_TRACKING
// (tracking link, to the SENDER) point at a booking (bookingId). The three are separate credentials and never share a row or a lifecycle.
const KINDS = Object.freeze({ GUEST_OTP: 'GUEST_OTP', RECIPIENT_CODE: 'RECIPIENT_CODE', RECIPIENT_CODE_REISSUED: 'RECIPIENT_CODE_REISSUED', GUEST_TRACKING: 'GUEST_TRACKING' });
// M16.2.1: RECIPIENT_CODE_REISSUED is queued by an Admin ROTATION; its text says the earlier code no longer works.
const RECIPIENT_KINDS = Object.freeze([KINDS.RECIPIENT_CODE, KINDS.RECIPIENT_CODE_REISSUED]);
const DELIVERY_KINDS = Object.freeze([KINDS.RECIPIENT_CODE, KINDS.RECIPIENT_CODE_REISSUED, KINDS.GUEST_TRACKING]);
const isDeliveryKind = (k) => DELIVERY_KINDS.includes(k);
/** Delivery notifications have their OWN switch: it never turns guest email OTP on or off (guide §4). */
const deliveryEnabled = (env = process.env) => String(env.EMAIL_DELIVERY_NOTIFICATIONS_ENABLED).toLowerCase() === 'true';
const senderTrackingEnabled = (env = process.env) => String(env.SENDER_TRACKING_EMAIL_ENABLED).toLowerCase() === 'true';
const kindEnabled = (kind, env = process.env) => (isDeliveryKind(kind) ? deliveryEnabled(env) : truthy(env.GUEST_EMAIL_OTP_ENABLED));
const MAX_ATTEMPTS = Number(process.env.EMAIL_OUTBOX_MAX_ATTEMPTS) || 6;
const STALE_PROCESSING_MS = 5 * 60 * 1000;
const SCRUB_DEAD_DAYS = 14;
const CAP_RETRY_MS = 5 * 60 * 1000;               // nothing free to send with: look again later (does not use up attempts)
const UNHEALTHY_MS = { TRANSIENT: 60 * 1000, AUTH: 30 * 60 * 1000 };
const backoffMs = (attempts) => Math.min(30000 * 2 ** Math.max(attempts - 1, 0), 30 * 60 * 1000);
const truthy = (v) => String(v || '').toLowerCase() === 'true';
const maskEmail = (e) => { const [l = '', d = ''] = String(e || '').split('@'); return d ? `${l.slice(0, 1)}${'*'.repeat(Math.max(1, Math.min(l.length - 1, 6)))}@${d}` : '****'; };

/** Call INSIDE the challenge transaction. */
async function enqueueOtpTx(tx, { otpId, email }) {
  return tx.emailOutbox.create({ data: { kind: KINDS.GUEST_OTP, otpId, toEmail: email, toMasked: maskEmail(email) } });
}

/** Call INSIDE the booking transaction (same transaction as the delivery and its code hash). */
async function enqueueDeliveryTx(tx, { kind, bookingId, email }) {
  if (!isDeliveryKind(kind)) throw new Error(`unknown delivery email kind ${kind}`);
  return tx.emailOutbox.create({ data: { kind, bookingId, toEmail: email, toMasked: maskEmail(email) } });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Subject + bodies for the verification email. The code is prominent, expiry is stated, and the reader is told never to share it. */
function otpMessage(code, minutes) {
  const subject = 'Your Runserv verification code';
  const text = `Your Runserv verification code is ${code}.\n\nIt expires in ${minutes} minutes. Do not share this code with anyone: Runserv support will never ask you for it.\n\nIf you did not request this, you can ignore this email.`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#111">
<table role="presentation" width="100%" style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:24px"><tr><td>
<p style="margin:0 0 12px;font-size:16px">Your Runserv verification code is</p>
<p style="margin:0 0 16px;font-size:34px;font-weight:700;letter-spacing:8px">${esc(code)}</p>
<p style="margin:0 0 12px;font-size:14px;color:#444">It expires in ${esc(minutes)} minutes. Do not share this code with anyone. Runserv support will never ask you for it.</p>
<p style="margin:0;font-size:12px;color:#777">If you did not request this, you can ignore this email.</p></td></tr></table></body></html>`;
  return { subject, text, html };
}

const shell = (inner) => `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#111">
<table role="presentation" width="100%" style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:24px"><tr><td>${inner}</td></tr></table></body></html>`;

const fmtUtc = (d) => `${new Date(d).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
/** Recipient email: the hand-over code AND the tracking link (when the link is still live). The link carries no code. `reissued` = an Admin rotated the code. */
function recipientCodeMessage({ code, reference, trackingUrl, reissued = false, expiresAt = null }) {
  const subject = reissued ? `New hand-over code for your Runserv parcel (ref ${reference})` : `A Runserv parcel is on its way to you (ref ${reference})`;
  const lead = reissued ? `Your Runserv hand-over code for the parcel (ref ${reference}) has been replaced. Any code you received earlier no longer works.` : `A Runserv parcel is on its way to you (ref ${reference}).`;
  const validity = expiresAt ? `This code is valid until ${fmtUtc(expiresAt)}.` : '';
  const text = `${lead}\n\nYour hand-over code is ${code}.\n${validity ? `\n${validity}\n` : ''}\nGive this code to the courier ONLY when you have the parcel in your hands. Never share it before, and never with anyone else: Runserv support will never ask you for it.${trackingUrl ? `\n\nFollow the delivery here: ${trackingUrl}` : ''}\n\nIf you were not expecting a parcel, you can ignore this email.`;
  const html = shell(`<p style="margin:0 0 12px;font-size:16px">${esc(lead)}</p>
<p style="margin:0 0 4px;font-size:14px;color:#444">Your hand-over code</p>
<p style="margin:0 0 16px;font-size:34px;font-weight:700;letter-spacing:8px">${esc(code)}</p>
${validity ? `<p style="margin:0 0 12px;font-size:13px;color:#444">${esc(validity)}</p>` : ''}<p style="margin:0 0 12px;font-size:14px;color:#444">Give this code to the courier <b>only when you have the parcel in your hands</b>. Never share it before, and never with anyone else. Runserv support will never ask you for it.</p>
${trackingUrl ? `<p style="margin:0 0 12px;font-size:14px"><a href="${esc(trackingUrl)}">Follow the delivery</a></p>` : ''}
<p style="margin:0;font-size:12px;color:#777">If you were not expecting a parcel, you can ignore this email.</p>`);
  return { subject, text, html };
}

/** Sender email: the tracking link only. Never a code. */
function senderTrackingMessage({ reference, trackingUrl }) {
  const subject = `Track your Runserv booking ${reference}`;
  const text = `Your Runserv booking ${reference} is confirmed.\n\nTrack it here: ${trackingUrl}\n\nAnyone with this link can follow the booking, so share it only with people you trust.`;
  const html = shell(`<p style="margin:0 0 12px;font-size:16px">Your Runserv booking <b>${esc(reference)}</b> is confirmed.</p>
<p style="margin:0 0 12px;font-size:14px"><a href="${esc(trackingUrl)}">Track your booking</a></p>
<p style="margin:0;font-size:12px;color:#777">Anyone with this link can follow the booking, so share it only with people you trust.</p>`);
  return { subject, text, html };
}

/** Booking-based kinds. Returns null when sending would be wrong (cancelled, already handed over, failed, or tracking link gone). */
async function renderDelivery(row, env, now) {
  const gb = require('./guestBooking.service');
  const b = await prisma.guestBooking.findUnique({ where: { id: row.bookingId } });
  if (!b) return null;
  const linkLive = !b.trackingRevokedAt && now < new Date(b.trackingExpiresAt).getTime();
  let trackingUrl = null;
  if (linkLive) {
    trackingUrl = gb.trackingUrl(gb.deriveTrackingToken(b.id, b.trackingNonce, env), env);
    if (!/^https?:\/\//.test(trackingUrl)) throw Object.assign(new Error('GUEST_TRACKING_BASE_URL is not an absolute URL'), { category: 'CONFIG' });
  }
  if (row.kind === KINDS.GUEST_TRACKING) return trackingUrl ? senderTrackingMessage({ reference: b.reference, trackingUrl }) : null;
  if (!b.deliveryId) return null;
  const d = await prisma.delivery.findUnique({ where: { id: b.deliveryId } });
  if (!d || d.status === 'CANCELLED' || d.podVerifiedAt || d.failedAt) return null;
  const pc = require('./podCode.service');
  if (pc.isExpired(d, now)) return null;                       // an expired code is never sent: Admin rotates it (a NEW code) instead
  return recipientCodeMessage({ code: pc.codeFor(d, env), reference: b.reference, trackingUrl, reissued: row.kind === KINDS.RECIPIENT_CODE_REISSUED, expiresAt: d.podCodeExpiresAt });
}

/** Build the message from the challenge / booking at send time. Returns null when sending would be wrong. */
async function render(row, env = process.env, now = Date.now()) {
  if (isDeliveryKind(row.kind)) return renderDelivery(row, env, now);
  const identity = require('./guestIdentity.service');
  const otp = row.otpId ? await prisma.guestOtp.findUnique({ where: { id: row.otpId } }) : null;
  if (!otp || otp.consumedAt || otp.supersededAt || now >= new Date(otp.expiresAt).getTime()) return null;
  const minutes = Math.max(1, Math.round((new Date(otp.expiresAt).getTime() - new Date(otp.createdAt).getTime()) / 60000));
  return otpMessage(identity.deriveEmailCode(otp, env), minutes);
}

/** Audit for booking-based kinds only. Carries the kind, provider and a category: never the code, the token, the address or the message text. */
async function auditDelivery(row, event, meta = {}) {
  if (!isDeliveryKind(row.kind) || !row.bookingId) return;
  await require('./guestIdentity.service').audit(event, { bookingId: row.bookingId, meta: { kind: row.kind, outboxId: row.id, ...meta } });
}

const bump = (provider, key, ms, now) => quota.markUnhealthy(provider, key, ms, now).catch(() => {});

/** Claim and send one row. Safe to call concurrently: the claim is a conditional update. */
async function processEvent(id, { now = new Date(), env = process.env, http = undefined } = {}) {
  const claim = await prisma.emailOutbox.updateMany({
    where: { id, OR: [{ status: 'PENDING', nextAttemptAt: { lte: now } }, { status: 'PROCESSING', updatedAt: { lt: new Date(now.getTime() - STALE_PROCESSING_MS) } }] },
    data: { status: 'PROCESSING', attempts: { increment: 1 } },
  });
  if (claim.count !== 1) return { skipped: true };
  const row = await prisma.emailOutbox.findUnique({ where: { id } });
  const settle = (data) => prisma.emailOutbox.update({ where: { id }, data });
  let held = null;   // { provider, key } while we own a slot that has not been resolved
  try {
    if (!kindEnabled(row.kind, env)) { await settle({ status: 'SKIPPED', toEmail: null, slotHeld: false, lastError: isDeliveryKind(row.kind) ? 'Email delivery notifications are switched off' : 'Email OTP is switched off' }); return { skipped: true }; }
    const message = await render(row, env, now.getTime());
    if (message == null) { await settle({ status: 'SKIPPED', toEmail: null, slotHeld: false, lastError: 'No longer needed (code used, expired, cancelled or completed)' }); return { skipped: true }; }
    if (!row.toEmail) throw Object.assign(new Error('No destination address'), { category: 'CONFIG' });

    // Where does it go? A job that already owns a slot (ambiguous timeout) stays with that provider; otherwise route by quota.
    let target;
    if (row.slotHeld && row.provider) target = { provider: row.provider, key: quota.windowKey(now.getTime(), env), reason: row.routeReason };
    else {
      target = await quota.route({ now: now.getTime(), env });
      if (target.none) {   // nothing free: stay queued, visibly, without spending an attempt
        await settle({ status: 'PENDING', attempts: Math.max(0, row.attempts - 1), nextAttemptAt: new Date(now.getTime() + CAP_RETRY_MS), errorCategory: 'CAP', lastError: `No free email capacity right now (${target.reason})` });
        return { queued: true, reason: target.reason };
      }
      await settle({ provider: target.provider, routeReason: target.reason, slotHeld: true });
    }
    held = { provider: target.provider, key: target.key };

    const sent = await providers.sendTransactionalEmail(target.provider, { to: row.toEmail, ...message, idempotencyKey: row.id }, { env, ...(http ? { http } : {}) });
    await quota.markAccepted(target.provider, target.key);
    held = null;
    await settle({ status: 'SENT', sentAt: new Date(), toEmail: null, slotHeld: false, providerMessageId: sent.messageId, deliveryStatus: 'ACCEPTED', errorCategory: null, lastError: null });
    await auditDelivery(row, 'EMAIL_ACCEPTED', { provider: target.provider });
    return { done: true, provider: target.provider };
  } catch (e) {
    const cat = e.category || 'TRANSIENT';
    const msg = String(e.message || e).slice(0, 300);
    const exhausted = row.attempts >= MAX_ATTEMPTS;
    const dead = (extra = {}) => settle({ status: 'DEAD', lastError: msg, errorCategory: cat, slotHeld: false, ...extra }).then(async () => { console.error('[email-outbox] dead-lettered', row.kind, cat); await auditDelivery(row, 'EMAIL_FAILED', { category: cat }); await auditDelivery(row, 'NOTIFICATION_DEAD_LETTERED', { category: cat }); return { dead: true }; });
    const retry = (extra = {}, ms = backoffMs(row.attempts)) => settle({ status: 'PENDING', lastError: msg, errorCategory: cat, nextAttemptAt: new Date(now.getTime() + ms), ...extra }).then(() => ({ retry: true }));
    if (cat === 'TIMEOUT' && held) return exhausted ? dead() : retry({ slotHeld: true });   // ambiguous: keep the slot and the provider; the same code is re-sent at most
    if (held) await quota.release(held.provider, held.key).catch(() => {});                 // certainly not accepted: slot goes back
    if (cat === 'INVALID_ADDRESS') return dead();                                            // permanent: no retry, no failover
    if (cat === 'QUOTA') {                                                                    // the provider itself said so: park it, route elsewhere, not the job's fault
      if (held) await quota.markExhausted(held.provider, held.key);
      return retry({ slotHeld: false, provider: null, attempts: Math.max(0, row.attempts - 1) }, 1000);
    }
    if (cat === 'AUTH' || cat === 'TRANSIENT') { if (held) await bump(held.provider, held.key, UNHEALTHY_MS[cat], now.getTime()); return exhausted ? dead() : retry({ slotHeld: false, provider: null }); }
    return exhausted ? dead() : retry({ slotHeld: false, provider: null });                  // CONFIG / unknown
  }
}

/** Immediate best-effort send right after the challenge commits; the worker retries anything that fails. */
async function processForOtp(otpId, opts = {}) {
  const rows = await prisma.emailOutbox.findMany({ where: { otpId, status: 'PENDING' } });
  const out = [];
  for (const r of rows) out.push(await processEvent(r.id, opts));
  return out;
}

/** Immediate best-effort send right after the booking commits; the worker retries anything that fails. */
async function processForBooking(bookingId, opts = {}) {
  const rows = await prisma.emailOutbox.findMany({ where: { bookingId, status: 'PENDING' } });
  const out = [];
  for (const r of rows) out.push(await processEvent(r.id, opts));
  return out;
}

const DUE = (now) => ({ OR: [{ status: 'PENDING', nextAttemptAt: { lte: now } }, { status: 'PROCESSING', updatedAt: { lt: new Date(now.getTime() - STALE_PROCESSING_MS) } }] });

async function processDue({ limit = 25, now = new Date(), env = process.env, http } = {}) {
  const due = await prisma.emailOutbox.findMany({ where: DUE(now), orderBy: { createdAt: 'asc' }, take: limit });
  const r = { processed: 0, sent: 0, retry: 0, dead: 0, skipped: 0, queued: 0 };
  for (const { id } of due) {
    const o = await processEvent(id, { now, env, http });
    if (o.skipped) { r.skipped += 1; continue; }
    if (o.queued) { r.queued += 1; continue; }
    r.processed += 1; if (o.done) r.sent += 1; if (o.retry) r.retry += 1; if (o.dead) r.dead += 1;
  }
  return r;
}

async function scrubDead({ now = new Date() } = {}) {
  const r = await prisma.emailOutbox.updateMany({ where: { status: 'DEAD', toEmail: { not: null }, updatedAt: { lt: new Date(now.getTime() - SCRUB_DEAD_DAYS * 86400000) } }, data: { toEmail: null } });
  return r.count;
}

/** Admin: put a DEAD row back in the queue. Never reveals or regenerates the code; refuses when the challenge is no longer usable. */
async function requeue(id, { now = new Date() } = {}) {
  const fail = (msg, code) => { const e = new Error(msg); e.statusCode = code; throw e; };
  const row = await prisma.emailOutbox.findUnique({ where: { id } });
  if (!row) fail('Message not found', 404);
  if (row.status !== 'DEAD') fail('Only failed messages can be re-queued.', 409);
  if (row.errorCategory === 'INVALID_ADDRESS') fail('This address was rejected as invalid. Ask the guest to correct it and request a new code.', 409);
  if (!row.toEmail) fail('The address is no longer stored, so this message cannot be re-sent. Ask the guest to request a new code.', 409);
  if (isDeliveryKind(row.kind)) {
    // Re-sends the SAME active code (never rotates it). Refused when the delivery no longer needs it.
    if (!await render(row, process.env, now.getTime()).catch(() => 'x')) fail('This delivery no longer needs this message (cancelled, handed over, failed or the link was turned off).', 409);
  } else {
    const otp = row.otpId ? await prisma.guestOtp.findUnique({ where: { id: row.otpId } }) : null;
    if (!otp || otp.consumedAt || otp.supersededAt || now.getTime() >= new Date(otp.expiresAt).getTime()) fail('The verification code has expired or was replaced. Ask the guest to request a new one.', 409);
  }
  const r = await prisma.emailOutbox.updateMany({ where: { id, status: 'DEAD' }, data: { status: 'PENDING', attempts: 0, nextAttemptAt: now, lastError: null, errorCategory: null, slotHeld: false, provider: null } });
  if (r.count === 1) await auditDelivery(row, 'NOTIFICATION_RETRIED', { by: 'ADMIN' });
  return { requeued: r.count === 1 };
}

/** Truthful state of ONE row: QUEUED | RETRYING | ACCEPTED | DELIVERED | FAILED | SKIPPED. Accepted by a provider is not delivered. */
function rowState(row) {
  if (!row) return null;
  if (row.status === 'SENT') return row.deliveryStatus === 'DELIVERED' ? 'DELIVERED' : (['HARD_BOUNCE', 'BLOCKED'].includes(row.deliveryStatus) ? 'FAILED' : 'ACCEPTED');
  if (row.status === 'DEAD') return 'FAILED';
  if (row.status === 'SKIPPED') return 'SKIPPED';
  return row.attempts > 0 || row.lastError ? 'RETRYING' : 'QUEUED';
}

/** The newest row of a kind for a booking (a resend adds a newer row; the older one stays as history). */
const latestForBooking = (bookingId, kind) => prisma.emailOutbox.findFirst({ where: { bookingId, kind: Array.isArray(kind) ? { in: kind } : kind }, orderBy: { createdAt: 'desc' } });

/** What the guest's own app may learn about a challenge's email: a truthful state, nothing else. */
async function stateForOtp(otpId) {
  const row = await prisma.emailOutbox.findFirst({ where: { otpId }, orderBy: { createdAt: 'desc' } });
  if (!row) return null;
  if (row.status === 'SENT') return row.deliveryStatus === 'DELIVERED' ? 'DELIVERED' : (['HARD_BOUNCE', 'BLOCKED'].includes(row.deliveryStatus) ? 'FAILED' : 'ACCEPTED');
  if (row.status === 'DEAD') return 'FAILED';
  return 'QUEUED';
}

async function stats(now = new Date(), env = process.env) {
  const [pending, dead, oldest, u, recipientDead] = await Promise.all([
    prisma.emailOutbox.count({ where: { status: 'PENDING' } }), prisma.emailOutbox.count({ where: { status: 'DEAD' } }),
    prisma.emailOutbox.findFirst({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' } }), quota.usage({ now: now.getTime(), env }),
    prisma.emailOutbox.count({ where: { status: 'DEAD', kind: { in: RECIPIENT_KINDS } } }),
  ]);
  const oldestAgeSeconds = oldest ? Math.floor((now.getTime() - new Date(oldest.createdAt).getTime()) / 1000) : 0;
  const alerts = [];
  if (dead > 0) alerts.push(`${dead} email(s) failed permanently and need attention`);
  if (recipientDead > 0) alerts.push(`${recipientDead} recipient hand-over email(s) failed: those parcels cannot be handed over until support resends or rotates the code`);
  if (oldestAgeSeconds > 900) alerts.push(`Oldest queued email is ${Math.round(oldestAgeSeconds / 60)} minutes old`);
  for (const p of u.providers) {
    if (p.allocation && p.reserved >= p.allocation) alerts.push(`${p.provider} has used 100% of today's allocation (${p.allocation})`);
    else if (p.allocation && p.percentUsed >= 80) alerts.push(`${p.provider} has used ${p.percentUsed}% of today's allocation`);
  }
  if (u.activeTier === 'resend') alerts.push('Resend is now the active email tier');
  return { pending, dead, oldestAgeSeconds, alerts, usage: u };
}

// ── Delivery events (webhooks) ───────────────────────────────────────────────────────────────────────────────────
const RANK = { ACCEPTED: 0, SOFT_BOUNCE: 1, DELIVERED: 2, ERROR: 2, BLOCKED: 3, HARD_BOUNCE: 3 };
const BREVO_EVENTS = { delivered: 'DELIVERED', soft_bounce: 'SOFT_BOUNCE', deferred: 'SOFT_BOUNCE', hard_bounce: 'HARD_BOUNCE', invalid_email: 'HARD_BOUNCE', invalid: 'HARD_BOUNCE', blocked: 'BLOCKED', spam: 'BLOCKED', error: 'ERROR' };
const RESEND_EVENTS = { 'email.delivered': 'DELIVERED', 'email.delivery_delayed': 'SOFT_BOUNCE', 'email.bounced': 'HARD_BOUNCE', 'email.complained': 'BLOCKED', 'email.failed': 'ERROR' };

/** Normalise a provider webhook body to { eventKey, messageId, status } or null for events we do not track. */
function normaliseWebhook(provider, body, headers = {}) {
  if (provider === 'brevo') {
    const status = BREVO_EVENTS[String(body?.event || '').toLowerCase()];
    const messageId = body?.['message-id'] || body?.messageId; if (!status || !messageId) return null;
    return { status, messageId: String(messageId), eventKey: `${messageId}:${body.event}:${body.ts_event || body.ts || body.date || ''}`, event: String(body.event) };
  }
  let status = RESEND_EVENTS[body?.type];
  if (body?.type === 'email.bounced' && /transient/i.test(String(body?.data?.bounce?.type || ''))) status = 'SOFT_BOUNCE';
  const messageId = body?.data?.email_id; if (!status || !messageId) return null;
  return { status, messageId: String(messageId), eventKey: String(headers['svix-id'] || `${messageId}:${body.type}:${body.created_at || ''}`), event: String(body.type) };
}

/** Idempotent: the same event twice changes nothing; an older state never overwrites a newer one. Never touches quota counters. */
async function applyDeliveryEvent(provider, ev) {
  try { await prisma.emailWebhookEvent.create({ data: { provider, eventKey: ev.eventKey, messageId: ev.messageId, event: ev.event } }); }
  catch (e) { if (e?.code === 'P2002') return { duplicate: true }; throw e; }
  const row = await prisma.emailOutbox.findFirst({ where: { providerMessageId: ev.messageId } });
  if (!row) return { unknownMessage: true };
  if ((RANK[ev.status] ?? 0) <= (RANK[row.deliveryStatus] ?? -1)) return { ignored: true };
  await prisma.emailOutbox.update({ where: { id: row.id }, data: { deliveryStatus: ev.status, deliveryAt: new Date(), ...(['HARD_BOUNCE', 'BLOCKED'].includes(ev.status) ? { errorCategory: ev.status === 'HARD_BOUNCE' ? 'INVALID_ADDRESS' : 'BLOCKED' } : {}) } });
  return { updated: true };
}

let timer = null;
const startWorker = ({ intervalMs = 15000 } = {}) => {
  if (timer || process.env.EMAIL_OUTBOX_WORKER === 'off') return null;
  let busy = false; let ticks = 0;
  timer = setInterval(async () => {
    if (busy) return; busy = true;
    try { await processDue(); if (++ticks % 240 === 0) await scrubDead(); } catch (e) { console.error('[email-outbox] worker error:', e.message); } finally { busy = false; }
  }, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
};
const stopWorker = () => { if (timer) { clearInterval(timer); timer = null; } };

module.exports = { KINDS, RECIPIENT_KINDS, DELIVERY_KINDS, isDeliveryKind, deliveryEnabled, senderTrackingEnabled, kindEnabled, enqueueDeliveryTx, recipientCodeMessage, senderTrackingMessage, processForBooking, rowState, latestForBooking, MAX_ATTEMPTS, SCRUB_DEAD_DAYS, backoffMs, maskEmail, otpMessage, enqueueOtpTx, render, processEvent, processForOtp, processDue, scrubDead, requeue, stateForOtp, stats, normaliseWebhook, applyDeliveryEvent, startWorker, stopWorker };
