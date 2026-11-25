// backend/src/services/proofOfDelivery.service.js
//
// Proof of delivery and failed delivery for parcels (guide §3.4, §5.3, §8).
//   * A delivery created with a podCodeHash (every guest parcel) cannot be completed until the courier has entered the recipient's
//     6-digit code (M16.2.1: it expires per POD_CODE_TTL_HOURS and an Admin can rotate it; see podCode.service). Five wrong tries lock the delivery for the courier (support can review and override with a reason + evidence).
//   * Optional photo evidence must be a file Runserv stored itself (never a link the courier typed).
//   * A failed delivery is recorded with a reason and the parcel goes back to the sender; it cannot then be "completed".
//   * DECISION (M15, 21 Nov 2026): when the failure is RECIPIENT-SIDE (recipient unavailable, wrong address, refused) the courier is
//     paid 50% of the delivery fee, owed by the sender IN CASH when the parcel is handed back. Damage and "other" are NOT paid
//     automatically: support reviews them. The payout is recorded as one CASH Payment row when the return is confirmed.
'use strict';
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { podHash } = require('./guestBooking.service');
const podCode = require('./podCode.service');
const identity = require('./guestIdentity.service');
const { isStoredDocumentRef } = require('../utils/trustedFileUrl');
const { checkPhoneForCountry } = require('../utils/phone');

const MAX_POD_ATTEMPTS = 5;
// Recipient-side reasons earn the courier a part-fee. Anything else (damage, other) is reviewed by support, never auto-paid.
const RECIPIENT_SIDE_REASONS = ['RECIPIENT_UNAVAILABLE', 'WRONG_ADDRESS', 'RECIPIENT_REFUSED'];
const FAILED_FEE_SHARE = 0.5;
const FAIL_REASONS = ['RECIPIENT_UNAVAILABLE', 'WRONG_ADDRESS', 'RECIPIENT_REFUSED', 'PARCEL_DAMAGED', 'OTHER'];
const NOT_ACCEPTED_MSG = 'That code was not accepted. Check it with the recipient and try again. If they cannot find a valid code, contact Runserv support.';
const LOCKED_MSG = 'Verification is locked for this delivery. Contact Runserv support.';
const err = (message, status, code, extra = {}) => Object.assign(new AppError(message, status), { code, ...extra });

/** True when this delivery still needs its code before it can be completed. */
const proofPending = (d) => !!d.podCodeHash && !d.podVerifiedAt;


/** Hand-over codes for ALL deliveries (registered senders too) are behind POD_CODE_ALL_DELIVERIES (default off). Guest parcels always have one. */
const codeForAllDeliveries = (env = process.env) => String(env.POD_CODE_ALL_DELIVERIES).toLowerCase() === 'true';

/** The machine reason out of the stored text ("RECIPIENT_UNAVAILABLE: phone off" -> "RECIPIENT_UNAVAILABLE"). */
const failureReasonCode = (failedReason) => String(failedReason || '').split(':')[0].trim();
const isRecipientSide = (failedReason) => RECIPIENT_SIDE_REASONS.includes(failureReasonCode(failedReason));

/** Platform commission on the part-fee. Default 0: the courier keeps the whole 50% (decision wording). Env FAILED_DELIVERY_COMMISSION_RATE 0..0.5 changes it. */
const failedFeeCommissionRate = (env = process.env) => {
  const r = Number(env.FAILED_DELIVERY_COMMISSION_RATE);
  return Number.isFinite(r) && r >= 0 && r <= 0.5 ? r : 0;
};

/**
 * What the sender owes the courier for a failed delivery, in the currency's units (same rounding as the rest of the delivery code).
 * Returns { eligible, amount, platformFee, courierEarnings, share, reason }. Company-billed deliveries are never auto-charged in cash.
 */
function failedDeliveryFee(delivery, env = process.env) {
  const none = (reason) => ({ eligible: false, amount: 0, platformFee: 0, courierEarnings: 0, share: FAILED_FEE_SHARE, reason });
  if (!delivery?.failedAt) return none('NOT_FAILED');
  if (!isRecipientSide(delivery.failedReason)) return none('SUPPORT_REVIEW');
  if (delivery.payerType === 'ORGANIZATION') return none('COMPANY_BILLED');
  const full = Number(delivery.estimatedFee);
  if (!Number.isFinite(full) || full <= 0) return none('NO_FEE');
  const amount = Math.round(full * FAILED_FEE_SHARE);
  const platformFee = Math.round(amount * failedFeeCommissionRate(env));
  return { eligible: true, amount, platformFee, courierEarnings: amount - platformFee, share: FAILED_FEE_SHARE, reason: 'RECIPIENT_SIDE' };
}

/** Non-sensitive proof/failure state for the courier and sender apps (the code hash itself is never serialised). */
function proofView(delivery, env = process.env) {
  if (!delivery) return null;
  const fee = failedDeliveryFee(delivery, env);
  return {
    required: !!delivery.podCodeHash,
    verified: !!delivery.podVerifiedAt,
    locked: (delivery.podCodeAttempts || 0) >= MAX_POD_ATTEMPTS,
    // M16.2.1: the remaining-attempt count is NOT sent to the courier app (guide §5/§9). The limit is enforced server-side only.
    failed: !!delivery.failedAt,
    failedReason: delivery.failedReason || null,
    returnStatus: delivery.returnStatus || null,
    ...(fee.eligible ? { failedFee: { amount: fee.amount, currency: delivery.currency, share: fee.share, collectFromSender: true } } : {}),
  };
}


/**
 * SMS the 6-digit hand-over code to the RECIPIENT. Best effort: a failed SMS never undoes a booking (the sender can read the code out).
 * The number is normalised to international format first: the SMS provider does not accept local formats such as 0801...
 */
async function smsRecipientCode({ phone, countryCode = 'NG', code, reference = null }, { env = process.env, sms = null } = {}) {
  if (!require('./smsOutbox.service').enabled(env)) return false;   // M16.2: delivery SMS has its own flag
  try {
    const cc = String(countryCode || 'NG').toUpperCase();
    const raw = String(phone || '').replace(/[^\d+]/g, '');
    if (!checkPhoneForCountry(raw, cc).ok) return false;
    const to = identity.toE164(raw, cc);
    await (sms || require('./termii.service')).send(to, `A Runserv parcel is coming to you${reference ? ` (ref ${reference})` : ''}. Give the courier the code ${code} ONLY when you have the parcel in your hands.`);
    return true;
  } catch (e) { console.error('[pod] recipient SMS failed:', e.message); return false; }
}

async function ownedDelivery(deliveryId, partnerId) {
  const d = await prisma.delivery.findUnique({ where: { id: deliveryId } });
  if (!d) throw err('Delivery not found', 404, 'NOT_FOUND');
  if (d.partnerId !== partnerId) throw err('Unauthorized', 403, 'FORBIDDEN');
  return d;
}

/** Courier enters the recipient's code at hand-over. */
async function verifyProof({ deliveryId, partnerId, code, photoUrl, ip }) {
  const d = await ownedDelivery(deliveryId, partnerId);
  if (d.status !== 'IN_TRANSIT') throw err('Start the trip to the recipient before confirming delivery.', 409, 'NOT_IN_TRANSIT');
  if (d.failedAt) throw err('This delivery was marked as failed.', 409, 'ALREADY_FAILED');
  if (!d.podCodeHash) throw err('This delivery does not use a hand-over code.', 400, 'POD_NOT_REQUIRED');
  if (d.podVerifiedAt) return { verified: true, already: true };
  if (photoUrl != null && !isStoredDocumentRef(photoUrl)) throw err('Photo evidence must be uploaded through the Runserv app.', 400, 'POD_PHOTO_INVALID');
  if (!/^\d{6}$/.test(String(code || ''))) throw err('Enter the 6-digit code from the recipient.', 400, 'POD_CODE_FORMAT');

  // M16.1: the attempt is SPENT FIRST, by a conditional update whose WHERE clause includes `podCodeAttempts < MAX` and the delivery's state
  // (assigned to this courier, in transit, not verified, not failed). Parallel guesses cannot all read the same counter: the database lets
  // at most MAX of them through, whatever their code. A verified or failed delivery matches nothing, so it can neither consume attempts nor
  // be used to bypass the cap. M16.2.1: an EXPIRED code also spends an attempt, so expiry is not an oracle.
  const gate = await prisma.delivery.updateMany({ where: { id: d.id, partnerId, status: 'IN_TRANSIT', podVerifiedAt: null, failedAt: null, podCodeAttempts: { lt: MAX_POD_ATTEMPTS } }, data: { podCodeAttempts: { increment: 1 } } });
  if (gate.count !== 1) {
    const cur = await prisma.delivery.findUnique({ where: { id: d.id } });
    if (cur?.podVerifiedAt) return { verified: true, already: true };
    if (cur?.failedAt) throw err('This delivery was marked as failed.', 409, 'ALREADY_FAILED');
    if (cur && cur.podCodeAttempts >= MAX_POD_ATTEMPTS) throw err(LOCKED_MSG, 429, 'POD_LOCKED');
    throw err('This delivery changed. Please refresh and try again.', 409, 'CONFLICT');
  }
  // Re-read AFTER spending the attempt: the hash we compare against is the one that is current NOW (a rotation between the first read and here is honoured).
  const cur = await prisma.delivery.findUnique({ where: { id: d.id } });
  const liveHash = cur?.podCodeHash || d.podCodeHash;
  const matches = identity.safeEqualHex(liveHash, podHash(d.id, String(code)));
  const expired = podCode.isExpired(cur || d);
  if (!matches || expired) {
    const used = cur?.podCodeAttempts ?? d.podCodeAttempts + 1;
    await identity.audit(expired && matches ? 'POD_CODE_EXPIRED' : 'POD_WRONG_CODE', { ip, meta: { deliveryId: d.id, partnerId, ...(expired && matches ? { reason: 'EXPIRED' } : {}) } });
    // The attempt that exhausts the budget leaves an auditable event for Admin review (parallel calls that all see the final count may each write one: harmless, never fewer than one).
    const locked = used >= MAX_POD_ATTEMPTS;
    if (locked && used === MAX_POD_ATTEMPTS) await identity.audit('POD_LOCKED', { ip, meta: { deliveryId: d.id, partnerId, attempts: used, needsAdminReview: true } });
    if (locked && used === MAX_POD_ATTEMPTS) require('./opsAlert.service').recipientHandoverFailed({ deliveryId: d.id, why: 'CODE_LOCKED', category: 'LOCKED' }).catch(() => {});   // M16.2.2: tell operations now
    // NEUTRAL (guide §9): wrong, expired and replaced codes read the same, and the message never says how close a guess was or how many tries remain.
    throw err(locked ? LOCKED_MSG : NOT_ACCEPTED_MSG, locked ? 429 : 400, locked ? 'POD_LOCKED' : 'POD_WRONG');
  }
  // Single transition, guarded: only an unverified, unfailed, in-transit delivery of THIS courier, whose code is STILL the one that matched
  // (hash compare-and-swap) and has not expired, can be verified. A rotation that commits in between makes this match nothing.
  const now = new Date();
  const res = await prisma.delivery.updateMany({ where: { id: d.id, partnerId, status: 'IN_TRANSIT', podVerifiedAt: null, failedAt: null, podCodeHash: liveHash, OR: [{ podCodeExpiresAt: null }, { podCodeExpiresAt: { gt: now } }] }, data: { podVerifiedAt: now, podMethod: photoUrl ? 'CODE_PHOTO' : 'CODE', podPhotoUrl: photoUrl || null } });
  if (res.count !== 1) {
    const after = await prisma.delivery.findUnique({ where: { id: d.id } });
    if (after?.podVerifiedAt) return { verified: true, already: true };            // a parallel valid submission won: idempotent
    throw err(NOT_ACCEPTED_MSG, 400, 'POD_WRONG');                                  // the code was rotated/expired under us
  }
  await identity.audit('POD_VERIFIED', { ip, meta: { deliveryId: d.id, partnerId, method: photoUrl ? 'CODE_PHOTO' : 'CODE', codeVersion: cur?.podCodeVersion ?? 1 } });
  return { verified: true, already: false };
}

/** Courier could not hand the parcel over. The parcel returns to the sender. */
async function markFailed({ deliveryId, partnerId, reason, note, photoUrl, ip }) {
  if (!FAIL_REASONS.includes(reason)) throw err('Choose why the delivery failed.', 400, 'FAIL_REASON_REQUIRED');
  if (photoUrl != null && !isStoredDocumentRef(photoUrl)) throw err('Photo evidence must be uploaded through the Runserv app.', 400, 'POD_PHOTO_INVALID');
  const d = await ownedDelivery(deliveryId, partnerId);
  if (!['PICKED_UP', 'IN_TRANSIT'].includes(d.status)) throw err('Only a delivery that is on its way can be marked as failed.', 409, 'BAD_STATUS');
  if (d.podVerifiedAt) throw err('This delivery was already confirmed as delivered.', 409, 'ALREADY_DELIVERED');
  const text = String(note || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').trim().slice(0, 300);
  const res = await prisma.delivery.updateMany({ where: { id: d.id, partnerId, status: { in: ['PICKED_UP', 'IN_TRANSIT'] }, failedAt: null, podVerifiedAt: null }, data: { failedAt: new Date(), failedReason: text ? `${reason}: ${text}` : reason, returnStatus: 'RETURNING', ...(photoUrl ? { podPhotoUrl: photoUrl } : {}) } });
  if (res.count !== 1) throw err('This delivery changed. Please refresh and try again.', 409, 'CONFLICT');
  await identity.audit('DELIVERY_FAILED', { ip, meta: { deliveryId: d.id, partnerId, reason } });
  const fee = failedDeliveryFee({ ...d, failedAt: new Date(), failedReason: reason });
  return { failed: true, returnStatus: 'RETURNING', failedFee: fee.eligible ? { amount: fee.amount, currency: d.currency, share: fee.share, collectFromSender: true } : null, supportReview: !fee.eligible };
}

/**
 * Courier hands the parcel back to the sender. Closes the delivery as CANCELLED (reason kept) and records the return.
 * For a recipient-side failure it ALSO records the part-fee the sender pays the courier in cash, in the SAME transaction as the
 * return (one transition, one payment: Payment.deliveryId is unique, so a repeat can never pay twice).
 */
async function confirmReturned({ deliveryId, partnerId, ip, env = process.env }) {
  const d = await ownedDelivery(deliveryId, partnerId);
  if (!d.failedAt || d.returnStatus !== 'RETURNING') throw err('This delivery is not waiting to be returned.', 409, 'BAD_STATUS');
  const now = new Date();
  const fee = failedDeliveryFee(d, env);
  let paymentId = null;
  await prisma.$transaction(async (tx) => {
    const res = await tx.delivery.updateMany({ where: { id: d.id, partnerId, returnStatus: 'RETURNING' }, data: { returnStatus: 'RETURNED', returnedAt: now, status: 'CANCELLED', cancelledAt: now, cancellationReason: `Failed delivery - returned to sender (${d.failedReason || 'no reason'})` } });
    if (res.count !== 1) throw err('This delivery changed. Please refresh and try again.', 409, 'CONFLICT');
    if (fee.eligible) {
      const pay = await tx.payment.create({ data: { userId: d.customerId, deliveryId: d.id, amount: fee.amount, currency: d.currency, method: 'CASH', status: 'PENDING', transactionId: `DEL-FAILED-${d.id}`, platformFee: fee.platformFee, driverEarnings: fee.courierEarnings } });
      paymentId = pay.id;
    }
  });
  if (paymentId) {
    // Ledger row is non-critical bookkeeping: a failure here is logged and never undoes the return.
    try {
      await require('./commission.service').createCommissionRecord({ paymentId, serviceType: 'DELIVERY', deliveryId: d.id, earnerUserId: partnerId, grossAmount: fee.amount, bookingFee: 0, commissionRate: failedFeeCommissionRate(env), commissionAmount: fee.platformFee, earnerAmount: fee.courierEarnings, surgeMultiplier: 1.0, currency: d.currency });
    } catch (e) { console.error('[pod] commission ledger failed for failed delivery', d.id, e.message); }
  }
  await identity.audit('DELIVERY_RETURNED', { ip, meta: { deliveryId: d.id, partnerId, courierFee: fee.eligible ? fee.amount : 0, supportReview: !fee.eligible } });
  return { returned: true, courierFee: fee.eligible ? { amount: fee.amount, currency: d.currency, collectFromSender: true } : null, supportReview: !fee.eligible };
}

module.exports = { MAX_POD_ATTEMPTS, FAIL_REASONS, RECIPIENT_SIDE_REASONS, FAILED_FEE_SHARE, codeForAllDeliveries, smsRecipientCode, failureReasonCode, isRecipientSide, failedFeeCommissionRate, failedDeliveryFee, proofView, proofPending, verifyProof, markFailed, confirmReturned };
