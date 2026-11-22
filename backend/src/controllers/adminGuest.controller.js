// backend/src/controllers/adminGuest.controller.js
//
// Admin / support view of guest bookings: the queue (Guest vs Registered is explicit: everything here is a GUEST booking), phone
// verification status, quote and fare trace, dispatch state, parcel proof, abuse signals, secure-reference lookup, block/unblock.
// Phones are MASKED everywhere except the lookup, where the caller must already know the full number (reference + verified phone).
'use strict';
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const identity = require('../services/guestIdentity.service');
const { logActivity } = require('../utils/auditLog');
const { staffMarkets } = require('../utils/marketScope');
const { checkPhoneForCountry } = require('../utils/phone');
const { COUNTRY_CENTERS } = require('../utils/countryGeo');
const pod = require('../services/proofOfDelivery.service');
const comms = require('../services/deliveryComms.service');

const marketFilter = (user) => { const m = staffMarkets(user); return m.length ? { identity: { countryCode: { in: m } } } : {}; };
const canSee = (user, countryCode) => { const m = staffMarkets(user); return m.length === 0 || m.includes(countryCode); };

// Failed delivery: what the sender owes the courier (50% when recipient-side) or that support must review it.
const failedInfo = (d) => {
  if (!d.failedAt) return {};
  const f = pod.failedDeliveryFee(d);
  return { failedReason: d.failedReason || null, failedFee: f.eligible ? { amount: f.amount, currency: d.currency } : null, supportReview: !f.eligible };
};

const shape = (b) => {
  const trip = b.ride || b.delivery || null;
  return {
    id: b.id, reference: b.reference, source: 'GUEST', service: b.service, vehicleType: b.vehicleType,
    fare: Number(b.fare), currency: b.currency, createdAt: b.createdAt,
    status: trip?.status ?? null,
    phone: identity.maskPhone(b.identity?.phone || b.identity?.contactPhone),
    // M16.1: verification is per channel. Email verification never implies phone verification.
    verifiedChannel: b.identity?.verifiedChannel ?? 'PHONE', email: b.identity?.email ? identity.maskEmail(b.identity.email) : null,
    emailVerifiedAt: b.identity?.emailVerifiedAt ?? null, phoneVerifiedAt: b.identity?.phoneVerifiedAt ?? (b.identity?.verifiedChannel === 'EMAIL' ? null : b.identity?.verifiedAt ?? null), countryCode: b.identity?.countryCode ?? null,
    identityId: b.identityId, blocked: !!b.identity?.blockedAt, converted: !!b.identity?.convertedAt,
    trackingRevoked: !!b.trackingRevokedAt, trackingExpiresAt: b.trackingExpiresAt,
    ...(b.delivery ? { proof: { required: !!b.delivery.podCodeHash, verified: !!b.delivery.podVerifiedAt, locked: (b.delivery.podCodeAttempts || 0) >= 5, failed: !!b.delivery.failedAt, returnStatus: b.delivery.returnStatus || null, ...failedInfo(b.delivery) } } : {}),
  };
};

const INCLUDE = { identity: true, ride: true, delivery: true };

exports.list = async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1); const limit = Math.min(100, parseInt(req.query.limit, 10) || 25);
  const where = { ...marketFilter(req.user) };
  if (req.query.service) where.service = req.query.service;
  if (req.query.q) where.reference = { contains: String(req.query.q).toUpperCase().trim() };
  if (req.query.status) { const st = String(req.query.status).toUpperCase(); where.OR = [{ ride: { status: st } }, { delivery: { status: st } }]; }
  const [rows, total] = await Promise.all([
    prisma.guestBooking.findMany({ where, include: INCLUDE, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.guestBooking.count({ where }),
  ]);
  res.status(200).json({ success: true, data: { bookings: rows.map(shape), pagination: { total, page, pages: Math.ceil(total / limit) } } });
};

async function loadDetail(b, user) {
  const trip = b.ride || b.delivery;
  const earnerId = b.ride ? b.ride.driverId : b.delivery?.partnerId;
  const [events, earner] = await Promise.all([
    prisma.guestAuditEvent.findMany({ where: { OR: [{ bookingId: b.id }, { identityId: b.identityId }] }, orderBy: { createdAt: 'desc' }, take: 50 }),
    earnerId ? prisma.user.findUnique({ where: { id: earnerId }, select: { id: true, firstName: true, lastName: true, role: true } }) : null,
  ]);
  const snap = b.quoteSnapshot || {};
  // M16.2: recipient communications. Masked contacts, per-channel state, provider and message reference. NEVER the code or the full address.
  const communications = b.delivery ? await comms.recipientStatus({ booking: b, delivery: b.delivery }) : null;
  if (communications) communications.resendCooldownS = Math.round(comms.cooldownMs() / 1000);
  return {
    ...shape(b),
    communications,
    quote: snap.quote ? { id: snap.quote.id, issuedAt: snap.quote.issuedAt, expiresAt: snap.quote.expiresAt, distanceM: snap.quote.distanceM, durationS: snap.quote.durationS, vehicleType: snap.quote.vehicleType, fare: snap.quote.fare, currency: snap.quote.currency } : null,
    fareTrace: snap.trace || null,
    trip: trip ? {
      id: trip.id, status: trip.status, pickupAddress: trip.pickupAddress, dropoffAddress: trip.dropoffAddress, distanceKm: trip.distance, requestedAt: trip.requestedAt,
      acceptedAt: trip.acceptedAt ?? trip.assignedAt ?? null, startedAt: trip.startedAt ?? trip.pickedUpAt ?? null, completedAt: trip.completedAt ?? trip.deliveredAt ?? null,
      cancelledAt: trip.cancelledAt, cancellationReason: trip.cancellationReason,
      ...(b.delivery ? { podMethod: b.delivery.podMethod, podVerifiedAt: b.delivery.podVerifiedAt, podAttempts: b.delivery.podCodeAttempts, hasPodPhoto: !!b.delivery.podPhotoUrl, failedAt: b.delivery.failedAt, failedReason: b.delivery.failedReason, returnStatus: b.delivery.returnStatus, returnedAt: b.delivery.returnedAt, recipientName: b.delivery.recipientName, packageDescription: b.delivery.packageDescription, packageWeight: b.delivery.packageWeight } : {}),
    } : null,
    assignedTo: earner ? { id: earner.id, name: `${earner.firstName} ${earner.lastName}`.trim(), role: earner.role } : null,
    audit: events.map((e) => ({ id: e.id, event: e.event, at: e.createdAt, meta: e.meta })),
  };
}

exports.detail = async (req, res) => {
  const b = await prisma.guestBooking.findUnique({ where: { id: req.params.id }, include: INCLUDE });
  if (!b || !canSee(req.user, b.identity.countryCode)) throw new AppError('Guest booking not found', 404);
  res.status(200).json({ success: true, data: await loadDetail(b, req.user) });
};

/** Support: find a booking by its reference AND the verified phone. A reference alone is never enough. */
exports.lookup = async (req, res) => {
  const reference = String(req.body.reference).toUpperCase().trim();
  const b = await prisma.guestBooking.findUnique({ where: { reference }, include: INCLUDE });
  let match = false;
  if (b) {
    const cc = b.identity.countryCode;
    const chk = COUNTRY_CENTERS[cc] ? checkPhoneForCountry(req.body.phone, cc) : { ok: false };
    match = chk.ok && identity.toE164(req.body.phone, cc) === (b.identity.phone || b.identity.contactPhone) && canSee(req.user, cc);   // M16.1: email identities are looked up by their contact number
  }
  await logActivity({ userId: req.user.id, action: 'guest_booking_lookup', entityType: 'GuestBooking', entityId: b?.id ?? null, details: { reference, matched: match }, req });
  await identity.audit('SUPPORT_LOOKUP', { bookingId: b?.id ?? null, identityId: b?.identityId ?? null, ip: req.ip, meta: { adminId: req.user.id, matched: match } });
  if (!match) throw new AppError('No guest booking matches that reference and phone number.', 404);   // same answer for wrong reference and wrong phone
  res.status(200).json({ success: true, data: await loadDetail(b, req.user) });
};

/** Abuse indicators over the last 24 h: events by type and the noisiest sources (hashed IPs). */
exports.abuse = async (req, res) => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const types = ['RATE_LIMITED', 'OTP_COOLDOWN', 'OTP_PHONE_LIMIT', 'OTP_IP_LIMIT', 'OTP_LOCKED', 'OTP_WRONG_CODE', 'BOOKING_DAILY_LIMIT', 'POD_WRONG_CODE'];
  const [counts, recent, noisy] = await Promise.all([
    prisma.guestAuditEvent.groupBy({ by: ['event'], where: { createdAt: { gte: since }, event: { in: types } }, _count: { _all: true } }),
    prisma.guestAuditEvent.findMany({ where: { createdAt: { gte: since }, event: { in: types } }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.guestAuditEvent.groupBy({ by: ['ipHash'], where: { createdAt: { gte: since }, event: { in: types }, ipHash: { not: null } }, _count: { _all: true }, orderBy: { _count: { ipHash: 'desc' } }, take: 10 }),
  ]);
  res.status(200).json({ success: true, data: {
    since,
    counts: counts.map((r) => ({ event: r.event, count: r._count._all })),
    noisySources: noisy.map((r) => ({ source: r.ipHash, count: r._count._all })),
    recent: recent.map((e) => ({ id: e.id, event: e.event, at: e.createdAt, source: e.ipHash, meta: e.meta })),
  } });
};

/** M16: SMS queue for guest bookings: delivery state, failures, and a re-queue action. Numbers are masked; message text is never stored. */
exports.smsList = async (req, res) => {
  const smsOutbox = require('../services/smsOutbox.service');
  const status = req.query.status ? String(req.query.status).toUpperCase() : undefined;
  const rows = await prisma.smsOutbox.findMany({ where: { ...(status ? { status } : {}), ...(req.query.kind ? { kind: String(req.query.kind).toUpperCase() } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 });
  const bookings = rows.length ? await prisma.guestBooking.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.bookingId))] } }, include: { identity: true } }) : [];
  const byId = new Map(bookings.map((b) => [b.id, b]));
  const visible = rows.filter((r) => { const b = byId.get(r.bookingId); return !b || canSee(req.user, b.identity.countryCode); });   // market guard
  res.status(200).json({ success: true, data: {
    stats: await smsOutbox.stats(),
    messages: visible.map((r) => ({ id: r.id, kind: r.kind, status: r.status, attempts: r.attempts, to: r.toMasked, lastError: r.lastError, createdAt: r.createdAt, sentAt: r.sentAt, nextAttemptAt: r.nextAttemptAt,
      bookingId: r.bookingId, reference: byId.get(r.bookingId)?.reference ?? null, canRetry: r.status === 'DEAD' && !!r.toPhone })),
  } });
};

exports.smsRetry = async (req, res) => {
  const smsOutbox = require('../services/smsOutbox.service');
  const row = await prisma.smsOutbox.findUnique({ where: { id: req.params.id } });
  const b = row ? await prisma.guestBooking.findUnique({ where: { id: row.bookingId }, include: { identity: true } }) : null;
  if (!row || (b && !canSee(req.user, b.identity.countryCode))) throw new AppError('Message not found', 404);
  try { await smsOutbox.requeue(row.id); } catch (e) { throw new AppError(e.message, e.statusCode || 400); }
  await logActivity({ userId: req.user.id, action: 'guest_sms_requeued', entityType: 'SmsOutbox', entityId: row.id, details: { kind: row.kind, bookingId: row.bookingId } });
  res.status(200).json({ success: true, message: 'Message re-queued. It will be sent shortly.' });
};

// ── M16.1: email queue, provider usage and operator controls (never the code, never the stored address) ─────────────────────────
const emailRowMarket = async (rows) => {
  const otps = rows.length ? await prisma.guestOtp.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.otpId).filter(Boolean))] } } }) : [];
  return new Map(otps.map((o) => [o.id, o]));
};
exports.emailList = async (req, res) => {
  const emailOutbox = require('../services/emailOutbox.service');
  const status = req.query.status ? String(req.query.status).toUpperCase() : undefined;
  const rows = await prisma.emailOutbox.findMany({ where: { ...(status ? { status } : {}), ...(req.query.provider ? { provider: String(req.query.provider).toLowerCase() } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 });
  const otps = await emailRowMarket(rows);
  const bookingIds = [...new Set(rows.map((r) => r.bookingId).filter(Boolean))];
  const bookings = bookingIds.length ? await prisma.guestBooking.findMany({ where: { id: { in: bookingIds } }, include: { identity: true } }) : [];
  const byBooking = new Map(bookings.map((b) => [b.id, b]));
  const visible = rows.filter((r) => { const cc = otps.get(r.otpId)?.countryCode || byBooking.get(r.bookingId)?.identity?.countryCode; return !cc || canSee(req.user, cc); });   // market guard
  res.status(200).json({ success: true, data: {
    stats: await emailOutbox.stats(),
    messages: visible.map((r) => ({ id: r.id, kind: r.kind, bookingId: r.bookingId ?? null, reference: byBooking.get(r.bookingId)?.reference ?? null, status: r.status, attempts: r.attempts, to: r.toMasked, provider: r.provider, routeReason: r.routeReason, errorCategory: r.errorCategory, lastError: r.lastError,
      deliveryStatus: r.deliveryStatus, deliveryAt: r.deliveryAt, createdAt: r.createdAt, sentAt: r.sentAt, nextAttemptAt: r.nextAttemptAt, canRetry: r.status === 'DEAD' && !!r.toEmail && r.errorCategory !== 'INVALID_ADDRESS' })),
  } });
};
exports.emailRetry = async (req, res) => {
  const emailOutbox = require('../services/emailOutbox.service');
  const row = await prisma.emailOutbox.findUnique({ where: { id: req.params.id } });
  const otp = row?.otpId ? await prisma.guestOtp.findUnique({ where: { id: row.otpId } }) : null;
  const bk = row?.bookingId ? await prisma.guestBooking.findUnique({ where: { id: row.bookingId }, include: { identity: true } }) : null;
  if (!row || (otp && !canSee(req.user, otp.countryCode)) || (bk && !canSee(req.user, bk.identity.countryCode))) throw new AppError('Message not found', 404);
  try { await emailOutbox.requeue(row.id); } catch (e) { throw new AppError(e.message, e.statusCode || 400); }
  await logActivity({ userId: req.user.id, action: 'guest_email_requeued', entityType: 'EmailOutbox', entityId: row.id, details: { kind: row.kind, provider: row.provider } });
  res.status(200).json({ success: true, message: 'Message re-queued. It will be sent shortly.' });
};
/** M16.2: resend the recipient's code + tracking link (SAME code, no rotation) on every enabled channel. Cooldown, audited, admin-only. */
exports.recipientResend = async (req, res) => {
  const b = await prisma.guestBooking.findUnique({ where: { id: req.params.id }, include: { identity: true } });
  if (!b || !canSee(req.user, b.identity.countryCode)) throw new AppError('Guest booking not found', 404);
  let result;
  try { result = await comms.resendRecipient({ booking: b, countryCode: b.identity.countryCode, adminId: req.user.id, ip: req.ip }); }
  catch (e) { throw Object.assign(new AppError(e.message, e.statusCode || 400), { code: e.code, retryAfterS: e.retryAfterS }); }
  await logActivity({ userId: req.user.id, action: 'recipient_notification_resent', entityType: 'GuestBooking', entityId: b.id, details: { channels: Object.keys(result.queued).filter((k) => result.queued[k]), reason: req.body.reason }, req });
  comms.dispatchBooking(b.id).catch((e) => console.error('[recipient-resend] immediate send failed:', e.message));
  res.status(200).json({ success: true, message: 'Notification re-queued. The recipient gets the same code.', data: result });
};

exports.emailProviderPause = (paused) => async (req, res) => {
  const quota = require('../services/emailQuota.service');
  try { await quota.setPaused(req.params.provider, paused, req.user.id); } catch (e) { throw new AppError(e.message, e.statusCode || 400); }
  await logActivity({ userId: req.user.id, action: paused ? 'email_provider_paused' : 'email_provider_resumed', entityType: 'EmailProvider', entityId: req.params.provider, details: {} });
  res.status(200).json({ success: true, data: await require('../services/emailQuota.service').usage() });
};

exports.block = async (req, res) => {
  const ident = await prisma.guestIdentity.findUnique({ where: { id: req.params.id } });
  if (!ident || !canSee(req.user, ident.countryCode)) throw new AppError('Guest not found', 404);
  await prisma.guestIdentity.update({ where: { id: ident.id }, data: { blockedAt: new Date(), blockReason: String(req.body.reason).slice(0, 200) } });
  await identity.revokeAllSessions(ident.id);
  await logActivity({ userId: req.user.id, action: 'guest_blocked', entityType: 'GuestIdentity', entityId: ident.id, details: { reason: req.body.reason }, req });
  await identity.audit('GUEST_BLOCKED', { identityId: ident.id, ip: req.ip, meta: { adminId: req.user.id, reason: req.body.reason } });
  res.status(200).json({ success: true, message: 'Guest blocked. Their sessions were revoked.' });
};
exports.unblock = async (req, res) => {
  const ident = await prisma.guestIdentity.findUnique({ where: { id: req.params.id } });
  if (!ident || !canSee(req.user, ident.countryCode)) throw new AppError('Guest not found', 404);
  await prisma.guestIdentity.update({ where: { id: ident.id }, data: { blockedAt: null, blockReason: null } });
  await logActivity({ userId: req.user.id, action: 'guest_unblocked', entityType: 'GuestIdentity', entityId: ident.id, req });
  await identity.audit('GUEST_UNBLOCKED', { identityId: ident.id, ip: req.ip, meta: { adminId: req.user.id } });
  res.status(200).json({ success: true, message: 'Guest unblocked.' });
};

/** M16.2.1: ROTATE the recipient's hand-over code (high risk, distinct from resend). Explicit confirmation + reason, admin-only, audited. Never returns the code. */
exports.recipientRotate = async (req, res) => {
  const b = await prisma.guestBooking.findUnique({ where: { id: req.params.id }, include: { identity: true } });
  if (!b || !canSee(req.user, b.identity.countryCode)) throw new AppError('Guest booking not found', 404);
  if (req.body.confirm !== true) throw Object.assign(new AppError('Confirm that the previous code should stop working.', 400), { code: 'CONFIRM_REQUIRED' });
  let result;
  try { result = await comms.rotateRecipient({ booking: b, countryCode: b.identity.countryCode, adminId: req.user.id, ip: req.ip, reason: req.body.reason }); }
  catch (e) { throw Object.assign(new AppError(e.message, e.statusCode || 400), { code: e.code, retryAfterS: e.retryAfterS }); }
  await logActivity({ userId: req.user.id, action: 'recipient_code_rotated', entityType: 'GuestBooking', entityId: b.id, details: { channels: Object.keys(result.queued).filter((k) => result.queued[k]), version: result.version, reason: req.body.reason }, req });
  comms.dispatchBooking(b.id).catch((e) => console.error('[recipient-rotate] immediate send failed:', e.message));
  res.status(200).json({ success: true, message: 'A new code was issued and the previous one no longer works. The recipient has been notified.', data: { queued: result.queued, version: result.version, expiresAt: result.expiresAt } });
};

/** M16.2.1: pilot metrics from the outbox and audit tables (guide §16). Aggregates only: no addresses, codes or message text. */
exports.pilotMetrics = async (req, res) => {
  const hours = Math.min(24 * 90, Math.max(1, parseInt(req.query.hours, 10) || 24 * 7));
  res.status(200).json({ success: true, data: await comms.pilotMetrics({ sinceHours: hours }) });
};

/** M16.2.1: guest parcels whose recipient has no working path to the code (every channel failed, code expired or locked). The operations work list. */
exports.recipientAttention = async (req, res) => {
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const rows = await prisma.guestBooking.findMany({ where: { ...marketFilter(req.user), service: 'PARCEL', createdAt: { gte: since } }, include: INCLUDE, orderBy: { createdAt: 'desc' }, take: 200 });
  const out = [];
  for (const b of rows) {
    if (!b.delivery) continue;
    const st = await comms.recipientStatus({ booking: b, delivery: b.delivery });
    if (st.needsAttention) out.push({ id: b.id, reference: b.reference, deliveryStatus: b.delivery.status, createdAt: b.createdAt, overall: st.overall, recovery: st.recovery, code: st.code, email: { state: st.email.state, contact: st.email.contact }, sms: { state: st.sms.state } });
    if (out.length >= 100) break;
  }
  res.status(200).json({ success: true, data: { items: out } });
};

// ── Manual hand-over exception (guide §10/§12, action plan P1.4): request -> approve/reject, by AUTHORISED OPERATORS ONLY. The courier has no route here. ──
const fourEyes = () => String(process.env.POD_EXCEPTION_FOUR_EYES).toLowerCase() !== 'false';
const EXC_WINDOW_MS = 24 * 3600 * 1000;
async function loadExceptionDelivery(req) {
  const d = await prisma.delivery.findUnique({ where: { id: req.params.id }, include: { customer: { select: { countryCode: true } } } });
  if (!d || !canSee(req.user, d.customer?.countryCode)) throw new AppError('Delivery not found', 404);
  if (!d.podCodeHash) throw new AppError('This delivery does not use a hand-over code.', 400);
  if (d.podVerifiedAt) throw new AppError('Proof was already recorded for this delivery.', 409);
  if (d.status !== 'IN_TRANSIT' || d.failedAt) throw new AppError('Only an in-transit delivery can have a hand-over exception.', 409);
  return d;
}
/** The latest still-open request for this delivery: requested within 24 h and not yet approved or rejected afterwards. */
async function openExceptionRequest(deliveryId) {
  const since = new Date(Date.now() - EXC_WINDOW_MS);
  const evs = (await prisma.guestAuditEvent.findMany({ where: { createdAt: { gte: since }, event: { in: ['MANUAL_HANDOVER_EXCEPTION_REQUESTED', 'MANUAL_HANDOVER_EXCEPTION_APPROVED', 'MANUAL_HANDOVER_EXCEPTION_REJECTED'] } }, orderBy: { createdAt: 'desc' }, take: 500 })).filter((e) => e.meta?.deliveryId === deliveryId);
  // Order-independent (two events can share a millisecond): the newest REQUEST is open unless a decision was recorded at or after it.
  const requests = evs.filter((e) => e.event === 'MANUAL_HANDOVER_EXCEPTION_REQUESTED').sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const req = requests[0]; if (!req) return null;
  const decided = evs.some((e) => e.event !== 'MANUAL_HANDOVER_EXCEPTION_REQUESTED' && new Date(e.createdAt) >= new Date(req.createdAt));
  return decided ? null : req;
}
exports.exceptionRequest = async (req, res) => {
  const d = await loadExceptionDelivery(req);
  const bk = await prisma.guestBooking.findUnique({ where: { deliveryId: d.id } }).catch(() => null);
  await identity.audit('MANUAL_HANDOVER_EXCEPTION_REQUESTED', { bookingId: bk?.id ?? null, ip: req.ip, meta: { deliveryId: d.id, adminId: req.user.id, reason: req.body.reason, evidence: req.body.evidence } });
  await logActivity({ userId: req.user.id, action: 'handover_exception_requested', entityType: 'Delivery', entityId: d.id, details: { reason: req.body.reason }, req });
  res.status(200).json({ success: true, message: 'Exception requested. A second authorised operator must approve it.' });
};
exports.exceptionReject = async (req, res) => {
  const d = await loadExceptionDelivery(req);
  const open = await openExceptionRequest(d.id);
  if (!open) throw new AppError('There is no open exception request for this delivery.', 409);
  await identity.audit('MANUAL_HANDOVER_EXCEPTION_REJECTED', { bookingId: open.bookingId, ip: req.ip, meta: { deliveryId: d.id, adminId: req.user.id, reason: req.body.reason } });
  res.status(200).json({ success: true, message: 'Exception rejected.' });
};
/** APPROVE: records proof by SUPPORT_OVERRIDE. Needs an open request carrying a reason and evidence; by default a DIFFERENT operator than the requester (POD_EXCEPTION_FOUR_EYES=false relaxes it, and is logged). */
exports.podOverride = async (req, res) => {
  const d = await loadExceptionDelivery(req);
  const open = await openExceptionRequest(d.id);
  if (!open) throw Object.assign(new AppError('Request the exception first, with a reason and evidence. It must then be approved by a second authorised operator.', 409), { code: 'EXCEPTION_NOT_REQUESTED' });
  const self = open.meta?.adminId === req.user.id;
  if (self && fourEyes()) throw Object.assign(new AppError('Another authorised operator must approve this exception. You cannot approve your own request.', 403), { code: 'SECOND_APPROVER_REQUIRED' });
  const res2 = await prisma.delivery.updateMany({ where: { id: d.id, podVerifiedAt: null, failedAt: null, status: 'IN_TRANSIT' }, data: { podVerifiedAt: new Date(), podMethod: 'SUPPORT_OVERRIDE' } });
  if (res2.count !== 1) throw new AppError('This delivery changed. Reload and try again.', 409);
  await logActivity({ userId: req.user.id, action: 'pod_override', entityType: 'Delivery', entityId: d.id, details: { reason: req.body.reason, requestedBy: open.meta?.adminId, selfApproved: self }, req });
  await identity.audit('MANUAL_HANDOVER_EXCEPTION_APPROVED', { bookingId: open.bookingId, ip: req.ip, meta: { deliveryId: d.id, adminId: req.user.id, requestedBy: open.meta?.adminId, reason: req.body.reason, selfApproved: self } });
  await identity.audit('POD_OVERRIDE', { bookingId: open.bookingId, ip: req.ip, meta: { deliveryId: d.id, adminId: req.user.id, reason: req.body.reason } });
  res.status(200).json({ success: true, message: 'Proof recorded by support. The courier can now complete the delivery.' });
};

exports._test = { shape };
