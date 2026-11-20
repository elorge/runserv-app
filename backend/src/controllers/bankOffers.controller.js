// backend/src/controllers/bankOffers.controller.js — customer-facing offers + bank callback
'use strict';
const prisma = require('../lib/prisma');
const svc = require('../services/bankOffers.service');
const { AppError } = require('../middleware/errorHandler');
const { logActivity } = require('../utils/auditLog');

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

exports.list = async (req, res) => ok(res, { offers: await svc.listOffers({ countryCode: req.user.countryCode || 'NG' }), creditOffersEnabled: svc.creditEnabled(), tripBenefitsEnabled: svc.tripBenefitsEnabled() });
exports.impressions = async (req, res) => ok(res, { counted: await svc.recordImpressions(req.body.offerIds, { userId: req.user.id }) });
exports.get = async (req, res) => ok(res, { offer: await svc.viewOffer(req.params.id) });

exports.click = async (req, res) => {
  const out = await svc.trackClick({ userId: req.user.id, offerId: req.params.id });
  await logActivity({ userId: req.user.id, action: 'bank_offer_click', entityType: 'BankOffer', entityId: req.params.id, details: { referralCode: out.referralCode }, req });
  return ok(res, out, 201);
};

exports.quote = async (req, res) => ok(res, await svc.quote({ offerId: req.params.id, amount: req.body.amount }));

/**
 * The price is never taken from the client. A benefit is reserved for one of the caller's own trips that has not
 * started, on the server's own estimate, and a trip can hold only one live benefit.
 */
exports.redeem = async (req, res) => {
  const { rideId, deliveryId, idempotencyKey } = req.body;
  if (Boolean(rideId) === Boolean(deliveryId)) throw new AppError('Provide either rideId or deliveryId.', 400);
  const trip = rideId
    ? await prisma.ride.findUnique({ where: { id: rideId }, select: { customerId: true, status: true, estimatedFare: true } })
    : await prisma.delivery.findUnique({ where: { id: deliveryId }, select: { customerId: true, status: true, estimatedFee: true } });
  if (!trip || trip.customerId !== req.user.id) throw new AppError('Trip not found.', 404);
  if ((rideId && trip.status !== 'REQUESTED') || (deliveryId && trip.status !== 'PENDING')) throw new AppError('A benefit can only be applied before a driver has been assigned.', 409);
  const live = await prisma.bankRedemption.findFirst({ where: { ...(rideId ? { rideId } : { deliveryId }), status: { in: ['RESERVED', 'CONFIRMED'] } }, select: { idempotencyKey: true } });
  if (live && live.idempotencyKey !== idempotencyKey) throw new AppError('A benefit has already been applied to this trip.', 409);
  const amount = Number(rideId ? trip.estimatedFare : trip.estimatedFee);
  const { redemption, replay } = await svc.redeem({ userId: req.user.id, offerId: req.params.id, amount, idempotencyKey, rideId: rideId ?? null, deliveryId: deliveryId ?? null });
  return ok(res, { redemption: { id: redemption.id, status: redemption.status, benefitAmount: Number(redemption.benefitAmount), currency: redemption.currency }, replay }, replay ? 200 : 201);
};

exports.release = async (req, res) => ok(res, await svc.releaseRedemption({ redemptionId: req.params.id, userId: req.user.id }));

// Bank → Runserv. Authenticated by HMAC signature, not by a user token. One signed endpoint per bank carries two kinds of
// notice: referral status (default) and a payment credit ({"event":"payment.credited", ...}).
exports.callback = async (req, res) => {
  const receipts = require('../services/bankReceipts.service');
  const bank = await prisma.bankPartner.findUnique({ where: { id: req.params.bankPartnerId }, select: { id: true, status: true } });
  // Same response for an unknown bank, a bad signature or a terminated bank: do not reveal which bank ids exist.
  if (!bank || bank.status === 'TERMINATED') return res.status(401).json({ success: false, message: 'Invalid signature.' });
  const secret = await receipts.resolveBankSecret(bank.id);
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
  const okSig = svc.verifyCallbackSignature({ secret, timestamp: req.headers['x-runserv-timestamp'], signature: req.headers['x-runserv-signature'], rawBody: raw });
  if (!okSig) throw new AppError('Invalid signature.', 401);
  let parsed; try { parsed = JSON.parse(raw); } catch { throw new AppError('Invalid JSON.', 400); }
  if (parsed && parsed.event === 'payment.credited') {
    if (process.env.BANK_RECEIPTS_ENABLED === 'false') throw new AppError('Payment notices are not enabled.', 404);
    const { duplicate, payment, settlementStatus } = await receipts.recordInboundPayment({ bankPartnerId: bank.id, payload: parsed.data ?? parsed, source: 'WEBHOOK' });
    return ok(res, { duplicate, status: payment.status, settlementStatus: settlementStatus ?? null });
  }
  const result = await svc.processBankCallback({ bankPartnerId: bank.id, rawBody: req.body, headers: req.headers, secret });
  return ok(res, result);
};
