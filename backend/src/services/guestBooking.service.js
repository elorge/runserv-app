// backend/src/services/guestBooking.service.js
//
// Stages 3-5 of the guest-booking plan: CONFIRMATION, TRACKING and ACCOUNT CONVERSION for a phone-verified guest.
//
// What keeps this safe (guide §4.1):
//   * the authenticated ride/delivery routes are untouched; a guest acts only through a GuestSession (see guestIdentity.service);
//   * the price is the SERVER-signed quote (bound to the exact pickup, destination, parcel; 10-minute expiry; single use). A fare in
//     the request body is never read;
//   * Idempotency-Key + unique (identity, key) so a double-tap, retry or app restart returns the same booking, never a second one;
//   * ride/delivery + GuestBooking are written in ONE transaction (no orphans);
//   * tracking uses a 256-bit token derived from a per-booking nonce, stored only as a hash, scoped to one booking, expiring and
//     revocable, and the public view carries no phone numbers, no personal data and no internal driver fields;
//   * guests pay CASH only (no wallet, no card, no stored value), one active booking at a time, a daily cap per number.
'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const guestQuote = require('./guestQuote.service');
const identity = require('./guestIdentity.service');
const tracking = require('./tracking.service');
const comms = require('./deliveryComms.service');
const podCode = require('./podCode.service');
const fareEngine = require('../utils/fareEngine');
const { isCategoryEnabled } = require('../utils/vehicleCategories');
const { COUNTRY_CENTERS } = require('../utils/countryGeo');
const { checkPhoneForCountry } = require('../utils/phone');

const CFG = {
  TRACKING_TTL_MS: 24 * 60 * 60 * 1000,        // default lifetime of a tracking link; GUEST_TRACKING_TTL_HOURS overrides it (see trackingPolicy)
  TRACKING_MAX_MS: 72 * 60 * 60 * 1000,        // hard ceiling from booking time; GUEST_TRACKING_MAX_HOURS overrides it
  MAX_BOOKINGS_PER_DAY: 5,
  POD_CODE_LENGTH: 6,
};
const ACTIVE_RIDE = ['REQUESTED', 'ACCEPTED', 'ARRIVED', 'IN_PROGRESS'];
const ACTIVE_DELIVERY = ['PENDING', 'ASSIGNED', 'PICKED_UP', 'IN_TRANSIT'];
/** Tracking-link lifetime policy (action plan P1.5). The link lives TTL from creation and, while the booking is still ACTIVE, slides forward when it
 *  is opened close to its end, but never past MAX from the booking time. A finished booking's link is never extended. Rotation/revocation still end it at once. */
const hours = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 && n <= 24 * 14 ? n * 3600 * 1000 : d; };
const trackingPolicy = (env = process.env) => ({ ttlMs: hours(env.GUEST_TRACKING_TTL_HOURS, CFG.TRACKING_TTL_MS), maxMs: Math.max(hours(env.GUEST_TRACKING_MAX_HOURS, CFG.TRACKING_MAX_MS), hours(env.GUEST_TRACKING_TTL_HOURS, CFG.TRACKING_TTL_MS)) });
const TERMINAL = ['CANCELLED', 'COMPLETED', 'DELIVERED', 'RETURNED_TO_SENDER'];
const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';           // no 0/O/1/I/L: readable over the phone

const err = (message, status, code, extra = {}) => Object.assign(new AppError(message, status), { code, ...extra });
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const newReference = () => `RS-${Array.from({ length: 6 }, () => REF_ALPHABET[crypto.randomInt(0, REF_ALPHABET.length)]).join('')}`;

// ── Tracking token: HMAC(secret, bookingId:nonce). 256-bit, never stored, re-derivable for the owner, revocable by rotating the nonce.
const deriveTrackingToken = (bookingId, nonce, env = process.env) => `gt_${crypto.createHmac('sha256', `guest-track:${identity.hashSecret(env)}`).update(`${bookingId}:${nonce}`).digest('base64url')}`;
const TRACK_RE = /^gt_[A-Za-z0-9_-]{43}$/;
const trackingUrl = (token, env = process.env) => `${String(env.GUEST_TRACKING_BASE_URL || '').replace(/\/+$/, '')}/${token}`.replace(/^\//, '');

// ── Proof-of-delivery code. M16.2.1: the lifecycle (random nonce, keyed hash, expiry, rotation) lives in podCode.service. These names stay exported
// because registered-sender deliveries (POD_CODE_ALL_DELIVERIES, outside the guest pilot) still use the legacy derivation.
const podHash = (deliveryId, code, env = process.env) => podCode.podHash(deliveryId, code, env);
const podCodeFor = (deliveryId, env = process.env) => podCode.legacyCode(deliveryId, env);

/** Canonical request fingerprint, so the same Idempotency-Key with a DIFFERENT request is refused instead of silently replayed. */
const requestHash = ({ quoteId, pickup, destination, contactName, notes, parcel }) => sha256(JSON.stringify([
  quoteId, guestQuote.coordKey(pickup), guestQuote.coordKey(destination), clean(pickup?.address, 200), clean(destination?.address, 200),
  clean(contactName, 40), clean(notes, 300),
  parcel ? [clean(parcel.category, 20), Number(parcel.weightKg) || 0, Number(parcel.longestSideCm) || 0, clean(parcel.description, 200), clean(parcel.recipientName, 60), clean(parcel.recipientPhone, 20), ...(clean(parcel.recipientEmail, 254) ? [clean(parcel.recipientEmail, 254).toLowerCase()] : [])] : null,
]));

const publicStatus = (service, row) => {
  if (service === 'RIDE') return ({ REQUESTED: 'FINDING_DRIVER', ACCEPTED: 'DRIVER_ASSIGNED', ARRIVED: 'DRIVER_ARRIVED', IN_PROGRESS: 'IN_PROGRESS', COMPLETED: 'COMPLETED', CANCELLED: 'CANCELLED' })[row.status] || row.status;
  if (row.failedAt && row.returnStatus === 'RETURNED') return 'RETURNED_TO_SENDER';
  if (row.failedAt) return 'DELIVERY_FAILED_RETURNING';
  return ({ PENDING: 'FINDING_COURIER', ASSIGNED: 'COURIER_ASSIGNED', PICKED_UP: 'PARCEL_PICKED_UP', IN_TRANSIT: 'IN_TRANSIT', DELIVERED: 'DELIVERED', CANCELLED: 'CANCELLED' })[row.status] || row.status;
};
/** May the guest still cancel themselves? Only before a driver/courier has accepted; after that, support handles it. */
const isCancellable = (service, row) => (service === 'RIDE' ? row.status === 'REQUESTED' : row.status === 'PENDING');

/** Revalidate everything about the request that the signature alone cannot prove. Returns the validated pieces. */
function validateConfirmation({ guest, body, now = Date.now(), env = process.env }) {
  if (!guestQuote.bookingEnabled(env)) throw err('Guest booking is not available yet.', 404, 'GUEST_BOOKING_DISABLED');
  const q = body?.quote;
  if (!q || typeof q !== 'object') throw err('A quote is required.', 400, 'QUOTE_REQUIRED');
  const v = guestQuote.verifyQuote(q, { now, env });
  if (!v.ok) {
    if (v.reason === 'EXPIRED') throw err('This price has expired. Please get a new quote.', 410, 'QUOTE_EXPIRED');
    throw err('This quote is not valid. Please get a new quote.', 400, 'QUOTE_INVALID');
  }
  const pickup = body.pickup; const destination = body.destination;
  if (guestQuote.coordKey(pickup) !== q.pickupKey || guestQuote.coordKey(destination) !== q.destKey) throw err('The locations changed since this quote. Please get a new quote.', 409, 'QUOTE_LOCATION_MISMATCH');
  if (!clean(pickup?.address, 200) || !clean(destination?.address, 200)) throw err('Pickup and destination addresses are required.', 400, 'ADDRESS_REQUIRED');
  const cc = String(q.countryCode || '').toUpperCase();
  if (!COUNTRY_CENTERS[cc] || cc !== guest.countryCode) throw err('This quote is for a different country than your verified number.', 409, 'COUNTRY_MISMATCH');
  if (!isCategoryEnabled(q.vehicleType, env)) throw err('That vehicle type is not available right now. Please choose another.', 409, 'VEHICLE_UNAVAILABLE');
  if (!guestQuote.SERVICES.includes(q.service)) throw err('Unknown service.', 400, 'BAD_SERVICE');

  let parcel = null;
  if (q.service === 'PARCEL') {
    const p = body.parcel || {};
    if (guestQuote.parcelKey(p) !== q.parcelKey) throw err('The parcel details changed since this quote. Please get a new quote.', 409, 'QUOTE_PARCEL_MISMATCH');
    if (!guestQuote.PARCEL_CATEGORIES.includes(String(p.category || '').toUpperCase())) throw err('Choose a parcel category.', 400, 'PARCEL_CATEGORY_REQUIRED');
    const elig = guestQuote.parcelEligibility({ vehicleType: q.vehicleType, category: String(p.category).toUpperCase(), weightKg: p.weightKg, longestSideCm: p.longestSideCm });
    if (!elig.ok) throw err(elig.message, 422, `PARCEL_${elig.reason}`);
    if (!(Number(p.weightKg) > 0)) throw err('Enter the parcel weight.', 400, 'PARCEL_WEIGHT_REQUIRED');
    if (p.acknowledgedProhibited !== true) throw err('Please confirm the parcel contains no prohibited items.', 400, 'PROHIBITED_ACK_REQUIRED');
    const description = clean(p.description, 200); const recipientName = clean(p.recipientName, 60); const recipientPhone = clean(p.recipientPhone, 20).replace(/[^\d+]/g, '');
    if (description.length < 3) throw err('Describe the parcel (what it is).', 400, 'PARCEL_DESCRIPTION_REQUIRED');
    if (recipientName.length < 2) throw err('Enter the recipient name.', 400, 'RECIPIENT_NAME_REQUIRED');
    const rp = checkPhoneForCountry(recipientPhone, cc);
    if (!rp.ok) throw err(`Recipient phone: ${rp.reason}`, 400, 'RECIPIENT_PHONE_INVALID');
    // M16.2: the recipient's email carries the hand-over code and tracking link. Mandatory while email is the only delivery channel (pilot).
    const recipientEmail = comms.parseRecipientEmail(p.recipientEmail);
    if (!recipientEmail && comms.recipientEmailRequired(env)) throw err('Enter the recipient\'s email address. The hand-over code is sent there.', 400, 'RECIPIENT_EMAIL_REQUIRED');
    parcel = { category: String(p.category).toUpperCase(), weightKg: Number(p.weightKg), longestSideCm: p.longestSideCm == null ? null : Number(p.longestSideCm), description, recipientName, recipientPhone, recipientEmail };
  }
  return { q, pickup, destination, parcel, cc };
}

/** Create the booking. Returns { booking, replayed, tracking, pod? }. `dispatch` is injected so tests (and the controller) own sockets. */
async function createBooking({ guest, idempotencyKey, body, ip, io, now = Date.now(), env = process.env, dispatch = null }) {
  if (!guestQuote.bookingEnabled(env)) throw err('Guest booking is not available yet.', 404, 'GUEST_BOOKING_DISABLED');
  if (!/^[A-Za-z0-9._:-]{8,64}$/.test(String(idempotencyKey || ''))) throw err('An Idempotency-Key header (8-64 characters) is required.', 400, 'IDEMPOTENCY_KEY_REQUIRED');
  const contactName = clean(body?.contactName, 40) || 'Guest';
  const notes = clean(body?.notes, 300) || null;
  const fingerprint = requestHash({ quoteId: body?.quote?.id, pickup: body?.pickup, destination: body?.destination, contactName, notes, parcel: body?.parcel });

  // Replay (double tap / retry / restart) is answered BEFORE any quote checks, so a retry after the quote's 10 minutes still gets
  // the original booking. Same key + same request returns it; same key + a different request is refused.
  const prior = await prisma.guestBooking.findUnique({ where: { identityId_idempotencyKey: { identityId: guest.identityId, idempotencyKey } } });
  if (prior) {
    if (prior.requestHash !== fingerprint) throw err('That Idempotency-Key was already used for a different request.', 409, 'IDEMPOTENCY_MISMATCH');
    return { ...(await present(prior, { env })), replayed: true };
  }

  const { q, pickup, destination, parcel, cc } = validateConfirmation({ guest, body, now, env });

  const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
  const recent = await prisma.guestBooking.count({ where: { identityId: guest.identityId, createdAt: { gte: dayAgo } } });
  if (recent >= CFG.MAX_BOOKINGS_PER_DAY) { await identity.audit('BOOKING_DAILY_LIMIT', { identityId: guest.identityId, ip }); throw err('Daily guest booking limit reached. Create an account to keep booking.', 429, 'GUEST_DAILY_LIMIT'); }

  // Fare calculation trace for support (the PRICE is still the signed quote; this records what the rate card says right now).
  const trace = await fareTrace(q, cc).catch(() => null);

  const bookingId = crypto.randomUUID();
  const nonce = crypto.randomBytes(16).toString('hex');
  const token = deriveTrackingToken(bookingId, nonce, env);
  const distanceKm = q.distanceM / 1000;
  const common = { pickupLat: Number(pickup.latitude), pickupLng: Number(pickup.longitude), dropoffLat: Number(destination.latitude), dropoffLng: Number(destination.longitude), distance: distanceKm, currency: q.currency, paymentMethod: 'CASH', notes };
  const pick = tracking.sanitizePickup({ pickupSource: pickup.source, pickupAccuracy: pickup.accuracyM, pickupCapturedAt: pickup.capturedAt }, now);

  let rideId = null; let deliveryId = null; let issued = null; let queued = {};
  const reference = newReference();
  try {
    await prisma.$transaction(async (tx) => {
      // One active booking per guest, race-safe: serialise this guest's confirmations, then check inside the same transaction.
      if (typeof tx.$executeRaw === 'function') await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${guest.userId}))`;
      const [aRide, aDel] = await Promise.all([
        tx.ride.findFirst({ where: { customerId: guest.userId, status: { in: ACTIVE_RIDE } }, select: { id: true } }),
        tx.delivery.findFirst({ where: { customerId: guest.userId, status: { in: ACTIVE_DELIVERY } }, select: { id: true } }),
      ]);
      if (aRide || aDel) throw err('You already have an active booking. Track it or wait for it to finish.', 409, 'ACTIVE_BOOKING_EXISTS');
      await tx.user.update({ where: { id: guest.userId }, data: { firstName: contactName } });          // what the driver sees
      if (q.service === 'RIDE') {
        const ride = await tx.ride.create({ data: { customerId: guest.userId, pickupAddress: clean(pickup.address, 200), dropoffAddress: clean(destination.address, 200), ...common, ...pick, duration: Math.round(q.durationS / 60), estimatedFare: q.fare, status: 'REQUESTED' } });
        rideId = ride.id;
      } else {
        deliveryId = crypto.randomUUID(); issued = podCode.generate(deliveryId, { now, env });
        await tx.delivery.create({ data: { id: deliveryId, customerId: guest.userId, pickupAddress: clean(pickup.address, 200), dropoffAddress: clean(destination.address, 200), ...common, ...pick, pickupContact: guest.phone, dropoffContact: parcel.recipientPhone, packageDescription: `${parcel.category}: ${parcel.description}`, packageWeight: parcel.weightKg, estimatedFee: q.fare, podCodeHash: issued.hash, podCodeNonce: issued.nonce, podCodeVersion: 1, podCodeExpiresAt: issued.expiresAt, podNotifyReservedAt: new Date(now), status: 'PENDING', recipientName: parcel.recipientName, recipientEmail: parcel.recipientEmail || null } });
      }
      await tx.guestBooking.create({ data: { id: bookingId, reference, identityId: guest.identityId, service: q.service, rideId, deliveryId, idempotencyKey, requestHash: fingerprint, quoteId: q.id, fare: q.fare, currency: q.currency, vehicleType: q.vehicleType, trackingTokenHash: sha256(token), trackingNonce: nonce, trackingExpiresAt: new Date(now + trackingPolicy(env).ttlMs), quoteSnapshot: { quote: q, trace } } });
      // M16/M16.2: notifications are queued in the SAME transaction (hand-over code + tracking link -> RECIPIENT, tracking link -> sender),
      // on every enabled channel independently. A worker delivers with retry; nothing here stores a code or a message.
      queued = await comms.enqueueBookingTx(tx, { bookingId, service: q.service, guest, parcel, countryCode: cc, env });
    });
  } catch (e) {
    if (e?.code === 'P2002') {
      const t = String(e.meta?.target || '');
      if (/quoteId/.test(t)) throw err('This quote was already used. Please get a new quote.', 409, 'QUOTE_ALREADY_USED');
      if (/idempotencyKey/.test(t)) {                                           // a concurrent retry won the race: return its booking
        const won = await prisma.guestBooking.findUnique({ where: { identityId_idempotencyKey: { identityId: guest.identityId, idempotencyKey } } });
        if (won && won.requestHash === fingerprint) return { ...(await present(won, { env })), replayed: true };
        throw err('That Idempotency-Key was already used for a different request.', 409, 'IDEMPOTENCY_MISMATCH');
      }
    }
    throw e;
  }

  await identity.audit('BOOKING_CREATED', { identityId: guest.identityId, bookingId, ip, meta: { reference, service: q.service, vehicleType: q.vehicleType, fare: q.fare, currency: q.currency } });
  if (deliveryId) await identity.audit('POD_CODE_CREATED', { identityId: guest.identityId, bookingId, ip, meta: { deliveryId } });
  if (Object.values(queued).some(Boolean)) await identity.audit('DELIVERY_NOTIFICATION_QUEUED', { identityId: guest.identityId, bookingId, ip, meta: { channels: Object.keys(queued).filter((k) => queued[k]) } });
  // Dispatch AFTER the commit, best effort: the booking exists whether or not a socket emit succeeds (the queue/poll also finds it).
  try { if (dispatch) await dispatch({ io, service: q.service, rideId, deliveryId, guest, contactName, pickup, destination, q, parcel, trace, env }); }
  catch (e) { console.error('[guest-booking] dispatch emit failed for', reference, e.message); }

  const row = await prisma.guestBooking.findUnique({ where: { id: bookingId } });
  return { ...(await present(row, { env, podCode: issued?.code })), replayed: false, queued };
}

async function fareTrace(q, cc) {
  const km = q.distanceM / 1000;
  if (q.service === 'RIDE') {
    const f = await fareEngine.estimateFare(km, q.vehicleType, new Date(), 1.0, q.currency, cc);
    return { kind: 'RIDE', distanceKm: km, rateCardFare: f.estimatedFare, quotedFare: q.fare, baseFare: f.baseFare, distanceCharge: f.distanceCharge, timeCharge: f.timeCharge, bookingFee: f.bookingFee, surge: f.surgeMultiplier, commissionRate: f.commissionRate };
  }
  const f = await fareEngine.calculateDeliveryFee(km, 0, q.currency, cc);
  return { kind: 'PARCEL', distanceKm: km, quotedFare: q.fare, baseFee: f.baseFee, distanceCharge: f.distanceCharge, note: 'Weight charge applied at quote time from the sender\'s stated weight.' };
}

/** What the guest (the owner, holding a session) sees about a booking. Tracking token is re-derived, never stored. */
async function present(b, { env = process.env, podCode: knownCode } = {}) {
  const token = deriveTrackingToken(b.id, b.trackingNonce, env);
  // M16.2: the code is shown to the sender only when no recipient channel carries it (deliveryComms.senderMayViewCode).
  let showCode = false; let dlv = null;
  if (b.service === 'PARCEL' && b.deliveryId) {
    dlv = await prisma.delivery.findUnique({ where: { id: b.deliveryId } });
    showCode = comms.senderMayViewCode({ recipientEmail: dlv?.recipientEmail }, env);
  }
  return {
    booking: { id: b.id, reference: b.reference, service: b.service, vehicleType: b.vehicleType, fare: Number(b.fare), currency: b.currency, createdAt: b.createdAt },
    tracking: { token, url: trackingUrl(token, env), expiresAt: b.trackingExpiresAt, revoked: !!b.trackingRevokedAt },
    ...(showCode ? { podCode: knownCode || (dlv ? require('./podCode.service').codeFor(dlv, env) : podCodeFor(b.deliveryId, env)) } : {}),
    ...(b.service === 'PARCEL' && b.deliveryId ? { podCodeVisible: showCode } : {}),
  };
}

/** The owner's list/detail view (session required). Includes the delivery code so the sender can give it to the recipient. */
async function getOwnBooking({ guest, bookingId, env = process.env }) {
  const b = await prisma.guestBooking.findUnique({ where: { id: bookingId } });
  if (!b || b.identityId !== guest.identityId) throw err('Booking not found.', 404, 'NOT_FOUND');       // same answer for "not yours" and "does not exist"
  const view = await publicView(b, { env });
  return { ...(await present(b, { env })), status: view.status, view };
}

async function listOwnBookings({ guest, env = process.env }) {
  const rows = await prisma.guestBooking.findMany({ where: { identityId: guest.identityId }, orderBy: { createdAt: 'desc' }, take: 20 });
  return Promise.all(rows.map(async (b) => { const v = await publicView(b, { env }); return { id: b.id, reference: b.reference, service: b.service, status: v.status, fare: Number(b.fare), currency: b.currency, createdAt: b.createdAt, pickupAddress: v.pickupAddress, dropoffAddress: v.dropoffAddress }; }));
}

/** The limited, scoped, personal-data-free view used by the tracking link (and by the owner's status screen). */
async function publicView(b, { now = Date.now(), env = process.env } = {}) {
  const isRide = b.service === 'RIDE';
  const row = isRide
    ? await prisma.ride.findUnique({ where: { id: b.rideId }, select: { status: true, pickupAddress: true, dropoffAddress: true, requestedAt: true, acceptedAt: true, arrivedAt: true, startedAt: true, completedAt: true, cancelledAt: true, cancellationReason: true, driverId: true, pickupLat: true, pickupLng: true, dropoffLat: true, dropoffLng: true } })
    : await prisma.delivery.findUnique({ where: { id: b.deliveryId }, select: { status: true, pickupAddress: true, dropoffAddress: true, requestedAt: true, assignedAt: true, pickedUpAt: true, inTransitAt: true, deliveredAt: true, cancelledAt: true, cancellationReason: true, partnerId: true, failedAt: true, failedReason: true, returnStatus: true, podVerifiedAt: true, recipientName: true, estimatedFee: true, currency: true, payerType: true, pickupLat: true, pickupLng: true, dropoffLat: true, dropoffLng: true } });
  if (!row) return { status: 'UNKNOWN' };
  const status = publicStatus(b.service, row);
  // Part-fee owed in cash when a parcel comes back because of a recipient-side failure (lazy require: proofOfDelivery imports this module).
  const failedFee = isRide ? { eligible: false } : require('./proofOfDelivery.service').failedDeliveryFee(row, env);
  const earnerId = isRide ? row.driverId : row.partnerId;
  let earner = null;
  if (earnerId && !['CANCELLED', 'COMPLETED', 'DELIVERED', 'RETURNED_TO_SENDER'].includes(status)) {
    const [u, p] = await Promise.all([
      prisma.user.findUnique({ where: { id: earnerId }, select: { firstName: true } }),
      (isRide ? prisma.driverProfile : prisma.deliveryPartnerProfile).findUnique({ where: { userId: earnerId }, select: isRide ? { vehicleMake: true, vehicleModel: true, vehicleColor: true, vehiclePlate: true, rating: true, currentLat: true, currentLng: true, lastLocationAt: true } : { vehicleType: true, vehiclePlate: true, rating: true, currentLat: true, currentLng: true, lastLocationAt: true } }),
    ]);
    // Only a first name, the vehicle, and a position rounded to ~110 m, shown only while fresh. No phone, no email, no ids, no documents.
    earner = u && p ? { firstName: u.firstName, rating: p.rating || null, vehicle: isRide ? { make: p.vehicleMake, model: p.vehicleModel, color: p.vehicleColor, plate: p.vehiclePlate } : { type: p.vehicleType, plate: p.vehiclePlate }, location: tracking.isFresh(p.lastLocationAt, now) && p.currentLat != null ? { lat: tracking.approx(p.currentLat), lng: tracking.approx(p.currentLng), at: p.lastLocationAt } : null } : null;
  }
  const timeline = isRide
    ? { requestedAt: row.requestedAt, acceptedAt: row.acceptedAt, arrivedAt: row.arrivedAt, startedAt: row.startedAt, completedAt: row.completedAt, cancelledAt: row.cancelledAt }
    : { requestedAt: row.requestedAt, assignedAt: row.assignedAt, pickedUpAt: row.pickedUpAt, inTransitAt: row.inTransitAt, deliveredAt: row.deliveredAt, cancelledAt: row.cancelledAt, failedAt: row.failedAt };
  return {
    reference: b.reference, service: b.service, status, vehicleType: b.vehicleType, fare: Number(b.fare), currency: b.currency,
    pickupAddress: row.pickupAddress, dropoffAddress: row.dropoffAddress,
    pickup: { lat: row.pickupLat, lng: row.pickupLng }, dropoff: { lat: row.dropoffLat, lng: row.dropoffLng },
    earner, timeline, cancellable: isCancellable(b.service, row),
    cancellationReason: row.cancellationReason || null,
    ...(isRide ? {} : { delivery: { recipientFirstName: String(row.recipientName || '').split(' ')[0] || null, proofVerified: !!row.podVerifiedAt, failedReason: row.failedReason || null, returnStatus: row.returnStatus || null, ...(failedFee.eligible ? { failedFee: { amount: failedFee.amount, currency: row.currency || b.currency } } : {}) } }),
    paymentNote: failedFee.eligible
      ? 'The delivery could not be completed and the parcel is coming back to you. Please pay the courier the return fee shown, in cash, when you receive it.'
      : (row.failedAt ? 'The delivery could not be completed. Runserv support will contact you about any charge.' : (isRide ? 'Pay your driver in cash at the end of the trip.' : 'Pay your courier in cash as agreed when the parcel is collected.')),
  };
}

/** Public-link address: the street/house line is dropped, the area stays ("12 Allen Avenue, Ikeja, Lagos" -> "Ikeja, Lagos"). One segment -> hidden. */
function maskAddress(addr) {
  const parts = String(addr || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return parts.length ? 'Address hidden' : '';
  return parts.slice(1).join(', ').slice(0, 80);
}
const coarse = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) / 100 : null);   // ~1.1 km: enough for a map pin of the area, not a doorstep

/**
 * M16.2.1 (P1.5): what the PUBLIC tracking link may show, derived from the owner's view by REMOVING things (never by adding). No street address, no
 * doorstep coordinates, no recipient name, no fare or payment text, no courier free text. The owner's own screen keeps the full publicView.
 */
function toPublicTrackingView(v) {
  const out = {
    reference: v.reference, service: v.service, status: v.status, vehicleType: v.vehicleType,
    pickupAddress: maskAddress(v.pickupAddress), dropoffAddress: maskAddress(v.dropoffAddress),
    pickup: { lat: coarse(v.pickup?.lat), lng: coarse(v.pickup?.lng) }, dropoff: { lat: coarse(v.dropoff?.lat), lng: coarse(v.dropoff?.lng) },
    earner: v.earner, timeline: v.timeline, cancellable: false,   // the public link can never cancel: only the owner's session can
    cancellationReason: v.status === 'CANCELLED' ? 'This booking was cancelled.' : null,
  };
  if (v.service === 'PARCEL') {
    const reasonCode = String(v.delivery?.failedReason || '').split(':')[0].trim();
    out.delivery = { proofVerified: !!v.delivery?.proofVerified, failedReason: reasonCode || null, returnStatus: v.delivery?.returnStatus || null };
  }
  return out;
}

// Per-process throttle for the access audit (a poll every few seconds must not write a row every few seconds).
const lastTrackAudit = new Map();
/** Public tracking by token. One uniform 404 for unknown / malformed / expired / revoked so tokens can't be probed. */
async function trackByToken({ token, ip, now = Date.now(), env = process.env }) {
  const notFound = () => err('This tracking link is not valid or has expired.', 404, 'TRACKING_NOT_FOUND');
  if (!TRACK_RE.test(String(token || ''))) throw notFound();
  const b = await prisma.guestBooking.findUnique({ where: { trackingTokenHash: sha256(token) } });
  if (!b) throw notFound();
  // Constant-time confirm against the derived token (defence in depth beyond the hash lookup).
  if (!identity.safeEqualHex(sha256(deriveTrackingToken(b.id, b.trackingNonce, env)), sha256(token))) throw notFound();
  if (b.trackingRevokedAt || now >= new Date(b.trackingExpiresAt).getTime()) throw notFound();
  const last = lastTrackAudit.get(b.id) || 0;
  if (now - last > 10 * 60 * 1000) { lastTrackAudit.set(b.id, now); if (lastTrackAudit.size > 5000) lastTrackAudit.clear(); await identity.audit('TRACKING_VIEWED', { bookingId: b.id, identityId: b.identityId, ip }); }
  const view = await publicView(b, { now, env });
  // Active parcel/ride, link close to its end: slide the expiry forward (bounded by the policy ceiling) so a long delivery never loses its link.
  // A finished booking is never extended. The token itself is unchanged, so links already sent keep working.
  if (!TERMINAL.includes(view.status)) {
    const pol = trackingPolicy(env); const ceiling = new Date(b.createdAt).getTime() + pol.maxMs; const exp = new Date(b.trackingExpiresAt).getTime();
    const target = Math.min(now + pol.ttlMs, ceiling);
    if (exp - now < pol.ttlMs / 4 && target > exp) {
      const r = await prisma.guestBooking.updateMany({ where: { id: b.id, trackingRevokedAt: null, trackingExpiresAt: new Date(b.trackingExpiresAt) }, data: { trackingExpiresAt: new Date(target) } });
      if (r.count === 1) await identity.audit('TRACKING_EXTENDED', { bookingId: b.id, identityId: b.identityId, ip, meta: { until: new Date(target).toISOString() } });
    }
  }
  return toPublicTrackingView(view);
}

/** Replace the tracking link (e.g. it was shared by mistake). The old link stops working at once. */
async function rotateTracking({ guest, bookingId, ip, now = Date.now(), env = process.env }) {
  const b = await prisma.guestBooking.findUnique({ where: { id: bookingId } });
  if (!b || b.identityId !== guest.identityId) throw err('Booking not found.', 404, 'NOT_FOUND');
  const nonce = crypto.randomBytes(16).toString('hex');
  const token = deriveTrackingToken(b.id, nonce, env);
  const upd = await prisma.guestBooking.update({ where: { id: b.id }, data: { trackingNonce: nonce, trackingTokenHash: sha256(token), trackingRevokedAt: null, trackingExpiresAt: new Date(now + trackingPolicy(env).ttlMs) } });
  await identity.audit('TRACKING_ROTATED', { identityId: guest.identityId, bookingId: b.id, ip });
  return present(upd, { env });
}

async function revokeTracking({ guest, bookingId, ip, now = Date.now() }) {
  const b = await prisma.guestBooking.findUnique({ where: { id: bookingId } });
  if (!b || b.identityId !== guest.identityId) throw err('Booking not found.', 404, 'NOT_FOUND');
  await prisma.guestBooking.update({ where: { id: b.id }, data: { trackingRevokedAt: new Date(now) } });
  await identity.audit('TRACKING_REVOKED', { identityId: guest.identityId, bookingId: b.id, ip });
  return { revoked: true };
}

/** Guest cancels. Only before assignment (atomic status guard); later cancellations go through support. */
async function cancelBooking({ guest, bookingId, reason, ip, io, now = Date.now() }) {
  const b = await prisma.guestBooking.findUnique({ where: { id: bookingId } });
  if (!b || b.identityId !== guest.identityId) throw err('Booking not found.', 404, 'NOT_FOUND');
  const why = clean(reason, 200) || 'Cancelled by guest';
  const res = b.service === 'RIDE'
    ? await prisma.ride.updateMany({ where: { id: b.rideId, status: 'REQUESTED' }, data: { status: 'CANCELLED', cancelledAt: new Date(now), cancellationReason: why } })
    : await prisma.delivery.updateMany({ where: { id: b.deliveryId, status: 'PENDING' }, data: { status: 'CANCELLED', cancelledAt: new Date(now), cancellationReason: why } });
  if (res.count !== 1) throw err('This booking can no longer be cancelled here because it has been accepted or has finished. Please contact support with your reference.', 409, 'NOT_CANCELLABLE', { reference: b.reference });
  await identity.audit('BOOKING_CANCELLED', { identityId: guest.identityId, bookingId: b.id, ip, meta: { reference: b.reference } });
  try { if (io) io.to(b.service === 'RIDE' ? `ride:${b.rideId}` : `delivery:${b.deliveryId}`).emit(b.service === 'RIDE' ? 'ride:cancelled' : 'delivery:cancelled', { [b.service === 'RIDE' ? 'rideId' : 'deliveryId']: b.rideId || b.deliveryId, reason: why }); } catch { /* best effort */ }
  return { cancelled: true, reference: b.reference };
}

/**
 * Turn the guest into a registered customer. The SAME User row is upgraded, so past bookings follow automatically, and only the holder
 * of a fresh phone-verified session can do it: the number is already proven, so there is nothing to take over.
 */
async function convertToAccount({ guest, email, password, firstName, lastName, ip, env = process.env, ensureWallet }) {
  const ident = await prisma.guestIdentity.findUnique({ where: { id: guest.identityId } });
  if (!ident || ident.convertedAt) throw err('This number already has an account. Please sign in.', 409, 'ALREADY_CONVERTED');
  const addr = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(addr) || addr.endsWith('.invalid')) throw err('Enter a valid email address.', 400, 'INVALID_EMAIL');
  if (String(password || '').length < 8) throw err('Choose a password of at least 8 characters.', 400, 'WEAK_PASSWORD');
  const taken = await prisma.user.findFirst({ where: { email: addr, NOT: { id: guest.userId } }, select: { id: true } });
  if (taken) throw err('That email is already registered. Please sign in instead.', 409, 'EMAIL_TAKEN');
  const hashed = await bcrypt.hash(String(password), 10);
  const verifyToken = crypto.randomBytes(32).toString('hex');
  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.update({
      where: { id: guest.userId },
      data: { email: addr, password: hashed, authProvider: 'PASSWORD', firstName: clean(firstName, 60) || 'Customer', lastName: clean(lastName, 60) || '-', emailVerifyToken: sha256(verifyToken), emailVerifyExpires: new Date(Date.now() + 24 * 60 * 60 * 1000), passwordChangedAt: new Date() },
      select: { id: true, email: true, phone: true, firstName: true, lastName: true, role: true, countryCode: true },
    });
    await tx.guestIdentity.update({ where: { id: guest.identityId }, data: { convertedAt: new Date() } });
    return u;
  });
  await identity.revokeAllSessions(guest.identityId);       // the guest session is spent; from now on this is a normal account
  if (ensureWallet) await ensureWallet(user.id, user.countryCode).catch((e) => console.error('[guest-convert] wallet', e.message));
  await identity.audit('ACCOUNT_CONVERTED', { identityId: guest.identityId, ip });
  return { user, verifyToken };
}

module.exports = { CFG, trackingPolicy, toPublicTrackingView, maskAddress, ACTIVE_RIDE, ACTIVE_DELIVERY, newReference, deriveTrackingToken, TRACK_RE, trackingUrl, podHash, podCodeFor, requestHash, publicStatus, isCancellable, validateConfirmation, createBooking, getOwnBooking, listOwnBookings, publicView, trackByToken, rotateTracking, revokeTracking, cancelBooking, convertToAccount, clean };
