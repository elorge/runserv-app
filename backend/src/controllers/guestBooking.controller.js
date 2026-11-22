// backend/src/controllers/guestBooking.controller.js — HTTP layer for verified guest booking (see services/guestBooking.service.js).
'use strict';
const identity = require('../services/guestIdentity.service');
const booking = require('../services/guestBooking.service');
const notificationService = require('../services/notification.service');
const { broadcastToDrivers, broadcastToPartners } = require('../services/socket.service');
const fareEngine = require('../utils/fareEngine');
const authController = require('./auth.controller');
const { ensureWallet } = require('../utils/walletHelpers');
const pod = require('../services/proofOfDelivery.service');
const smsOutbox = require('../services/smsOutbox.service');
const emailOutbox = require('../services/emailOutbox.service');
const comms = require('../services/deliveryComms.service');
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');

const ok = (res, data, status = 200) => res.status(status).set('Cache-Control', 'no-store').json({ success: true, data });

/**
 * M16.1: POST /guest/otp/request. A body with `email` is the EMAIL channel (primary); otherwise the PHONE (SMS) channel, which only works
 * while GUEST_SMS_OTP_ENABLED is on. The response is always the safe shape: masked address, timings, never the code (outside development).
 */
exports.requestOtp = async (req, res) => {
  const b = req.body;
  if (b.email) {
    const { _otpId: otpId, ...data } = await identity.requestEmailOtp({ email: b.email, phone: b.phone, countryCode: b.countryCode, ip: req.ip });
    if (otpId) emailOutbox.processForOtp(otpId).catch((e) => console.error('[guest-otp] immediate email send failed:', e.message));   // best effort; the worker retries
    return ok(res, data);
  }
  if (!identity.channelEnabled(identity.CHANNELS.PHONE)) throw Object.assign(new AppError('Phone verification is not available right now. Please use your email address.', 503), { code: 'OTP_CHANNEL_DISABLED' });
  return ok(res, await identity.requestOtp({ phone: b.phone, countryCode: b.countryCode, ip: req.ip }));
};
exports.verifyOtp = async (req, res) => {
  const b = req.body;
  if (b.email) return ok(res, await identity.verifyEmailOtp({ email: b.email, code: b.code, ip: req.ip }));
  if (!identity.channelEnabled(identity.CHANNELS.PHONE)) throw Object.assign(new AppError('Phone verification is not available right now. Please use your email address.', 503), { code: 'OTP_CHANNEL_DISABLED' });
  return ok(res, await identity.verifyOtp({ phone: b.phone, countryCode: b.countryCode, code: b.code, ip: req.ip }));
};

/** Hand the new booking to the live dispatch pool. Contact numbers are NOT broadcast: couriers/drivers see them only after accepting. */
async function dispatch({ io, service, rideId, deliveryId, contactName, pickup, destination, q, parcel, trace }) {
  if (service === 'RIDE') {
    const rate = trace?.commissionRate ?? 0.2;
    const driverEarnings = Math.round(q.fare * (1 - rate));
    broadcastToDrivers(io, 'ride:new_request', {
      rideId, pickupAddress: pickup.address, dropoffAddress: destination.address, estimatedFare: q.fare, bookingFee: trace?.bookingFee ?? 0,
      driverEarnings, platformFee: q.fare - driverEarnings, commissionRate: rate, distance: q.distanceM / 1000, etaMinutes: Math.round(q.durationS / 60),
      surgeMultiplier: trace?.surge ?? 1, surgeLabel: null, paymentMethod: 'CASH', payer: 'SELF', organizationName: null,
      customer: { firstName: contactName, lastName: '', profileImage: null },
    });
    return;
  }
  const settings = await fareEngine.getSettings(q.countryCode);
  const rate = settings?.delivery?.platformCommission ?? 0.2;
  const target = io || notificationService._io;
  broadcastToPartners(target, 'delivery:incoming_request', {
    deliveryId, pickupAddress: pickup.address, dropoffAddress: destination.address, estimatedFee: q.fare, distance: q.distanceM / 1000,
    etaMinutes: Math.ceil(q.distanceM / 1000 / 0.4), packageDescription: `${parcel.category}: ${parcel.description}`, packageWeight: parcel.weightKg,
    payer: 'SELF', organizationName: null, partnerEarnings: Math.round(q.fare * (1 - rate)), proofOfDeliveryRequired: true,
    customer: { firstName: contactName, profileImage: null },
  });
}

exports.create = async (req, res) => {
  const io = req.app.get('io');
  const result = await booking.createBooking({ guest: req.guest, idempotencyKey: req.get('Idempotency-Key'), body: req.body, ip: req.ip, io, dispatch });
  // Queued inside the booking transaction; try to deliver now (best effort). The worker retries anything that fails.
  // Both channels are tried independently (M16.2); one failing never blocks the other.
  if (!result.replayed) comms.dispatchBooking(result.booking.id).catch((e) => console.error('[guest-booking] immediate notification failed:', e.message));
  return ok(res, result, result.replayed ? 200 : 201);
};
exports.list = async (req, res) => ok(res, { bookings: await booking.listOwnBookings({ guest: req.guest }) });
exports.get = async (req, res) => {
  const data = await booking.getOwnBooking({ guest: req.guest, bookingId: req.params.id });
  // Delivery state only; never the number, the address or the text. `recipientEmail`/`recipientSms`: DISABLED | NOT_PROVIDED | QUEUED | RETRYING | ACCEPTED | DELIVERED | FAILED | SKIPPED.
  let notices = await smsOutbox.noticesFor(req.params.id).catch(() => ({}));
  if (data.booking.service === 'PARCEL') {
    const b = await prisma.guestBooking.findUnique({ where: { id: req.params.id } });
    const d = b?.deliveryId ? await prisma.delivery.findUnique({ where: { id: b.deliveryId } }) : null;
    if (b && d) notices = { ...notices, ...(await comms.senderNotices({ booking: b, delivery: d }).catch(() => ({}))) };
  }
  return ok(res, { ...data, notices });
};
exports.cancel = async (req, res) => ok(res, await booking.cancelBooking({ guest: req.guest, bookingId: req.params.id, reason: req.body?.reason, ip: req.ip, io: req.app.get('io') }));
exports.rotateTracking = async (req, res) => ok(res, await booking.rotateTracking({ guest: req.guest, bookingId: req.params.id, ip: req.ip }));
exports.revokeTracking = async (req, res) => ok(res, await booking.revokeTracking({ guest: req.guest, bookingId: req.params.id, ip: req.ip }));

exports.convert = async (req, res) => {
  const { user, verifyToken } = await booking.convertToAccount({ guest: req.guest, ...req.body, ip: req.ip, ensureWallet });
  if (process.env.ENABLE_EMAIL_VERIFICATION === 'true') {
    try { await require('../services/email.service').sendVerificationEmail(user.email, user.firstName, verifyToken); } catch (e) { console.error('[guest-convert] verification email failed:', e.message); }
  }
  const token = authController.generateToken(user.id);
  return ok(res, { user, token, message: 'Your account is ready. Your previous bookings are in your history.' });
};

/** PUBLIC (no session): the tracking link. Uniform 404 for anything that is not a live token. */
exports.track = async (req, res) => {
  const view = await booking.trackByToken({ token: req.params.token, ip: req.ip, env: process.env });
  res.set({ 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
  return ok(res, view);
};

exports._test = { dispatch };
