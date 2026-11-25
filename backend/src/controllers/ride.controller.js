// backend/src/controllers/ride.controller.js
const prisma = require('../lib/prisma');
const { riderPaymentChoice, tryDebitWallet, creditWallet } = require('../services/walletOps');
const outbox = require('../services/outbox.service');
const fleetService = require('../services/fleet.service');
const { validationResult } = require('express-validator');
const { AppError }         = require('../middleware/errorHandler');
const { logger } = require('../utils/logger');
const { calculateDistance } = require('../utils/helpers');
const {
  estimateFare,
  calculateFinalFare,
  applyDriverFloor,
  getSurgeMultiplier,
  getSettings,
} = require('../utils/fareEngine');
const notificationService = require('../services/notification.service');
const { broadcastToDrivers, emitTrackingEnded } = require('../services/socket.service');
const commissionService = require('../services/commission.service');
const cashbackService = require('../services/cashback.service');
const { getCurrencyForUserId, getPricingContextForUserId } = require('../services/country.service');
const { formatMoney } = require('../utils/currency');
const countrySettingsService = require('../services/countrySettings.service');
const { roundToStep } = require('../utils/fareEngine');
const corporateService = require('../services/corporate.service');
const cal = require('../utils/orgCalendar');
const tracking = require('../services/tracking.service');

const getIO = (req) => req.app.get('io');

const emitRideStatus = (io, customerId, rideId, status, extra = {}) => {
  const payload = { rideId, status, ...extra };
  if (io) {
    io.to(`user:${customerId}`).emit('ride:status:update', payload);
    io.to(`ride:${rideId}`).emit('ride:status:update', payload);
    if (status === 'COMPLETED') emitTrackingEnded(io, 'ride', rideId, [customerId], 'COMPLETED');   // live location sharing stops with the trip
  }
};

const FLOOR_TAG = '|FLOORX:';

const encodeFloorMultiplier = (notes, multiplier) => {
  if (!multiplier || multiplier <= 1.0) return notes;
  const base = (notes ?? '').replace(/\|FLOORX:[0-9.]+/g, '').trimEnd();
  return `${base}${FLOOR_TAG}${multiplier.toFixed(6)}`;
};

const decodeFloorMultiplier = (notes) => {
  if (!notes) return 1.0;
  const idx = notes.indexOf(FLOOR_TAG);
  if (idx === -1) return 1.0;
  const raw = parseFloat(notes.slice(idx + FLOOR_TAG.length));
  return isNaN(raw) || raw < 1.0 ? 1.0 : raw;
};

exports.getFareEstimate = async (req, res) => {
  const { pickupLat, pickupLng, dropoffLat, dropoffLng, vehicleType = 'CAR' } = req.query;
  if (!pickupLat || !pickupLng || !dropoffLat || !dropoffLng)
    throw new AppError('Please provide pickup and dropoff coordinates', 400);

  const distance = calculateDistance(
    parseFloat(pickupLat), parseFloat(pickupLng),
    parseFloat(dropoffLat), parseFloat(dropoffLng)
  );

  const ctx      = await getPricingContextForUserId(req.user.id);
  const estimate = await estimateFare(distance, vehicleType.toUpperCase(), new Date(), 1.0, ctx.currencyCode, ctx.countryCode);

  res.status(200).json({ success: true, data: { ...estimate, distance: distance.toFixed(2) } });
};

exports.requestRide = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
 
  const {
    pickupAddress, pickupLat, pickupLng,
    dropoffAddress, dropoffLat, dropoffLng,
    vehicleType = 'CAR', notes, promoCode,
    payer, purpose, purposeCategory, approvalId,
  } = req.body;
  const isOrg = payer === 'ORGANIZATION';
 
  const activeRide = await prisma.ride.findFirst({
    where: { customerId: req.user.id, status: { in: ['REQUESTED', 'ACCEPTED', 'ARRIVED', 'IN_PROGRESS'] } }
  });
  if (activeRide) throw new AppError('You already have an active ride', 400);
 
  const distance      = calculateDistance(pickupLat, pickupLng, dropoffLat, dropoffLng);
  const pricingCtx    = await getPricingContextForUserId(req.user.id);
  const rideCurrency  = pricingCtx.currencyCode;
  const fareBreakdown = await estimateFare(distance, vehicleType.toUpperCase(), new Date(), 1.0, rideCurrency, pricingCtx.countryCode);
  let   finalFare     = fareBreakdown.estimatedFare;

  // Company-paid ride: verify membership, weekday/weekend policy, purpose and limits BEFORE anything is created.
  const orgEval = isOrg
    ? await corporateService.evaluateBooking({ userId: req.user.id, estimatedFare: finalFare, serviceType: 'RIDE', purpose, purposeCategory, approvalId })
    : null;
 
  // Promo code handling (company-paid rides don't use promo codes)
  let appliedPromo = null;
  if (promoCode && !isOrg) {
    appliedPromo = await prisma.promoCode.findFirst({
      where: {
        code:          promoCode.toUpperCase(),
        isActive:      true,
        validFrom:     { lte: new Date() },
        validUntil:    { gte: new Date() },
        applicableFor: { in: ['rides', 'both'] },
      }
    });
    if (appliedPromo) {
      const discount = appliedPromo.discountType === 'percentage'
        ? finalFare * (appliedPromo.discountValue / 100)
        : appliedPromo.discountValue;
      finalFare = Math.max(
        fareBreakdown.bookingFee + (fareBreakdown.estimatedFare - fareBreakdown.bookingFee - discount),
        fareBreakdown.bookingFee + fareBreakdown.roundingStep * 2   // was a hard-coded ₦100
      );
      finalFare = roundToStep(finalFare, fareBreakdown.roundingStep);
      await prisma.promoCode.update({
        where: { id: appliedPromo.id },
        data:  { currentUses: { increment: 1 } },
      });
    }
  }
 
  const orgSplit        = orgEval ? cal.splitFare(finalFare, orgEval.company.commissionRate) : null;
  const commissionRate  = orgEval ? orgEval.company.commissionRate : fareBreakdown.commissionRate;
  const driverEarnings  = orgSplit ? orgSplit.driverEarnings : Math.round(finalFare * (1 - commissionRate));
  const platformFee     = finalFare - driverEarnings;
 
  const ride = await prisma.ride.create({
    data: {
      paymentMethod: riderPaymentChoice(req.body.paymentMethod),
      customerId:    req.user.id,
      pickupAddress, pickupLat, pickupLng,
      ...tracking.sanitizePickup(req.body),            // source, GPS accuracy and capture time of the pickup point
      dropoffAddress, dropoffLat, dropoffLng,
      distance,
      estimatedFare: finalFare,
      currency:      rideCurrency,
      notes,
      promoCode:     appliedPromo?.code || null,
      ...(orgEval ? corporateService.orgBookingFields(orgEval) : {}),
      status:        'REQUESTED',
    },
    include: {
      customer: {
        select: { id: true, firstName: true, lastName: true, phone: true, profileImage: true }
      }
    }
  });

  if (orgEval) {
    try {
      await corporateService.createTripRecord(prisma, { evaluation: orgEval, rideId: ride.id, serviceType: 'RIDE', fare: finalFare, distanceKm: distance, currency: rideCurrency });
    } catch (err) {
      await prisma.ride.update({ where: { id: ride.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: 'Company trip record failed' } }).catch(() => {});
      throw err;
    }
  }
 
  // ── Broadcast payload — same fare the customer sees ─────────────────────
  // Driver and customer both see estimatedFare. The breakdown is included
  // so the driver knows their earnings without guessing.
  broadcastToDrivers(getIO(req), 'ride:new_request', {
    rideId:          ride.id,
    pickupAddress:   ride.pickupAddress,
    dropoffAddress:  ride.dropoffAddress,
 
    // The fare is identical to what the customer was shown
    estimatedFare:   ride.estimatedFare,
 
    // Transparent breakdown
    bookingFee:      fareBreakdown.bookingFee,
    driverEarnings,                              // driver's take-home
    platformFee,                                 // platform commission
    commissionRate,
 
    distance:        ride.distance,
    etaMinutes:      fareBreakdown.estimatedMinutes,
    surgeMultiplier: fareBreakdown.surgeMultiplier,
    surgeLabel:      fareBreakdown.surgeLabel,
    paymentMethod:   orgEval ? 'CORPORATE' : 'CASH',
    payer:           orgEval ? 'ORGANIZATION' : 'SELF',
    organizationName: orgEval?.company.name ?? null,
    customer: {
      firstName:    ride.customer.firstName,
      lastName:     ride.customer.lastName,
      profileImage: ride.customer.profileImage,
    },
  });
 
 
  res.status(201).json({
    success: true,
    message: 'Ride requested. Looking for nearby drivers…',
    data: {
      ride,
      fareBreakdown: {
        ...fareBreakdown,
        // Unified breakdown so the API response is transparent for both parties
        estimatedFare: finalFare,
        driverEarnings,
        platformFee,
        commissionRate,
      },
      promoApplied: !!appliedPromo,
    }
  });
};

exports.getActiveRide = async (req, res) => {
  const whereClause = req.user.role === 'DRIVER'
    ? { driverId: req.user.id }
    : { customerId: req.user.id };

  const ride = await prisma.ride.findFirst({
    where: { ...whereClause, status: { in: ['REQUESTED', 'ACCEPTED', 'ARRIVED', 'IN_PROGRESS'] } },
    include: {
      corporateTrip: { select: { purpose: true, company: { select: { name: true } } } },
      customer: { select: { id: true, firstName: true, lastName: true, phone: true, profileImage: true } },
      driver: { select: tracking.driverUserSelect },       // safe subset: no licence, ID, guarantor, insurance or coordinates
    }
  });

  let surgeContext = null;
  if (ride) {
    const { countryCode: surgeCountry } = await getPricingContextForUserId(req.user.id);
    await getSettings(surgeCountry);              // make sure this market's surge windows are cached
    surgeContext = getSurgeMultiplier(new Date(), surgeCountry);
  }

  // Exact live position: only for the assigned CUSTOMER, only while the driver has consented and is online.
  // The driver (and anyone else) gets null. `stale: true` tells the app the fix is older than 90 s.
  let driverLocation = null;
  if (ride?.driverId && req.user.role !== 'DRIVER' && ride.customerId === req.user.id) {
    const dp = await prisma.driverProfile.findUnique({
      where: { userId: ride.driverId },
      select: { isOnline: true, currentLat: true, currentLng: true, lastLocationAt: true, locationAccuracy: true, locationHeading: true,
                locationConsentAt: true, locationConsentVersion: true, locationConsentRevokedAt: true },
    });
    driverLocation = tracking.assignedLocation(dp);
  }

  res.status(200).json({
    success: true,
    data: {
      ride,
      driverLocation,
      ...(surgeContext && {
        surgeMultiplier: surgeContext.multiplier,
        surgeLabel:      surgeContext.label,
      }),
    }
  });
};

exports.acceptRide = async (req, res) => {
  const { id } = req.params;

  const driverProfile = await prisma.driverProfile.findUnique({ where: { userId: req.user.id } });
  if (!driverProfile?.isApproved) throw new AppError('Driver profile not approved', 403);
  if (!driverProfile.isOnline)    throw new AppError('Please go online to accept rides', 400);
  await fleetService.assertDriverDispatchable(req.user.id); // expired fleet documents / suspended fleet block new work

  const activeRide = await prisma.ride.findFirst({
    where: { driverId: req.user.id, status: { in: ['ACCEPTED', 'ARRIVED', 'IN_PROGRESS'] } }
  });
  if (activeRide) throw new AppError('You already have an active ride', 400);

  const ride = await prisma.ride.findUnique({ where: { id } });
  if (!ride)                       throw new AppError('Ride not found', 404);
  if (ride.status !== 'REQUESTED') throw new AppError('Ride is no longer available', 400);

  const isOrgRide = ride.payerType === 'ORGANIZATION';
  if (isOrgRide) {
    const co = await prisma.company.findUnique({ where: { id: ride.companyId }, select: { status: true } });
    if (!co || co.status !== 'ACTIVE') throw new AppError('This organisation account is no longer active', 400);
  }

  const wallet          = await prisma.wallet.findUnique({ where: { userId: req.user.id } });
  const walletBalance   = wallet?.balance ?? 0;

  // How much of the fare a driver must hold in their wallet to accept is a
  // per-country setting (100% = the whole fare, the original behaviour).
  // Organisation rides are billed to the company monthly, so NO wallet balance is needed to accept them.
  const driverCtx       = await getPricingContextForUserId(req.user.id);
  const requiredPct     = await countrySettingsService.getSetting(driverCtx.countryCode, 'driver_min_balance_percent');
  const requiredBalance = Math.ceil(ride.estimatedFare * (requiredPct / 100));
  const cur             = ride.currency || driverCtx.currencyCode;

  if (!isOrgRide && walletBalance < requiredBalance) {
    throw new AppError(
      `Insufficient wallet balance. You need at least ${formatMoney(requiredBalance, cur)} to accept this ride. ` +
      `Your current balance is ${formatMoney(walletBalance, cur)}. Please top up your wallet.`,
      402
    );
  }

  // CONDITIONAL claim: only one driver can move REQUESTED → ACCEPTED. Before, a plain update let two drivers accept the same
  // ride at once and the later write silently replaced the earlier driver.
  const claim = await prisma.ride.updateMany({
    where: { id, status: 'REQUESTED' },
    data:  { driverId: req.user.id, status: 'ACCEPTED', acceptedAt: new Date() },
  });
  if (claim.count !== 1) throw new AppError('Ride is no longer available', 409);

  // Write-then-verify against the consent-withdrawal race: if the driver went offline / withdrew consent while we were
  // accepting, hand the ride back instead of leaving a trip running on a driver who is no longer sharing location.
  const verify = await prisma.driverProfile.findUnique({ where: { userId: req.user.id }, select: { isApproved: true, isOnline: true, locationConsentAt: true, locationConsentVersion: true, locationConsentRevokedAt: true } });
  if (!verify?.isApproved || !verify.isOnline || !tracking.hasValidConsent(verify)) {
    await prisma.ride.updateMany({ where: { id, driverId: req.user.id, status: 'ACCEPTED' }, data: { driverId: null, status: 'REQUESTED', acceptedAt: null } });
    throw new AppError('You went offline or stopped sharing your location while accepting. The ride was not assigned to you.', 409);
  }

  const updatedRide = await prisma.ride.findUnique({
    where: { id },
    include: {
      customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
      driver:   { select: tracking.driverUserSelect }
    }
  });

  emitRideStatus(getIO(req), ride.customerId, id, 'ACCEPTED', { driver: updatedRide.driver });

  await notificationService.notify({
    userId:  ride.customerId,
    title:   'Driver Found! 🚗',
    message: `${req.user.firstName} ${req.user.lastName} accepted your ride and is on the way.`,
    type:    'ride_accepted',
    data: {
      rideId:       id,
      driverName:   `${req.user.firstName} ${req.user.lastName}`,
      vehiclePlate: driverProfile.vehiclePlate,
      vehicleColor: driverProfile.vehicleColor,
    }
  });

  res.status(200).json({ success: true, message: 'Ride accepted', data: { ride: updatedRide } });
};

exports.arrivedAtPickup = async (req, res) => {
  const { id } = req.params;
  const ride   = await prisma.ride.findUnique({ where: { id } });
  if (!ride)                         throw new AppError('Ride not found', 404);
  if (ride.driverId !== req.user.id) throw new AppError('Unauthorized', 403);
  if (ride.status !== 'ACCEPTED')    throw new AppError('Cannot mark arrived at this status', 400);

  const updatedRide = await prisma.ride.update({ where: { id }, data: { status: 'ARRIVED', arrivedAt: new Date() } });
  emitRideStatus(getIO(req), ride.customerId, id, 'ARRIVED');

  await notificationService.notify({
    userId:  ride.customerId,
    title:   'Driver Arrived! 📍',
    message: 'Your driver has arrived at the pickup location.',
    type:    'ride_arrived',
    data:    { rideId: id }
  });

  res.status(200).json({ success: true, message: 'Arrived at pickup', data: { ride: updatedRide } });
};

exports.startRide = async (req, res) => {
  const { id } = req.params;
  const ride   = await prisma.ride.findUnique({ where: { id } });
  if (!ride)                         throw new AppError('Ride not found', 404);
  if (ride.driverId !== req.user.id) throw new AppError('Unauthorized', 403);
  if (!['ACCEPTED', 'ARRIVED'].includes(ride.status))
    throw new AppError('Cannot start ride at this status', 400);

  const updatedRide = await prisma.ride.update({
    where: { id },
    data:  { status: 'IN_PROGRESS', startedAt: new Date() }
  });
  emitRideStatus(getIO(req), ride.customerId, id, 'IN_PROGRESS');

  await notificationService.notify({
    userId:  ride.customerId,
    title:   'Ride Started 🚀',
    message: 'Your ride has started. Enjoy the trip!',
    type:    'ride_started',
    data:    { rideId: id }
  });

  res.status(200).json({ success: true, message: 'Ride started', data: { ride: updatedRide } });
};

exports.completeRide = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  const { id } = req.params;
  let paymentMethod; // set below from the rider's stored choice; the driver's request body is ignored

  const ride = await prisma.ride.findUnique({
    where: { id },
    include: { driver: { select: { driverProfile: true } } }
  });
  if (!ride)                         throw new AppError('Ride not found', 404);
  if (ride.driverId !== req.user.id) throw new AppError('Unauthorized', 403);
  if (ride.status !== 'IN_PROGRESS') throw new AppError('Ride is not in progress', 400);
  // Company-paid: nothing is collected from the rider; it goes on the company's monthly invoice.
  const isOrg = ride.payerType === 'ORGANIZATION';

  const completedAt           = new Date();
  const driverFloorMultiplier = decodeFloorMultiplier(ride.notes);

  const { countryCode: rideCountry } = await getPricingContextForUserId(ride.customerId);
  const finalFareBreakdown = await calculateFinalFare({
    countryCode:          rideCountry,
    distanceKm:           ride.distance,
    startedAt:            ride.startedAt,
    completedAt,
    vehicleType:          ride.driver?.driverProfile?.vehicleType ?? 'CAR',
    requestedAt:          ride.requestedAt,
    driverFloorMultiplier,
    currency:             ride.currency, // ← locked in at request time, not re-derived
  });

  const finalFare      = finalFareBreakdown.finalFare;
  const orgSplit       = isOrg ? await corporateService.splitForCompany(ride.companyId, finalFare) : null;
  const platformFee    = isOrg ? orgSplit.platformFee : finalFareBreakdown.platformRevenue.total;
  const driverEarnings = isOrg ? orgSplit.driverEarnings : finalFareBreakdown.driverEarnings;

  // Everything that moves money happens in ONE transaction:
  //  • the ride completes only if it is still IN_PROGRESS for this driver (a replay or double tap cannot pay twice);
  //  • a wallet fare is taken only if the balance covers it (conditional update), and the driver is credited in the same step;
  //  • if the wallet cannot cover it the rider pays the driver in cash. A completed trip is never left unpaid and unrecorded.
  // The payment method is the RIDER's choice stored at request time; whatever the driver's app sends is ignored.
  const wanted = isOrg ? 'CORPORATE' : (ride.paymentMethod || 'CASH');
  const { updatedRide, payment, method } = await prisma.$transaction(async (tx) => {
    const done = await tx.ride.updateMany({ where: { id, status: 'IN_PROGRESS', driverId: req.user.id }, data: { status: 'COMPLETED', actualFare: finalFare, completedAt } });
    // M13: the "trip completed" event commits atomically with the completion (see services/outbox.service.js).
    if (done.count === 1) await outbox.enqueueTx(tx, { type: 'TRIP_COMPLETED', aggregateType: 'RIDE', aggregateId: id, payload: outbox.tripCompletedPayload({ serviceType: 'RIDE', rideId: id, driverUserId: ride.driverId, fare: finalFare, currency: ride.currency, completedAt }) });
    if (done.count !== 1) throw new AppError('Ride is not in progress', 409);
    const prepaid = await tx.payment.findFirst({ where: { rideId: id, status: 'COMPLETED' } });
    if (prepaid) { return { updatedRide: await tx.ride.findUnique({ where: { id } }), payment: prepaid, method: prepaid.method }; } // already paid in the app: nothing more to take or credit
    let m = wanted;
    if (m === 'WALLET') {
      const taken = await tryDebitWallet(tx, { userId: ride.customerId }, finalFare, { refType: 'RIDE_PAYMENT', refId: id, actor: req.user.id, memo: 'Wallet payment at completion', idempotencyKey: `RIDE_PAYMENT_DEBIT:${id}` });
      if (taken) {
        await creditWallet(tx, { userId: req.user.id }, driverEarnings, { refType: 'RIDE_EARNING', refId: id, actor: req.user.id, memo: 'Earnings at completion', idempotencyKey: `RIDE_EARNING_CREDIT:${id}` });
        await tx.walletTransaction.create({ data: { walletId: (await tx.wallet.findUnique({ where: { userId: ride.customerId }, select: { id: true } })).id, type: 'DEBIT', amount: finalFare, description: `Ride payment - ${ride.pickupAddress} to ${ride.dropoffAddress}`, status: 'COMPLETED', reference: `RIDE-${id}` } });
      } else { m = 'CASH'; }
    }
    const pay = await tx.payment.create({ data: { userId: ride.customerId, rideId: id, amount: finalFare, currency: ride.currency, method: m, status: m === 'WALLET' ? 'COMPLETED' : 'PENDING', transactionId: `RIDE-${id}-${Date.now()}`, platformFee, driverEarnings } });
    return { updatedRide: await tx.ride.findUnique({ where: { id } }), payment: pay, method: m };
  });
  paymentMethod = method;

  await prisma.driverProfile.update({ where: { userId: req.user.id }, data: { totalRides: { increment: 1 } } });
  emitRideStatus(getIO(req), ride.customerId, id, 'COMPLETED');

  cashbackService.checkAndIssueRideCashback(ride.customerId).catch(err => {
    console.error('[cashback] check failed for ride', id, err.message);
  });


  // Write commission/ledger record — non-critical, never fails the response
  await commissionService.createCommissionRecord({
    paymentId:        payment.id,
    serviceType:      'RIDE',
    rideId:           id,
    earnerUserId:     ride.driverId,
    grossAmount:      finalFare,
    bookingFee:       finalFareBreakdown.bookingFee    ?? 0,
    commissionRate:   isOrg ? orgSplit.rate : finalFareBreakdown.commissionRate,
    commissionAmount: platformFee,
    earnerAmount:     driverEarnings,
    surgeMultiplier:  finalFareBreakdown.surgeMultiplier ?? 1.0,
    currency:         ride.currency,
  }).catch(err => {
    console.error('[commission] Failed to write ledger for ride', id, err.message);
  });

  // Fleet drivers: record the trip against their fleet for settlement — non-critical.
  // Best-effort immediate delivery; if it fails the outbox worker retries (nothing is lost).
  await outbox.processByKey({ type: 'TRIP_COMPLETED', aggregateType: 'RIDE', aggregateId: id })
    .catch(err => console.error('[outbox] immediate delivery failed for ride', id, err.message));

  // Company-paid: lock in final fare, distance and the driver/Runserv split on the audit/billing record.
  if (isOrg) {
    await corporateService.finalizeTrip({
      rideId: id, fare: finalFare, distanceKm: ride.distance, earnerUserId: req.user.id, completedAt,
    }).catch(err => logger.error(`[Org] finalizeTrip failed for ride ${id}: ${err.message}`));
  }

  const surgeNote   = finalFareBreakdown.surgeLabel ? ` (${finalFareBreakdown.surgeLabel} pricing applied)` : '';
  const trafficNote = finalFareBreakdown.actualMinutes > (ride.distance / 18 * 60 * 1.2)
    ? ' Traffic surcharge included.' : '';

  await notificationService.notify({
    userId:  ride.customerId,
    title:   'Ride Completed ✅',
    message: isOrg
      ? `Your ride is done. ${formatMoney(finalFare, ride.currency, rideCountry)} has been billed to ${orgSplit.company.name}. Please rate your driver!`
      : `Your ride is done. Total: ${formatMoney(finalFare, ride.currency, rideCountry)}${surgeNote}.${trafficNote} Please rate your driver!`,
    type:    'ride_completed',
    data:    { rideId: id, fare: finalFare, paymentMethod, fareBreakdown: finalFareBreakdown }
  });
  await notificationService.notify({
    userId:  req.user.id,
    title:   isOrg ? 'Company ride completed ✅' : 'Payment Received 💰',
    message: isOrg
      ? `Ride done. Do not collect cash — ${orgSplit.company.name} is billed monthly. Your earnings of ${formatMoney(driverEarnings, ride.currency, rideCountry)} will be paid to your wallet once the company settles its invoice.`
      : `Ride done. Your earnings: ${formatMoney(driverEarnings, ride.currency, rideCountry)} (after platform fees).`,
    type:    'payment_received',
    data:    { rideId: id, earnings: driverEarnings, platformFee }
  });

  res.status(200).json({
    success: true,
    message: 'Ride completed',
    data: { ride: updatedRide, payment, fareBreakdown: finalFareBreakdown }
  });
};

exports.cancelRide = async (req, res) => {
  const { id }     = req.params;
  const { reason } = req.body;

  const ride = await prisma.ride.findUnique({ where: { id } });
  if (!ride) throw new AppError('Ride not found', 404);
  if (ride.customerId !== req.user.id && ride.driverId !== req.user.id)
    throw new AppError('Unauthorized', 403);
  if (['COMPLETED', 'CANCELLED'].includes(ride.status))
    throw new AppError('Cannot cancel this ride', 400);

  const cancelledByDriver = ride.driverId === req.user.id;
  let cancellationFee = 0;

  if (ride.status !== 'REQUESTED' && !cancelledByDriver && ride.payerType !== 'ORGANIZATION') {
    // Was a hard-coded 200 that ignored the admin's cancellation-fee settings
    // (and was Naira in every market). Now: the rate card of the customer's
    // country, for the vehicle that was actually assigned.
    const { countryCode: cancelCountry } = await getPricingContextForUserId(ride.customerId);
    const assigned = ride.driverId
      ? await prisma.driverProfile.findUnique({ where: { userId: ride.driverId }, select: { vehicleType: true } })
      : null;
    const { rates } = await getSettings(cancelCountry);
    cancellationFee = (rates[assigned?.vehicleType] ?? rates.CAR).cancellationFee;
    await prisma.payment.create({
      data: {
        userId: ride.customerId, rideId: id, amount: cancellationFee,
        currency: ride.currency, method: 'WALLET', status: 'PENDING',
        transactionId: `CANCEL-${id}-${Date.now()}`, platformFee: 0, driverEarnings: 0
      }
    });
  }

  const updatedRide = await prisma.ride.update({
    where: { id },
    data:  { status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: reason }
  });

  if (ride.payerType === 'ORGANIZATION') await corporateService.cancelTrip({ rideId: id }).catch(() => {});

  const io = getIO(req);
  if (io) {
    io.to(`ride:${id}`).emit('ride:cancelled',  { rideId: id, reason, cancelledBy: req.user.id });
    if (ride.customerId) io.to(`user:${ride.customerId}`).emit('ride:cancelled', { rideId: id, reason });
    if (ride.driverId)   io.to(`user:${ride.driverId}`).emit('ride:cancelled',   { rideId: id, reason });
    emitTrackingEnded(io, 'ride', id, [ride.customerId, ride.driverId], 'CANCELLED');
  }

  const notifyId = cancelledByDriver ? ride.customerId : ride.driverId;
  if (notifyId) {
    await notificationService.notify({
      userId:  notifyId,
      title:   'Ride Cancelled',
      message: cancelledByDriver
        ? "Your driver cancelled. We're finding another driver for you."
        : `Your ride was cancelled. ${reason ? `Reason: ${reason}` : ''} ${cancellationFee ? `${formatMoney(cancellationFee, ride.currency)} cancellation fee applies.` : ''}`,
      type:    'ride_cancelled',
      data:    { rideId: id, reason, cancelledBy: req.user.id, cancellationFee }
    });
  }

  res.status(200).json({ success: true, message: 'Ride cancelled', data: { ride: updatedRide, cancellationFee } });
};

exports.getRideHistory = async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const whereClause = req.user.role === 'DRIVER'
    ? { driverId:   req.user.id, status: { in: ['COMPLETED', 'CANCELLED'] } }
    : req.user.role === 'CUSTOMER'
    ? { customerId: req.user.id, status: { in: ['COMPLETED', 'CANCELLED'] } }
    : { status: { in: ['COMPLETED', 'CANCELLED'] } };

  const [rides, total] = await Promise.all([
    prisma.ride.findMany({
      where: whereClause,
      include: {
        customer: { select: { firstName: true, lastName: true } },
        driver:   { select: { firstName: true, lastName: true } },
        rating:   true,
        corporateTrip: { select: { purpose: true, company: { select: { name: true } } } },
        payment:  { select: { amount: true, method: true, status: true, platformFee: true, driverEarnings: true } }
      },
      orderBy: { requestedAt: 'desc' }, skip, take: parseInt(limit)
    }),
    prisma.ride.count({ where: whereClause })
  ]);

  res.status(200).json({
    success: true,
    data: {
      rides,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) }
    }
  });
};

exports.getRideById = async (req, res) => {
  const { id } = req.params;
  const ride   = await prisma.ride.findUnique({
    where: { id },
    include: {
      customer: { select: { id: true, firstName: true, lastName: true, phone: true, profileImage: true } },
      driver:   { select: tracking.driverUserSelect },
      payment:  true,
      rating:   true,
    }
  });
  if (!ride) throw new AppError('Ride not found', 404);
  if (ride.customerId !== req.user.id && ride.driverId !== req.user.id)
    throw new AppError('Unauthorized', 403);
  res.status(200).json({ success: true, data: { ride } });
};

exports.rateRide = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  const { id }              = req.params;
  const { rating, comment } = req.body;

  const ride = await prisma.ride.findUnique({ where: { id }, include: { rating: true } });
  if (!ride) throw new AppError('Ride not found', 404);
  if (ride.customerId !== req.user.id) throw new AppError('Only customer can rate the ride', 403);
  if (ride.status !== 'COMPLETED')     throw new AppError('Can only rate completed rides', 400);
  if (ride.rating)                     throw new AppError('Ride already rated', 400);

  const newRating = await prisma.rating.create({ data: { userId: req.user.id, rideId: id, rating, comment } });

  // Recalculate driver's average rating from all their ride ratings
  const driverRatings = await prisma.rating.findMany({ where: { ride: { driverId: ride.driverId } } });
  const avgRating     = driverRatings.reduce((sum, r) => sum + r.rating, 0) / driverRatings.length;
  await prisma.driverProfile.update({ where: { userId: ride.driverId }, data: { rating: avgRating } });

  await notificationService.notify({
    userId:  ride.driverId,
    title:   `New Rating: ${'⭐'.repeat(rating)}`,
    message: `You received a ${rating}-star rating. ${comment ? `"${comment}"` : ''}`,
    type:    'rating_received',
    data:    { rideId: id, rating, comment }
  });

  res.status(201).json({ success: true, message: 'Rating submitted', data: { rating: newRating } });
};

exports.getNearbyDrivers = async (req, res) => {
  const {
    pickupLat, pickupLng,
    dropoffLat, dropoffLng,
    radiusKm  = 10,
    vehicleType,
  } = req.query;
 
  if (!pickupLat || !pickupLng) throw new AppError('Please provide pickup coordinates', 400);
 
  const lat    = parseFloat(pickupLat);
  const lng    = parseFloat(pickupLng);
  const radius = parseFloat(radiusKm);
 
  // Route distance — use actual when dropoff is provided, fall back to 3 km
  const routeKm = (dropoffLat && dropoffLng)
    ? calculateDistance(lat, lng, parseFloat(dropoffLat), parseFloat(dropoffLng))
    : null;
  const requesterCtx      = await getPricingContextForUserId(req.user.id); // ← looked up once, not per driver
  const requesterCurrency = requesterCtx.currencyCode;
 
  const drivers = await prisma.driverProfile.findMany({
    where: {
      ...tracking.nearbyWhere(),                       // approved, online, consented on the current wording, fix under 90 s old
      ...(vehicleType && { vehicleType: vehicleType.toUpperCase() }),
    },
    include: {
      user: {
        select: {
          id:           true,
          firstName:    true,
          lastName:     true,
          profileImage: true,
        },
      },
    },
  });
 
  // Filter by radius and compute pickup ETA distance
  const nearby = drivers
    .map(d => ({
      ...d,
      distanceToPickupKm: parseFloat(
        calculateDistance(lat, lng, d.currentLat, d.currentLng).toFixed(2)
      ),
    }))
    .filter(d => d.distanceToPickupKm <= radius)
    .sort((a, b) => {
      // Weighted score: 65% rating, 35% proximity (same as before)
      const ratingA = (a.rating > 0 ? a.rating : 3.0) / 5;
      const ratingB = (b.rating > 0 ? b.rating : 3.0) / 5;
      const distA   = a.distanceToPickupKm / radius;
      const distB   = b.distanceToPickupKm / radius;
      return (ratingB * 0.65 - distB * 0.35) - (ratingA * 0.65 - distA * 0.35);
    })
    .slice(0, 20);
 
  // Compute fare per driver (respects their floorMultiplier)
  const formatted = await Promise.all(nearby.map(async (d) => {
    const driverVehicle    = d.vehicleType ?? 'CAR';
    const estimateKm       = routeKm ?? 3;         // use actual route or fallback
    const baseFareEstimate = await estimateFare(estimateKm, driverVehicle, new Date(), 1.0, requesterCurrency, requesterCtx.countryCode);
 
    // Driver floor price — stored as floorMultiplier on driverProfile (>= 1.0)
    // If not yet migrated, defaults to 1.0 (no floor applied)
    const floorMultiplier  = parseFloat(d.floorMultiplier ?? 1.0);
    let   effectiveFare    = baseFareEstimate.estimatedFare;
 
    if (floorMultiplier > 1.0) {
      const floored = applyDriverFloor(
        effectiveFare * floorMultiplier,  // driver's minimum price
        effectiveFare,
        baseFareEstimate.roundingStep,
      );
      effectiveFare = floored.adjustedFare;
    }
 
    // Earnings breakdown (same math as completeRide)
    const commissionRate  = baseFareEstimate.commissionRate;
    const driverEarnings  = Math.round(effectiveFare * (1 - commissionRate));
    const platformFee     = effectiveFare - driverEarnings;
 
    return {
      driverId:        d.user.id,
      profileId:       d.id,
      firstName:       d.user.firstName,
      lastName:        d.user.lastName,
      profileImage:    d.user.profileImage,
      vehicleType:     driverVehicle,
      vehicleMake:     d.vehicleMake,
      vehicleModel:    d.vehicleModel,
      vehicleColor:    d.vehicleColor,
      vehiclePlate:    d.vehiclePlate,
      vehicleYear:     d.vehicleYear,
      rating:          parseFloat((d.rating || 0).toFixed(1)),
      totalRides:      d.totalRides,
      distanceKm:      d.distanceToPickupKm,
      etaMinutes:      Math.ceil(d.distanceToPickupKm / 0.5),
      // Approximate position only (~110 m): enough to draw a car in the neighbourhood, not to find a doorway.
      approxLat:       tracking.approx(d.currentLat),
      approxLng:       tracking.approx(d.currentLng),
      heading:         d.locationHeading ?? null,
      lastSeenAt:      d.lastLocationAt ?? null,
      floorMultiplier, // so customer knows this driver has a floor
 
      // ── Price (customer and driver see the same effectiveFare) ────────────
      effectiveFare,          // what customer pays = what driver is quoted
      driverEarnings,         // driver's cut after commission
      platformFee,            // platform's cut
      commissionRate,
      surgeMultiplier: baseFareEstimate.surgeMultiplier,
      surgeLabel:      baseFareEstimate.surgeLabel,
      bookingFee:      baseFareEstimate.bookingFee,
      routeKm:         estimateKm,
    };
  }));
 
  res.status(200).json({
    success: true,
    data: {
      drivers:  formatted,
      total:    formatted.length,
      routeKm:  routeKm ? parseFloat(routeKm.toFixed(2)) : null,
    },
  });
};

exports.requestSpecificDriver = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  const {
    pickupAddress, pickupLat, pickupLng,
    dropoffAddress, dropoffLat, dropoffLng,
    driverId, paymentMethod, vehicleType, promoCode, notes,
    driverFloorPrice, payer, purpose, purposeCategory, approvalId,
  } = req.body;
  const isOrg = payer === 'ORGANIZATION';

  const existingRide = await prisma.ride.findFirst({
    where: { customerId: req.user.id, status: { in: ['REQUESTED', 'ACCEPTED', 'ARRIVED', 'IN_PROGRESS'] } }
  });
  if (existingRide) {
    if (existingRide.status === 'REQUESTED') {
      await prisma.ride.update({
        where: { id: existingRide.id },
        data:  { status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: 'Superseded by new driver request' }
      });
      if (existingRide.payerType === 'ORGANIZATION') await corporateService.cancelTrip({ rideId: existingRide.id }).catch(() => {});
    } else {
      throw new AppError(`You already have an active ride (${existingRide.status}). Complete or cancel it first.`, 400);
    }
  }

  const driverProfile = await prisma.driverProfile.findUnique({ where: { userId: driverId } });
  if (!driverProfile)            throw new AppError('Driver not found', 404);
  if (!driverProfile.isApproved) throw new AppError('Driver is not approved', 400);
  if (!driverProfile.isOnline)   throw new AppError('Driver is no longer online', 400);
  if (!tracking.hasValidConsent(driverProfile)) throw new AppError('Driver is no longer online', 400);   // not sharing location = not dispatchable

  const driverActiveRide = await prisma.ride.findFirst({
    where: { driverId, status: { in: ['ACCEPTED', 'ARRIVED', 'IN_PROGRESS'] } }
  });
  if (driverActiveRide) throw new AppError('Driver is currently on another ride', 400);

  const distance        = calculateDistance(
    parseFloat(pickupLat), parseFloat(pickupLng),
    parseFloat(dropoffLat), parseFloat(dropoffLng)
  );
  const usedVehicleType = vehicleType?.toUpperCase() ?? driverProfile.vehicleType ?? 'CAR';

  const requestCtx      = await getPricingContextForUserId(req.user.id);
  const requestCurrency = requestCtx.currencyCode;
  const fareBreakdown   = await estimateFare(distance, usedVehicleType, new Date(), 1.0, requestCurrency, requestCtx.countryCode);
  let   finalFare       = fareBreakdown.estimatedFare;

  let driverFloorResult = null;
  if (driverFloorPrice && parseFloat(driverFloorPrice) > 0) {
    driverFloorResult = applyDriverFloor(parseFloat(driverFloorPrice), finalFare, fareBreakdown.roundingStep);
    finalFare         = driverFloorResult.adjustedFare;
  }

  if (promoCode && !isOrg) {
    const promo = await prisma.promoCode.findFirst({
      where: {
        code: promoCode.toUpperCase(), isActive: true,
        validFrom: { lte: new Date() }, validUntil: { gte: new Date() },
        applicableFor: { in: ['rides', 'both'] }
      }
    });
    if (promo) {
      const discount = promo.discountType === 'percentage'
        ? finalFare * (promo.discountValue / 100)
        : promo.discountValue;
      finalFare = Math.max(fareBreakdown.bookingFee + fareBreakdown.roundingStep * 2, finalFare - discount);
      finalFare = roundToStep(finalFare, fareBreakdown.roundingStep);
      await prisma.promoCode.update({ where: { id: promo.id }, data: { currentUses: { increment: 1 } } });
    }
  }

  // Company-paid ride: membership, weekday/weekend policy, purpose and limits are checked before the ride exists.
  const orgEval = isOrg
    ? await corporateService.evaluateBooking({ userId: req.user.id, estimatedFare: finalFare, serviceType: 'RIDE', purpose, purposeCategory, approvalId })
    : null;

  const customer = await prisma.user.findUnique({
    where:  { id: req.user.id },
    select: { id: true, firstName: true, lastName: true, profileImage: true }
  });

  const floorMultiplier = driverFloorResult?.multiplier ?? 1.0;
  let   rideNotes       = `TARGETED:${driverId}`;
  rideNotes = encodeFloorMultiplier(rideNotes, floorMultiplier);
  if (notes) rideNotes += `|${notes}`;

  const ride = await prisma.ride.create({
    data: {
      paymentMethod:  riderPaymentChoice(req.body.paymentMethod),
      customerId:     req.user.id,
      pickupAddress,  pickupLat:  parseFloat(pickupLat),  pickupLng:  parseFloat(pickupLng),
      ...tracking.sanitizePickup(req.body),
      dropoffAddress, dropoffLat: parseFloat(dropoffLat), dropoffLng: parseFloat(dropoffLng),
      distance,
      estimatedFare:  finalFare,
      currency:       requestCurrency,
      notes:          rideNotes,
      promoCode:      isOrg ? null : (promoCode || null),
      ...(orgEval ? corporateService.orgBookingFields(orgEval) : {}),
      status:         'REQUESTED',
    }
  });

  if (orgEval) {
    try {
      await corporateService.createTripRecord(prisma, { evaluation: orgEval, rideId: ride.id, serviceType: 'RIDE', fare: finalFare, distanceKm: distance, currency: requestCurrency });
    } catch (err) {
      await prisma.ride.update({ where: { id: ride.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: 'Company trip record failed' } }).catch(() => {});
      throw err;
    }
  }

const io = getIO(req);
if (!io) {
  logger.error('[ride:new_request] io is null for rideId:', ride.id);
}
if (io) {
  // ADD THESE 3 LINES:
  const socks = await io.in(`user:${driverId}`).allSockets();
  logger.info(`[ride:new_request] targeting user:${driverId} — sockets in room: ${socks.size}`);
  if (socks.size === 0) logger.warn(`[ride:new_request] DRIVER HAS NO SOCKET — emit will be lost`);

  io.to(`user:${driverId}`).emit('ride:new_request', {
      rideId:             ride.id,
      pickupAddress:      ride.pickupAddress,
      dropoffAddress:     ride.dropoffAddress,
      estimatedFare:      ride.estimatedFare,
      bookingFee:         fareBreakdown.bookingFee,
      distance:           ride.distance,
      etaMinutes:         fareBreakdown.estimatedMinutes,
      surgeMultiplier:    fareBreakdown.surgeMultiplier,
      surgeLabel:         fareBreakdown.surgeLabel,
      driverFloorApplied: !!driverFloorResult,
      vehicleType:        usedVehicleType,
      paymentMethod:      orgEval ? 'CORPORATE' : (paymentMethod || 'CASH'),
      payer:              orgEval ? 'ORGANIZATION' : 'SELF',
      organizationName:   orgEval?.company.name ?? null,
      targeted:           true,
      customer: {
        firstName:    customer.firstName,
        lastName:     customer.lastName,
        profileImage: customer.profileImage,
      }
    });
  }

  res.status(201).json({
    success: true,
    message: 'Request sent to driver. Waiting for response...',
    data:    { ride, fareBreakdown, driverFloorResult }
  });
};

exports.getPlatformRates = async (req, res) => {
  // Optional auth on this route: signed-in users see their own country's rate
  // card, anonymous callers get the base market's.
  const ctx = req.user ? await getPricingContextForUserId(req.user.id) : { countryCode: 'NG', currencyCode: 'NGN' };
  const { rates, delivery, platform, roundingStep } = await getSettings(ctx.countryCode);
  // `commission` is the market's STANDARD platform commission (a share, 0..1) so signed-out drivers and couriers can see
  // what they would keep. It is a public rate-card value, like the fares: no per-company or per-user terms are exposed.
  const commission = { rides: platform.ridesCommission, delivery: platform.deliveryCommission };
  res.status(200).json({ success: true, data: { rates, delivery, commission, roundingStep, currency: ctx.currencyCode, countryCode: ctx.countryCode } });
};

module.exports = exports;