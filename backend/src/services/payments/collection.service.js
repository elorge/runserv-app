// backend/src/services/payments/collection.service.js
// Provider-neutral collection orchestration (currently used by MTN MoMo). Reuses the existing Payment row as the payment
// attempt. Rules: one idempotent state change (compare-and-set), provider status always read back server-side, amount /
// currency / reference must match before anything settles, conflicts go to REVIEW_REQUIRED + the exceptions queue.
'use strict';
const crypto = require('crypto');
const prisma = require('../../lib/prisma');
const { AppError } = require('../../middleware/errorHandler');
const { logActivity } = require('../../utils/auditLog');
const { toMinor } = require('../../utils/money');
const { normalizeMsisdn, isValidMsisdn } = require('../../utils/msisdn');
const { formatMoney } = require('../../utils/currency');
const { getCountryForUser } = require('../country.service');
const { paymentSplit } = require('../paymentSplit.service');
const notificationService = require('../notification.service');
const cfg = require('./providerConfig.service');
const mtn = require('./adapters/mtnMomo.adapter');

const PROVIDER = 'mtn_momo';
const TERMINAL_RETRYABLE = ['FAILED', 'CANCELLED', 'EXPIRED'];

// Allowed canonical transitions. Anything else is refused (and a conflicting provider report becomes REVIEW_REQUIRED).
const ALLOWED = {
  PENDING: ['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'REVIEW_REQUIRED'],
  REVIEW_REQUIRED: ['COMPLETED', 'FAILED'],               // admin resolution only
  COMPLETED: ['REFUND_PENDING', 'REFUNDED', 'PARTIALLY_REFUNDED'],
  FAILED: [], CANCELLED: [], EXPIRED: [], REFUND_PENDING: ['REFUNDED', 'PARTIALLY_REFUNDED', 'COMPLETED'], REFUNDED: [], PARTIALLY_REFUNDED: ['REFUNDED'],
};
const canTransition = (from, to) => (ALLOWED[from] || []).includes(to);

const mask = (msisdn) => `***${String(msisdn).slice(-3)}`;

/** Append-only evidence row. A unique (provider, externalEventId) hit means "seen before" → returns { duplicate:true }. */
const recordEvent = async (e) => {
  try {
    await prisma.paymentEvent.create({ data: { provider: PROVIDER, source: 'system', verification: 'NA', ...e } });
    return { duplicate: false };
  } catch (err) {
    if (err?.code === 'P2002') return { duplicate: true };
    console.error('[payments] event write failed:', err.message);
    return { duplicate: false, failed: true };
  }
};

/** One open exception per dedupeKey. */
const raiseException = async ({ paymentId = null, kind, detail = {}, dedupeKey }) => {
  try {
    await prisma.paymentException.create({ data: { paymentId, provider: PROVIDER, kind, detail, dedupeKey: dedupeKey || null } });
  } catch (err) { if (err?.code !== 'P2002') console.error('[payments] exception write failed:', err.message); }
};

const transition = async (payment, to, data = {}, evt = {}) => {
  if (!canTransition(payment.status, to)) return false;
  const won = (await prisma.payment.updateMany({ where: { id: payment.id, status: payment.status }, data: { status: to, ...data } })).count === 1;
  if (won) await recordEvent({ paymentId: payment.id, eventType: 'STATE_CHANGE', outcome: 'APPLIED', fromStatus: payment.status, toStatus: to, ...evt });
  return won;
};

const idemKeyOk = (k) => typeof k === 'string' && /^[A-Za-z0-9_\-:.]{8,128}$/.test(k);

const view = (p) => ({ paymentId: p.id, reference: p.transactionId, status: p.status, amount: p.amount, currency: p.currency });

const initiate = async ({ user, amount, rideId, deliveryId, phone, idempotencyKey }) => {
  if (!idemKeyOk(idempotencyKey)) throw new AppError('An Idempotency-Key header (8–128 chars) is required.', 400);
  if (!!rideId === !!deliveryId) throw new AppError('Provide exactly one of rideId or deliveryId.', 400);

  // Same key from the same user → same attempt, never a second collection.
  const prior = await prisma.payment.findFirst({ where: { userId: user.id, idempotencyKey } });
  if (prior) return { ...view(prior), replay: true };

  const country = await getCountryForUser(user);
  const currency = country.currencyCode;
  const service = rideId ? 'RIDE' : 'DELIVERY';

  // The amount is NEVER taken from the client: it is the booking's own fare.
  const booking = rideId
    ? await prisma.ride.findUnique({ where: { id: rideId }, select: { customerId: true, estimatedFare: true, actualFare: true } }).catch(() => null)
    : await prisma.delivery.findUnique({ where: { id: deliveryId }, select: { customerId: true, estimatedFee: true, actualFee: true } }).catch(() => null);
  if (!booking || booking.customerId !== user.id) throw new AppError('Booking not found.', 404);
  const due = Number(rideId ? (booking.actualFare ?? booking.estimatedFare) : (booking.actualFee ?? booking.estimatedFee));
  if (!(due > 0)) throw new AppError('This booking has no amount due.', 409);
  if (amount != null && toMinor(amount) !== toMinor(due)) throw new AppError('The amount does not match the amount due.', 400);

  const gate = await cfg.evaluate({ providerKey: PROVIDER, countryCode: country.code, currency, service, amount: due });
  if (!gate.eligible) { console.warn(`[payments] mtn_momo refused: ${gate.reason}`); throw new AppError('This payment method is not available.', 503); }
  if (!isValidMsisdn(phone, country.code)) throw new AppError('Enter a valid mobile number.', 400);
  const msisdn = normalizeMsisdn(phone, country.code);

  const existing = await prisma.payment.findFirst({ where: rideId ? { rideId } : { deliveryId } });
  if (existing && !TERMINAL_RETRYABLE.includes(existing.status)) {
    throw new AppError(existing.status === 'PENDING' ? 'A payment for this booking is already in progress.' : 'A payment for this booking already exists.', 409);
  }

  const referenceId = crypto.randomUUID();
  const externalId = `MM-${crypto.randomBytes(9).toString('base64url')}`;
  const base = { amount: due, currency, method: 'MOBILE_MONEY', status: 'PENDING', provider: PROVIDER, providerRef: referenceId, transactionId: externalId, idempotencyKey, providerStatus: null, settledAt: null, verifiedAmount: null, verifiedCurrency: null };
  let payment;
  try {
    if (existing) {
      const won = (await prisma.payment.updateMany({ where: { id: existing.id, status: existing.status }, data: base })).count === 1;
      if (!won) throw new AppError('A payment for this booking is already in progress.', 409);
      payment = await prisma.payment.findUnique({ where: { id: existing.id } });
    } else {
      payment = await prisma.payment.create({ data: { userId: user.id, ...(rideId ? { rideId } : { deliveryId }), ...base } });
    }
  } catch (err) {
    if (err?.code === 'P2002') { const again = await prisma.payment.findFirst({ where: { userId: user.id, idempotencyKey } }); if (again) return { ...view(again), replay: true }; throw new AppError('A payment for this booking is already in progress.', 409); }
    throw err;
  }
  await recordEvent({ paymentId: payment.id, eventType: 'STATE_CHANGE', source: 'client', outcome: 'APPLIED', toStatus: 'PENDING', meta: { payer: mask(msisdn), service } });

  const { ctx } = await cfg.adapterContext(PROVIDER, country.code);
  const apiBase = process.env.API_BASE_URL || '';
  const cbSecret = ctx.secrets.callbackSecret;
  const callbackUrl = apiBase && cbSecret ? `${apiBase}/api/payments/momo/webhook/${referenceId}/${mtn.callbackToken(referenceId, cbSecret)}` : undefined;
  try {
    await mtn.createCollection(ctx, { referenceId, amount: due, currency, externalId, msisdn, payerMessage: 'Runserv payment', payeeNote: externalId, callbackUrl });
  } catch (err) {
    if (err.code === 'PROVIDER_REJECTED') {
      await transition(payment, 'FAILED', { providerStatus: 'REJECTED' }, { source: 'provider', meta: { providerHttp: err.providerStatus } });
      throw new AppError('The payment request was declined. Please try again or use another method.', 400);
    }
    // Ambiguous (timeout / 5xx): leave PENDING — verification by our own referenceId decides.
    await recordEvent({ paymentId: payment.id, eventType: 'VERIFY', outcome: 'IGNORED', meta: { note: 'initiation response lost; left PENDING for verification' } });
  }
  return { ...view(payment), replay: false, message: 'Approve the payment prompt on your phone.' };
};

/** Read the provider's status and apply AT MOST ONE state change. Safe to call from verify, webhook, sweeper, admin. */
const settle = async (paymentId, { source = 'client' } = {}) => {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment || payment.provider !== PROVIDER) throw new AppError('Payment not found.', 404);
  if (payment.status === 'COMPLETED') return { status: 'COMPLETED', alreadyProcessed: true, payment };
  if (payment.status !== 'PENDING') return { status: payment.status, payment };

  const payer = await prisma.user.findUnique({ where: { id: payment.userId }, select: { id: true, countryCode: true, email: true, firstName: true } });
  const country = await getCountryForUser(payer);
  const { ctx } = await cfg.adapterContext(PROVIDER, country.code);
  let r;
  try { r = await mtn.verifyCollection(ctx, payment.providerRef); }
  catch { return { status: 'PENDING', pending: true, unavailable: true, payment }; }   // never guess

  await prisma.payment.updateMany({ where: { id: payment.id }, data: { providerStatus: r.raw } });
  if (r.status === 'PENDING' || r.status === 'UNKNOWN') return { status: 'PENDING', pending: true, payment };

  if (r.status === 'FAILED') {
    await transition(payment, 'FAILED', { providerStatus: r.raw }, { source: 'provider', verification: 'VERIFIED', meta: { reason: r.reason || null, via: source } });
    return { status: 'FAILED', payment: await prisma.payment.findUnique({ where: { id: payment.id } }) };
  }

  // SUCCESSFUL → amount, currency and our external reference must all match before money is recognised.
  const mismatch = toMinor(r.amount) !== toMinor(payment.amount) || String(r.currency || '') !== payment.currency || (r.externalId && r.externalId !== payment.transactionId);
  if (mismatch) {
    await transition(payment, 'REVIEW_REQUIRED', { providerStatus: r.raw, verifiedAmount: r.amount != null ? Number(r.amount) : null, verifiedCurrency: r.currency || null },
      { source: 'provider', verification: 'FAILED', outcome: 'REVIEW_REQUIRED', meta: { expected: { amount: String(payment.amount), currency: payment.currency }, got: { amount: r.amount, currency: r.currency } } });
    await raiseException({ paymentId: payment.id, kind: 'AMOUNT_MISMATCH', detail: { expected: { amount: String(payment.amount), currency: payment.currency }, got: { amount: r.amount, currency: r.currency } }, dedupeKey: `am:${payment.id}` });
    return { status: 'REVIEW_REQUIRED', payment: await prisma.payment.findUnique({ where: { id: payment.id } }) };
  }

  const split = await paymentSplit(payment.userId, { rideId: payment.rideId, deliveryId: payment.deliveryId }, payment.amount);
  const won = await transition(payment, 'COMPLETED', { ...split, providerStatus: r.raw, verifiedAmount: Number(r.amount), verifiedCurrency: r.currency, settledAt: new Date() }, { source: 'provider', verification: 'VERIFIED', meta: { via: source } });
  const fresh = await prisma.payment.findUnique({ where: { id: payment.id } });
  if (won) {
    notificationService.notify({ userId: payment.userId, title: 'Payment Successful ✅', message: `Your MTN MoMo payment of ${formatMoney(payment.amount, payment.currency)} was successful.`, type: notificationService.TYPES.PAYMENT_RECEIVED, data: { reference: payment.transactionId, amount: payment.amount, rideId: payment.rideId, deliveryId: payment.deliveryId } }).catch(() => {});
  }
  return { status: 'COMPLETED', alreadyProcessed: !won, payment: fresh };
};

/** Customer verify: ownership check, then the same server-side settle. */
const verifyForUser = async ({ user, reference, paymentId }) => {
  const p = await prisma.payment.findFirst({ where: { userId: user.id, provider: PROVIDER, ...(paymentId ? { id: paymentId } : { transactionId: reference }) } });
  if (!p) throw new AppError('Payment not found.', 404);
  return settle(p.id, { source: 'client' });
};

/** Provider callback. The URL carries our own HMAC; the body is never trusted — we call MTN back. */
const handleWebhook = async ({ referenceId, token, body }) => {
  const p = await prisma.payment.findFirst({ where: { provider: PROVIDER, providerRef: referenceId } });
  if (!p) { await raiseException({ kind: 'MISSING_INTERNALLY', detail: { reference: String(referenceId).slice(0, 64) }, dedupeKey: `mi:${referenceId}` }); return { code: 200, ignored: true }; }
  const payer = await prisma.user.findUnique({ where: { id: p.userId }, select: { countryCode: true } });
  const country = await getCountryForUser(payer);
  const { ctx } = await cfg.adapterContext(PROVIDER, country.code);
  if (!mtn.verifyCallbackToken(referenceId, token, ctx.secrets.callbackSecret)) {
    await recordEvent({ paymentId: p.id, eventType: 'WEBHOOK', source: 'provider', verification: 'FAILED', outcome: 'REJECTED', externalEventId: `bad:${referenceId}:${Math.floor(Date.now() / 3600000)}` });
    await raiseException({ paymentId: p.id, kind: 'WEBHOOK_VERIFICATION_FAILED', detail: {}, dedupeKey: `wvf:${p.id}:${Math.floor(Date.now() / 3600000)}` });
    return { code: 401 };
  }
  const claimed = String(body?.status || '').toUpperCase();
  const ev = await recordEvent({ paymentId: p.id, eventType: 'WEBHOOK', source: 'provider', verification: 'VERIFIED', outcome: 'RECEIVED', externalEventId: `${referenceId}:${claimed || 'NA'}`, meta: { claimedStatus: claimed || null } });
  // Always settle (idempotent): a retried callback must be able to finish work the first one could not.
  const r = await settle(p.id, { source: 'webhook' });
  return { code: 200, duplicate: ev.duplicate, status: r.status };
};

/** Admin decision on a REVIEW_REQUIRED payment. Evidence note mandatory. */
const adminResolve = async ({ paymentId, outcome, note, actor, req }) => {
  if (String(note || '').trim().length < 10) throw new AppError('Explain the evidence in at least 10 characters.', 400);
  const p = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!p || p.status !== 'REVIEW_REQUIRED') throw new AppError('Only a payment in REVIEW_REQUIRED can be resolved.', 409);
  const to = outcome === 'COMPLETE' ? 'COMPLETED' : 'FAILED';
  const data = to === 'COMPLETED' ? { ...(await paymentSplit(p.userId, { rideId: p.rideId, deliveryId: p.deliveryId }, p.amount)), settledAt: new Date() } : {};
  const won = await transition(p, to, data, { source: 'admin', meta: { actor, note: String(note).slice(0, 300) } });
  if (!won) throw new AppError('Someone else just changed this payment.', 409);
  await prisma.paymentException.updateMany({ where: { paymentId, status: 'OPEN' }, data: { status: 'RESOLVED', resolvedById: actor, resolvedAt: new Date(), resolution: String(note).slice(0, 300) } });
  await logActivity({ userId: actor, action: 'payment_review_resolved', entityType: 'Payment', entityId: paymentId, details: { outcome: to }, req });
  return { id: paymentId, status: to };
};

/** Sweeper: re-check long-pending MoMo payments; expire the hopeless; flag the slow. Run from a scheduler or the Admin. */
const sweepPending = async ({ staleMinutes = 10, expireMinutes = 60 * 24 } = {}) => {
  const rows = await prisma.payment.findMany({ where: { provider: PROVIDER, status: 'PENDING', createdAt: { lt: new Date(Date.now() - staleMinutes * 60000) } }, take: 100, orderBy: { createdAt: 'asc' } });
  let checked = 0, flagged = 0, expired = 0;
  for (const p of rows) {
    checked += 1;
    const r = await settle(p.id, { source: 'sweeper' }).catch(() => null);
    if (r?.status === 'PENDING') {
      if (Date.now() - new Date(p.createdAt).getTime() > expireMinutes * 60000 && !r.unavailable) { if (await transition(p, 'EXPIRED', {}, { source: 'system' })) expired += 1; }
      else { flagged += 1; await raiseException({ paymentId: p.id, kind: 'PENDING_TOO_LONG', detail: { since: p.createdAt }, dedupeKey: `ptl:${p.id}` }); }
    }
  }
  return { checked, flagged, expired };
};

module.exports = { PROVIDER, ALLOWED, canTransition, recordEvent, raiseException, transition, initiate, settle, verifyForUser, handleWebhook, adminResolve, sweepPending };
