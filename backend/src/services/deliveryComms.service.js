// backend/src/services/deliveryComms.service.js
//
// M16.2: recipient hand-over code + tracking link as FIRST-CLASS delivery communications (guide: "Recipient Hand-over Code & Delivery
// Communications"). Orchestrates the two outboxes; it does not own a lifecycle for the code itself (proofOfDelivery / guestBooking do).
//
//   * Channels are independent: EMAIL_DELIVERY_NOTIFICATIONS_ENABLED and SMS_DELIVERY_NOTIFICATIONS_ENABLED. A success on one channel never
//     suppresses the other; a disabled channel is reported as DISABLED, never as failed.
//   * The jobs are written in the booking transaction (enqueueBookingTx), so a parcel can never exist without its notifications queued.
//   * Statuses here describe NOTIFICATIONS. A sent notification is never a delivered parcel, and nothing here exposes the code.
//   * M16.2.1: RESEND re-sends the SAME active code (refused once it has expired or locked); ROTATE is a separate, audited Admin action that atomically
//     replaces the code (podCode.service) and tells the recipient the earlier one no longer works. Both reserve their cooldown with ONE conditional UPDATE.
//   * M16.2.2 (Option B): the same resend / rotate / status work for a REGISTERED customer's parcel (no guest booking): pass `delivery` instead of `booking`. Its
//     email rows point at the delivery (EmailOutbox.deliveryId) and carry the code only (registered accounts have no public tracking link). Email channel only.
'use strict';
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const emailOutbox = require('./emailOutbox.service');
const smsOutbox = require('./smsOutbox.service');
const identity = require('./guestIdentity.service');
const podCode = require('./podCode.service');

const pod = () => require('./proofOfDelivery.service');     // lazy: proofOfDelivery imports guestBooking, which imports this module
const err = (message, status, code, extra = {}) => Object.assign(new AppError(message, status), { code, ...extra });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Which delivery channels are switched on, each on its own flag. */
const channels = (env = process.env) => ({ email: emailOutbox.deliveryEnabled(env), sms: smsOutbox.enabled(env) });

/** Lower-cased, trimmed address or null. Throws a coded error when something was typed but is not an address. */
function parseRecipientEmail(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return null;
  if (v.length > 254 || !EMAIL_RE.test(v) || v.endsWith('.invalid')) throw err('Enter a valid recipient email address.', 400, 'RECIPIENT_EMAIL_INVALID');
  return v;
}

/** Pilot rule (guide §4/§17): while SMS is off and email is on, the recipient's email is mandatory: otherwise the code could not reach them. */
const recipientEmailRequired = (env = process.env) => { const c = channels(env); return c.email && !c.sms; };

/**
 * The sender does NOT see the code in the app once the RECIPIENT's email carries it (guide §2: the code goes to the recipient, not
 * automatically to the booker). Legacy SMS-only deployments keep showing it (the M16 decision). POD_CODE_SENDER_VISIBLE=true restores
 * sender visibility everywhere, deliberately.
 */
function senderMayViewCode({ recipientEmail }, env = process.env) {
  if (String(env.POD_CODE_SENDER_VISIBLE).toLowerCase() === 'true') return true;
  return !(channels(env).email && !!recipientEmail);
}

/**
 * Call INSIDE the booking transaction. Returns what was queued, e.g. { recipientEmail: true, senderEmail: false }.
 * A channel that is off, or has no contact, queues nothing: its state is derived later as DISABLED / NOT_PROVIDED.
 */
async function enqueueBookingTx(tx, { bookingId, service, guest, parcel, countryCode, env = process.env }) {
  const c = channels(env);
  const out = { recipientEmail: false, senderEmail: false, recipientSms: false, senderSms: false };
  if (c.email && service === 'PARCEL' && parcel?.recipientEmail) { await emailOutbox.enqueueDeliveryTx(tx, { kind: emailOutbox.KINDS.RECIPIENT_CODE, bookingId, email: parcel.recipientEmail }); out.recipientEmail = true; }
  if (c.email && emailOutbox.senderTrackingEnabled(env) && guest?.email) { await emailOutbox.enqueueDeliveryTx(tx, { kind: emailOutbox.KINDS.GUEST_TRACKING, bookingId, email: guest.email }); out.senderEmail = true; }
  // SMS (off in the pilot). An email-only guest has no phone: never queue a number that cannot exist.
  if (c.sms && guest?.phone) { await smsOutbox.enqueueTx(tx, { kind: 'GUEST_TRACKING', bookingId, phone: guest.phone, countryCode, env }); out.senderSms = true; }
  if (c.sms && service === 'PARCEL' && parcel?.recipientPhone) { await smsOutbox.enqueueTx(tx, { kind: 'RECIPIENT_CODE', bookingId, phone: parcel.recipientPhone, countryCode, env }); out.recipientSms = true; }
  return out;
}

/** M16.2.2 (Option B): call INSIDE the registered parcel's transaction. Queues the recipient's code email when the email channel is on and an address was given. */
async function enqueueRegisteredTx(tx, { deliveryId, recipientEmail, env = process.env }) {
  if (!channels(env).email || !recipientEmail) return { recipientEmail: false };
  await emailOutbox.enqueueDeliveryTx(tx, { kind: emailOutbox.KINDS.RECIPIENT_CODE, deliveryId, email: recipientEmail });
  return { recipientEmail: true };
}

/** Best-effort immediate send after commit on both channels, independently: one failing never blocks the other. */
async function dispatchBooking(bookingId, opts = {}) {
  const results = await Promise.allSettled([emailOutbox.processForBooking(bookingId, opts), smsOutbox.processForBooking(bookingId, opts)]);
  results.forEach((r) => { if (r.status === 'rejected') console.error('[delivery-comms] immediate send failed:', r.reason?.message); });
}

/** One channel's truthful state: DISABLED | NOT_PROVIDED | QUEUED | RETRYING | ACCEPTED | DELIVERED | FAILED | SKIPPED. */
const smsState = (row) => (!row ? null : row.status === 'SENT' ? (row.deliveryStatus === 'DELIVERED' ? 'DELIVERED' : row.deliveryStatus === 'FAILED' ? 'FAILED' : 'ACCEPTED') : row.status === 'DEAD' ? 'FAILED' : row.status === 'SKIPPED' ? 'SKIPPED' : (row.attempts > 0 || row.lastError ? 'RETRYING' : 'QUEUED'));

/**
 * Per-channel status of the RECIPIENT notification. Safe for Admin: masked contacts, states, provider and message reference.
 * `overall`: OK (some channel got it to a provider), PENDING (still in flight), UNRESOLVED (every enabled channel failed or none could be tried).
 */
async function recipientStatus({ booking = null, delivery, env = process.env }) {
  const c = channels(env);
  const registered = !booking;      // M16.2.2: a registered customer's parcel: its outbox rows (email AND, since WP-07, SMS) point at the delivery
  const [emailRow, smsRow] = await Promise.all([
    registered ? emailOutbox.latestForDelivery(delivery.id, emailOutbox.RECIPIENT_KINDS) : emailOutbox.latestForBooking(booking.id, emailOutbox.RECIPIENT_KINDS),
    c.sms ? prisma.smsOutbox.findFirst({ where: registered ? { deliveryId: delivery.id, kind: 'RECIPIENT_CODE' } : { bookingId: booking.id, kind: 'RECIPIENT_CODE' } }) : null,
  ]);
  const email = { enabled: c.email, contact: delivery?.recipientEmail ? emailOutbox.maskEmail(delivery.recipientEmail) : null };
  email.state = !c.email ? 'DISABLED' : (!delivery?.recipientEmail ? 'NOT_PROVIDED' : (emailOutbox.rowState(emailRow) || 'NOT_QUEUED'));
  if (emailRow) Object.assign(email, { provider: emailRow.provider, providerMessageId: emailRow.providerMessageId, attempts: emailRow.attempts, errorCategory: emailRow.errorCategory, lastError: emailRow.lastError, deliveryStatus: emailRow.deliveryStatus, sentAt: emailRow.sentAt, createdAt: emailRow.createdAt });
  const sms = { enabled: c.sms, contact: delivery?.dropoffContact ? identity.maskPhone(String(delivery.dropoffContact)) : null };
  sms.state = !c.sms ? 'DISABLED' : (!delivery?.dropoffContact ? 'NOT_PROVIDED' : (smsState(smsRow) || 'NOT_QUEUED'));
  if (smsRow) Object.assign(sms, { provider: smsRow.provider ?? null, providerMessageId: smsRow.providerMessageId ?? null, deliveryStatus: smsRow.deliveryStatus ?? null, attempts: smsRow.attempts, lastError: smsRow.lastError, sentAt: smsRow.sentAt, createdAt: smsRow.createdAt });
  const live = [email, sms].filter((x) => x.enabled && !['NOT_PROVIDED'].includes(x.state));   // WP-07: every enabled channel is persisted and tracked; a channel with no contact cannot confirm or fail
  const ok = live.some((x) => ['ACCEPTED', 'DELIVERED'].includes(x.state));
  const inFlight = live.some((x) => ['QUEUED', 'RETRYING'].includes(x.state));
  const overall = ok ? 'OK' : (inFlight ? 'PENDING' : 'UNRESOLVED');
  const code = podCode.lifecycleView(delivery, Date.now(), pod().MAX_POD_ATTEMPTS);
  // What support should do next. Nothing for a finished parcel; ROTATE when the active code can no longer work; RESEND when it is fine but unconfirmed.
  const open = !!delivery?.podCodeHash && !delivery?.podVerifiedAt && !delivery?.failedAt && delivery?.status !== 'CANCELLED';
  const recovery = !open ? null : (['EXPIRED', 'LOCKED'].includes(code.state) ? 'ROTATE' : (overall === 'UNRESOLVED' ? 'RESEND' : null));
  return { source: registered ? 'REGISTERED' : 'GUEST', email, sms, overall, partial: ok && live.some((x) => x.state === 'FAILED'), code, recovery, needsAttention: !!recovery };
}

/** What the SENDER's own screen may learn: states only, never an address, number, provider or code. */
async function senderNotices({ booking, delivery, env = process.env }) {
  const s = await recipientStatus({ booking, delivery, env });
  return { recipientEmail: s.email.state, recipientSms: s.sms.state, recipientOverall: s.overall };
}

const cooldownMs = (env = process.env) => { const n = env.RECIPIENT_RESEND_COOLDOWN_SECONDS === undefined || env.RECIPIENT_RESEND_COOLDOWN_SECONDS === '' ? 120 : Number(env.RECIPIENT_RESEND_COOLDOWN_SECONDS); return (Number.isFinite(n) && n >= 0 ? n : 120) * 1000; };

/** Guard shared by resend and rotate: the delivery must still need its code. Returns the delivery row. */
async function loadOpenDelivery(booking, deliveryId = null) {
  if (!booking) { if (!deliveryId) throw err('This delivery has no recipient hand-over code.', 400, 'NOT_A_PARCEL'); }
  else if (booking.service !== 'PARCEL' || !booking.deliveryId) throw err('This booking has no recipient hand-over code.', 400, 'NOT_A_PARCEL');
  const d = await prisma.delivery.findUnique({ where: { id: booking ? booking.deliveryId : deliveryId } });
  if (!d || !d.podCodeHash) throw err('This delivery does not use a hand-over code.', 400, 'POD_NOT_REQUIRED');
  if (d.status === 'CANCELLED' || d.podVerifiedAt || d.failedAt) throw err('This delivery no longer needs its hand-over code.', 409, 'NOT_RESENDABLE');
  return d;
}

/** Eligible-for-notification state of a delivery inside the reservation UPDATE (same facts loadOpenDelivery checks, now enforced by the database). */
const openWhere = (d) => ({ id: d.id, podCodeHash: d.podCodeHash, podVerifiedAt: null, failedAt: null, status: { not: 'CANCELLED' } });
const cooldownWhere = (now, env) => ({ OR: [{ podNotifyReservedAt: null }, { podNotifyReservedAt: { lte: new Date(now - cooldownMs(env)) } }] });

/** The cooldown is a conditional UPDATE on the delivery row, so at most ONE concurrent request wins; the others get 429 (or 409 when the code changed). */
async function reserve(tx, d, { now, env, extra = {} }) {
  const won = await tx.delivery.updateMany({ where: { ...openWhere(d), AND: [cooldownWhere(now, env)] }, data: { podNotifyReservedAt: new Date(now), ...extra } });
  if (won.count === 1) return;
  const cur = await tx.delivery.findUnique({ where: { id: d.id } });
  if (!cur || cur.podCodeHash !== d.podCodeHash) throw err('The hand-over code changed while you were working. Reload and try again.', 409, 'CONFLICT');
  if (cur.podVerifiedAt || cur.failedAt || cur.status === 'CANCELLED') throw err('This delivery no longer needs its hand-over code.', 409, 'NOT_RESENDABLE');
  const left = Math.max(1, Math.ceil((new Date(cur.podNotifyReservedAt).getTime() + cooldownMs(env) - now) / 1000));
  throw err('A notification was queued a moment ago. Please wait before resending.', 429, 'RESEND_COOLDOWN', { retryAfterS: left });
}

const usableChannels = (c, d) => ({ email: c.email && !!d.recipientEmail, sms: c.sms && !!d.dropoffContact });
/** Outbox rows of a booking point at the booking; rows of a registered parcel point at the delivery. */
const rowRef = (booking, d) => (booking ? { bookingId: booking.id } : { deliveryId: d.id });

/**
 * Admin RESEND: the SAME active code, through every enabled channel. Refused once the code has expired or locked (rotate instead). Cooldown reserved atomically
 * (see reserve). Permission, reason and audit are enforced by the route/controller. It never creates, rotates or reveals a code.
 */
async function resendRecipient({ booking = null, delivery = null, countryCode, adminId, ip, now = Date.now(), env = process.env }) {
  const d = await loadOpenDelivery(booking, delivery?.id);
  const st = podCode.stateOf(d, now, pod().MAX_POD_ATTEMPTS);
  if (st === 'EXPIRED') throw err('This hand-over code has expired. Rotate it to issue a new code.', 409, 'CODE_EXPIRED');
  if (st === 'LOCKED') throw err('This delivery is locked after too many wrong codes. Review it and rotate the code to issue a new one.', 409, 'CODE_LOCKED');
  const c = channels(env);
  if (!c.email && !c.sms) throw err('Delivery notifications are switched off for every channel.', 409, 'CHANNELS_DISABLED');
  const use = usableChannels(c, d);
  if (!use.email && !use.sms) throw err('There is no usable recipient contact for the enabled channel(s). Collect a valid recipient email or follow the approved manual process.', 409, 'NO_USABLE_CONTACT');
  const queued = { email: false, sms: false };
  await prisma.$transaction(async (tx) => {
    await reserve(tx, d, { now, env });          // the cooldown is decided first; a refusal below rolls the reservation back with the transaction
    const last = await tx.emailOutbox.findFirst({ where: { ...rowRef(booking, d), kind: { in: emailOutbox.RECIPIENT_KINDS } }, orderBy: { createdAt: 'desc' } });
    if (last && ['PENDING', 'PROCESSING'].includes(last.status)) throw err('The previous email is still being sent.', 409, 'ALREADY_QUEUED');
    if (use.email) { await tx.emailOutbox.create({ data: { kind: emailOutbox.KINDS.RECIPIENT_CODE, ...rowRef(booking, d), toEmail: d.recipientEmail, toMasked: emailOutbox.maskEmail(d.recipientEmail) } }); queued.email = true; }
  });
  if (use.sms) queued.sms = (await smsOutbox.resetForResend(booking?.id ?? null, { deliveryId: d.id, phone: d.dropoffContact, countryCode, env })).resent === true;
  await identity.audit('POD_CODE_RESENT', { bookingId: booking?.id ?? null, ip, meta: { adminId, deliveryId: d.id, codeVersion: d.podCodeVersion ?? 1, channels: Object.keys(queued).filter((k) => queued[k]) } });
  return { queued };
}

/**
 * Admin ROTATE (high risk, distinct from resend): a NEW code replaces the old one in ONE compare-and-swap UPDATE (WHERE names the old hash), so the old code
 * stops working at the instant the new one starts, the attempt counter restarts, and two concurrent rotations cannot both win. Queued-but-unsent recipient
 * emails are superseded; the recipient is told the earlier code no longer works. Never returns the code.
 */
async function rotateRecipient({ booking = null, delivery = null, countryCode, adminId, ip, reason, now = Date.now(), env = process.env }) {
  const d = await loadOpenDelivery(booking, delivery?.id);
  const c = channels(env);
  if (!c.email && !c.sms) throw err('Delivery notifications are switched off for every channel. A new code could not reach the recipient, so it was not issued.', 409, 'CHANNELS_DISABLED');
  const use = usableChannels(c, d);
  if (!use.email && !use.sms) throw err('There is no usable recipient contact for the enabled channel(s). A new code could not reach the recipient, so it was not issued.', 409, 'NO_USABLE_CONTACT');
  const next = podCode.generate(d.id, { now, env });
  const version = (d.podCodeVersion ?? 1) + 1;
  const queued = { email: false, sms: false };
  await prisma.$transaction(async (tx) => {
    await reserve(tx, d, { now, env, extra: { podCodeHash: next.hash, podCodeNonce: next.nonce, podCodeVersion: version, podCodeExpiresAt: next.expiresAt, podCodeRotatedAt: new Date(now), podCodeAttempts: 0 } });
    await tx.emailOutbox.updateMany({ where: { ...rowRef(booking, d), kind: { in: emailOutbox.RECIPIENT_KINDS }, status: 'PENDING' }, data: { status: 'SKIPPED', toEmail: null, lastError: 'Superseded by a newer hand-over code' } });
    if (use.email) { await tx.emailOutbox.create({ data: { kind: emailOutbox.KINDS.RECIPIENT_CODE_REISSUED, ...rowRef(booking, d), toEmail: d.recipientEmail, toMasked: emailOutbox.maskEmail(d.recipientEmail) } }); queued.email = true; }
  });
  if (use.sms) queued.sms = (await smsOutbox.resetForResend(booking?.id ?? null, { deliveryId: d.id, phone: d.dropoffContact, countryCode, env })).resent === true;
  await identity.audit('POD_CODE_ROTATED', { bookingId: booking?.id ?? null, ip, meta: { adminId, deliveryId: d.id, fromVersion: d.podCodeVersion ?? 1, toVersion: version, reason: String(reason || '').slice(0, 200), channels: Object.keys(queued).filter((k) => queued[k]), expiresAt: next.expiresAt } });
  await identity.audit('DELIVERY_NOTIFICATION_QUEUED', { bookingId: booking?.id ?? null, ip, meta: { deliveryId: d.id, channels: Object.keys(queued).filter((k) => queued[k]), reason: 'ROTATION' } });
  return { queued, version, expiresAt: next.expiresAt };
}

// ── Pilot scope (action plan P1.3) ────────────────────────────────────────────────────────────────────────────
/** PARCEL_PILOT_SCOPE: 'guest_only' (Option A, the recorded pilot decision) | 'guest_and_registered' (Option B, NOT built) | unset (legacy behaviour, unchanged). */
const pilotScope = (env = process.env) => { const v = String(env.PARCEL_PILOT_SCOPE || '').trim().toLowerCase(); return ['guest_only', 'guest_and_registered'].includes(v) ? v : null; };
/** Registered-customer parcel bookings are refused while the scope is guest_only: they would use the old SMS-only recipient path, a second undocumented behaviour. */
const registeredParcelsAllowed = (env = process.env) => pilotScope(env) !== 'guest_only';
/** Option B (M16.2.2): registered customers' parcels ride the same recipient EMAIL flow as guest parcels (code hashed + expiring, rotate/resend, ops alert). */
const registeredEmailFlow = (env = process.env) => pilotScope(env) === 'guest_and_registered';

// ── Pilot metrics (guide §16, action plan P2) from the outbox + audit tables ──────────────────────────────────────
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const median = (a) => { if (!a.length) return null; const x = [...a].sort((p, q) => p - q); const m = Math.floor(x.length / 2); return x.length % 2 ? x[m] : Math.round((x[m - 1] + x[m]) / 2); };

// WP-09: the caps are still there (bounded queries), but a hit is now REPORTED as `truncated` instead of silently under-counting.
const ROW_CAP = 5000;
const EVENT_CAP = 20000;
async function pilotMetrics({ sinceHours = 24 * 7, now = Date.now() } = {}) {
  const since = new Date(now - sinceHours * 3600 * 1000);
  let [emailRows, smsRows, events] = await Promise.all([
    prisma.emailOutbox.findMany({ where: { kind: { in: emailOutbox.RECIPIENT_KINDS }, createdAt: { gte: since } }, take: ROW_CAP + 1 }),
    prisma.smsOutbox.findMany({ where: { kind: 'RECIPIENT_CODE', createdAt: { gte: since } }, take: ROW_CAP + 1 }),
    prisma.guestAuditEvent.findMany({ where: { createdAt: { gte: since }, event: { in: ['POD_CODE_CREATED', 'POD_VERIFIED', 'POD_WRONG_CODE', 'POD_LOCKED', 'POD_CODE_EXPIRED', 'POD_CODE_RESENT', 'POD_CODE_ROTATED', 'MANUAL_HANDOVER_EXCEPTION_REQUESTED', 'MANUAL_HANDOVER_EXCEPTION_APPROVED', 'POD_OVERRIDE', 'TRACKING_VIEWED'] } }, take: EVENT_CAP + 1 }),
  ]);
  const truncated = { email: emailRows.length > ROW_CAP, sms: smsRows.length > ROW_CAP, events: events.length > EVENT_CAP };
  emailRows = emailRows.slice(0, ROW_CAP); smsRows = smsRows.slice(0, ROW_CAP); events = events.slice(0, EVENT_CAP);
  const channel = (rows, label) => {
    const by = (st) => rows.filter((r) => r.status === st).length;
    const sent = rows.filter((r) => r.status === 'SENT'); const resolved = sent.length + by('DEAD');
    const byProvider = {};
    rows.forEach((r) => { const k = r.provider || 'unassigned'; byProvider[k] = byProvider[k] || { total: 0, accepted: 0, deadLettered: 0 }; byProvider[k].total += 1; if (r.status === 'SENT') byProvider[k].accepted += 1; if (r.status === 'DEAD') byProvider[k].deadLettered += 1; });
    const delivered = sent.filter((r) => r.deliveryStatus === 'DELIVERED').length;
    const withReceipt = sent.filter((r) => r.deliveryStatus && r.deliveryStatus !== 'ACCEPTED').length;
    return { channel: label, total: rows.length, queued: by('PENDING') + by('PROCESSING'), accepted: sent.length, deadLettered: by('DEAD'), skipped: by('SKIPPED'), retried: rows.filter((r) => r.attempts > 1).length,
      acceptedRatePct: pct(sent.length, resolved), deliveryReceiptRatePct: label === 'email' ? pct(withReceipt, sent.length) : null, deliveredPct: label === 'email' ? pct(delivered, sent.length) : null,
      deadLetterRatePct: pct(by('DEAD'), resolved), medianSecondsToAcceptance: median(sent.filter((r) => r.sentAt).map((r) => Math.round((new Date(r.sentAt) - new Date(r.createdAt)) / 1000))), byProvider };
  };
  const n = (e) => events.filter((x) => x.event === e).length;
  const parcels = n('POD_CODE_CREATED'); const verified = n('POD_VERIFIED'); const locked = n('POD_LOCKED');
  const escalated = new Set(events.filter((x) => ['POD_CODE_RESENT', 'POD_CODE_ROTATED', 'MANUAL_HANDOVER_EXCEPTION_REQUESTED', 'POD_OVERRIDE'].includes(x.event)).map((x) => x.bookingId || x.meta?.deliveryId).filter(Boolean)).size;
  return { since, sinceHours, truncated, anyTruncated: truncated.email || truncated.sms || truncated.events, email: channel(emailRows, 'email'), sms: channel(smsRows, 'sms'),
    pod: { parcels, verified, wrongAttempts: n('POD_WRONG_CODE'), expiredAttempts: n('POD_CODE_EXPIRED'), lockouts: locked, lockoutRatePct: pct(locked, verified + locked), resends: n('POD_CODE_RESENT'), rotations: n('POD_CODE_ROTATED'), exceptionsRequested: n('MANUAL_HANDOVER_EXCEPTION_REQUESTED'), exceptionsApproved: n('MANUAL_HANDOVER_EXCEPTION_APPROVED') + n('POD_OVERRIDE') },
    escalation: { parcelsNeedingManualAction: escalated, ratePct: pct(escalated, parcels) },
    tracking: { views: n('TRACKING_VIEWED'), note: 'Counts the first view per link per 10 minutes (the audit is throttled), not every poll.' } };
}

/**
 * Best-effort immediate send for a registered parcel. Email (Option B) and, since WP-07, SMS go through their durable outboxes; each channel
 * is independent and anything that fails is retried by its worker.
 */
async function dispatchRegistered(deliveryId, opts = {}) {
  const r = await Promise.allSettled([emailOutbox.processForDelivery(deliveryId, opts), smsOutbox.processForDelivery(deliveryId, opts)]);
  r.forEach((x) => { if (x.status === 'rejected') console.error('[delivery-comms] immediate send failed:', x.reason?.message); });
}

/**
 * WP-07: queue the recipient-code SMS of a REGISTERED parcel in the durable SMS outbox (replaces the legacy direct send).
 * Disabled channel: nothing is queued or sent, and the status reads DISABLED. Returns the outbox row or null.
 */
async function enqueueRegisteredSms({ deliveryId, phone, countryCode, codeVersion = 1, env = process.env }) {
  if (!smsOutbox.enabled(env) || !phone) return null;
  return smsOutbox.enqueueForDelivery({ deliveryId, phone, countryCode, codeVersion, env });
}

/** Same-transaction variant: the SMS outbox row commits (or rolls back) together with the delivery, so a parcel never exists without its queued SMS. */
async function enqueueRegisteredSmsTx(tx, { deliveryId, phone, countryCode, codeVersion = 1, env = process.env }) {
  if (!smsOutbox.enabled(env) || !phone) return null;
  return smsOutbox.enqueueTx(tx, { kind: smsOutbox.KINDS.RECIPIENT_CODE, deliveryId, phone, countryCode, idempotencyKey: `RECIPIENT_CODE:${deliveryId}:${codeVersion}`, env });
}

module.exports = { enqueueRegisteredSmsTx, channels, parseRecipientEmail, recipientEmailRequired, senderMayViewCode, enqueueBookingTx, enqueueRegisteredTx, enqueueRegisteredSms, dispatchRegistered, registeredEmailFlow, dispatchBooking, recipientStatus, senderNotices, resendRecipient, rotateRecipient, cooldownMs, pilotScope, registeredParcelsAllowed, pilotMetrics };
