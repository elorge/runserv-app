// backend/src/controllers/delivery.controller.js
const prisma = require('../lib/prisma');
const { riderPaymentChoice, tryDebitWallet, creditWallet } = require('../services/walletOps');
const outbox = require('../services/outbox.service');
const fleetService = require('../services/fleet.service');
const { validationResult } = require('express-validator');
const { AppError } = require('../middleware/errorHandler');
const { calculateDistance } = require('../utils/helpers');
const fareEngine = require('../utils/fareEngine');
const notificationService = require('../services/notification.service');
const { broadcastToPartners, emitToPartner, emitTrackingEnded } = require('../services/socket.service');
const commissionService = require('../services/commission.service');
const cashbackService = require('../services/cashback.service');
const { logger } = require('../utils/logger');
const { getCurrencyForUserId, getPricingContextForUserId } = require('../services/country.service');
const { formatMoney } = require('../utils/currency');
const countrySettingsService = require('../services/countrySettings.service');
const corporateService = require('../services/corporate.service');
const tracking = require('../services/tracking.service');
const pod = require('../services/proofOfDelivery.service');
const crypto = require('crypto');
const { podHash, podCodeFor } = require('../services/guestBooking.service');
const podCodeSvc = require('../services/podCode.service');
const comms = require('../services/deliveryComms.service');
const emailOutbox = require('../services/emailOutbox.service');
const identityAudit = (...a) => require('../services/guestIdentity.service').audit(...a);

/** Delivery as the caller may see it: non-sensitive proof state for everyone involved, and the hand-over code ONLY for the sender who owns it. */
const withProof = (delivery, user) => {
  if (!delivery) return delivery;
  const out = { ...delivery, proof: pod.proofView(delivery) };
  // M16.2.2: when the RECIPIENT's email carries the code (Option B / guest flow), the sender's screen does not show it. Legacy deliveries without a recipient email keep showing it.
  if (delivery.podCodeHash && user.role !== 'DELIVERY_PARTNER' && delivery.customerId === user.id && !delivery.podVerifiedAt && !delivery.failedAt && comms.senderMayViewCode({ recipientEmail: delivery.recipientEmail })) out.podCode = podCodeSvc.codeFor(delivery);
  delete out.podCodeNonce; delete out.podCodeHash;           // code material never leaves the server (the nonce + the server secret derive the code)
  delete out.recipientEmail;                                  // the recipient's address never goes back to the sender's app (it is masked in Admin)
  return out;
};

exports.getFeeEstimate = async (req, res) => {
  const { pickupLat, pickupLng, dropoffLat, dropoffLng, packageWeight } = req.query;

  if (!pickupLat || !pickupLng || !dropoffLat || !dropoffLng) {
    throw new AppError('Please provide pickup and dropoff coordinates', 400);
  }

  const distance = calculateDistance(
    parseFloat(pickupLat), parseFloat(pickupLng),
    parseFloat(dropoffLat), parseFloat(dropoffLng)
  );

  const pricingCtx        = await getPricingContextForUserId(req.user.id);
  const deliveryCurrency  = pricingCtx.currencyCode;
  const feeResult         = await fareEngine.calculateDeliveryFee(distance, packageWeight ? parseFloat(packageWeight) : 0, deliveryCurrency, pricingCtx.countryCode);
  const estimatedDuration = Math.ceil(distance / 0.4);

  res.status(200).json({
    success: true,
    data: {
      distance:          distance.toFixed(2),
      estimatedFee:      feeResult.estimatedFee.toFixed(2),
      baseFee:           feeResult.baseFee,
      distanceCharge:    feeResult.distanceCharge,
      weightCharge:      feeResult.weightCharge,
      estimatedDuration,
      currency:          feeResult.currency,
    }
  });
};

exports.requestDelivery = async (req, res) => {
  // M16.2.1 (P1.3): pilot scope. With PARCEL_PILOT_SCOPE=guest_only, registered-customer parcels are refused so that every parcel in the pilot
  // follows ONE recipient-notification workflow (guest parcels: email-first). Unset = unchanged behaviour.
  if (!require('../services/deliveryComms.service').registeredParcelsAllowed()) {
    throw Object.assign(new AppError('Parcel booking from registered accounts is not available during the pilot. Please book as a guest.', 403), { code: 'PILOT_GUEST_ONLY' });
  }
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  // M16.2.2 (Option B): with PARCEL_PILOT_SCOPE=guest_and_registered a registered customer's parcel follows the SAME recipient email flow as a guest parcel.
  const optionB = comms.registeredEmailFlow() && comms.channels().email;
  const recipientEmail = optionB ? comms.parseRecipientEmail(req.body.recipientEmail) : null;
  if (optionB && !recipientEmail && comms.recipientEmailRequired()) throw Object.assign(new AppError('Enter the recipient\'s email address. The hand-over code is sent there.', 400, 'RECIPIENT_EMAIL_REQUIRED'));

  const {
    pickupAddress, pickupLat, pickupLng, pickupContact,
    dropoffAddress, dropoffLat, dropoffLng, dropoffContact,
    packageDescription, packageWeight, packageValue, notes, promoCode,
    partnerId: selectedPartnerId,
    payer, purpose, purposeCategory, approvalId,
  } = req.body;
  const isOrg = payer === 'ORGANIZATION';

  const activeDelivery = await prisma.delivery.findFirst({
    where: { customerId: req.user.id, status: { in: ['PENDING', 'ASSIGNED', 'PICKED_UP', 'IN_TRANSIT'] } }
  });
  if (activeDelivery) throw new AppError('You already have an active delivery', 400);

  const distance = calculateDistance(pickupLat, pickupLng, dropoffLat, dropoffLng);

  const pricingCtx       = await getPricingContextForUserId(req.user.id);
  const deliveryCurrency = pricingCtx.currencyCode;
  const feeResult    = await fareEngine.calculateDeliveryFee(distance, packageWeight || 0, deliveryCurrency, pricingCtx.countryCode);
  let   estimatedFee = feeResult.estimatedFee;

  let partnerFloorResult = null;
  if (selectedPartnerId) {
    const selectedPartnerProfile = await prisma.deliveryPartnerProfile.findUnique({
      where:  { userId: selectedPartnerId },
      select: { floorMultiplier: true },
    });
    const floorMultiplier = parseFloat(selectedPartnerProfile?.floorMultiplier ?? 1.0);
    if (floorMultiplier > 1.0) {
      partnerFloorResult = fareEngine.applyDriverFloor(
        estimatedFee * floorMultiplier,
        estimatedFee,
        feeResult.roundingStep,
      );
      estimatedFee = partnerFloorResult.adjustedFare;
    }
  }

  let appliedPromo = null;
  if (promoCode && !isOrg) {
    appliedPromo = await prisma.promoCode.findFirst({
      where: {
        code: promoCode.toUpperCase(), isActive: true,
        validFrom: { lte: new Date() }, validUntil: { gte: new Date() },
        applicableFor: { in: ['deliveries', 'both'] }
      }
    });
    if (appliedPromo) {
      if (appliedPromo.discountType === 'percentage') {
        estimatedFee = estimatedFee * (1 - appliedPromo.discountValue / 100);
      } else {
        estimatedFee = Math.max(0, estimatedFee - appliedPromo.discountValue);
      }
      estimatedFee = fareEngine.roundToStep(estimatedFee, feeResult.roundingStep);
      await prisma.promoCode.update({ where: { id: appliedPromo.id }, data: { currentUses: { increment: 1 } } });
    }
  }

  // Company-paid delivery (instead of the company's own dispatch rider): checked before anything is created.
  const orgEval = isOrg
    ? await corporateService.evaluateBooking({ userId: req.user.id, estimatedFare: estimatedFee, serviceType: 'DELIVERY', purpose, purposeCategory, approvalId })
    : null;

  // M15: a hand-over code for every delivery when POD_CODE_ALL_DELIVERIES=true (default off; guest parcels always have one).
  const withCode = pod.codeForAllDeliveries() || optionB;      // Option B: every registered parcel has a code (the recipient flow needs one)
  const newId = withCode ? crypto.randomUUID() : null;
  // Option B: an unpredictable, expiring code (podCode.service); otherwise the legacy derivation, unchanged.
  const fresh = withCode && optionB ? podCodeSvc.generate(newId) : null;
  const podCode = withCode ? (fresh ? fresh.code : podCodeFor(newId)) : null;

  const createData = {
    data: {
      ...(withCode ? { id: newId, podCodeHash: podHash(newId, podCode) } : {}),
      ...(fresh ? { podCodeNonce: fresh.nonce, podCodeVersion: 1, podCodeExpiresAt: fresh.expiresAt, ...(recipientEmail ? { recipientEmail } : {}) } : {}),
      paymentMethod: riderPaymentChoice(req.body.paymentMethod),
      customerId: req.user.id,
      pickupAddress, pickupLat, pickupLng, pickupContact,
      ...tracking.sanitizePickup(req.body),            // source, GPS accuracy and capture time of the pickup point
      dropoffAddress, dropoffLat, dropoffLng, dropoffContact,
      packageDescription, packageWeight, packageValue,
      distance, estimatedFee, notes,
      currency: deliveryCurrency,
      promoCode: appliedPromo?.code || null,
      ...(orgEval ? corporateService.orgBookingFields(orgEval) : {}),
      status: 'PENDING'
    },
    include: {
      customer: { select: { id: true, firstName: true, lastName: true, phone: true, profileImage: true } }
    }
  };
  // Option B: the delivery and its recipient email are written in ONE transaction, so a parcel can never exist without its notification queued.
  // The recipient SMS is written in that same transaction (durable outbox row): a crash right after commit can no longer lose it.
  let smsQueued = null;
  const delivery = (optionB || withCode)
    ? await prisma.$transaction(async (tx) => {
        const row = await tx.delivery.create(createData);
        if (optionB) await comms.enqueueRegisteredTx(tx, { deliveryId: row.id, recipientEmail });
        if (withCode) smsQueued = await comms.enqueueRegisteredSmsTx(tx, { deliveryId: row.id, phone: dropoffContact, countryCode: pricingCtx.countryCode, codeVersion: row.podCodeVersion ?? 1 });
        return row;
      })
    : await prisma.delivery.create(createData);
  if (optionB) await identityAudit('POD_CODE_CREATED', { meta: { deliveryId: delivery.id, source: 'REGISTERED', codeVersion: 1, expiresAt: fresh?.expiresAt ?? null } });

  if (orgEval) {
    try {
      await corporateService.createTripRecord(prisma, { evaluation: orgEval, deliveryId: delivery.id, serviceType: 'DELIVERY', fare: estimatedFee, distanceKm: distance, currency: deliveryCurrency });
    } catch (err) {
      await prisma.delivery.update({ where: { id: delivery.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: 'Company trip record failed' } }).catch(() => {});
      throw err;
    }
  }

  const io = notificationService._io;
  const deliveryPayload = {
    deliveryId:         delivery.id,
    pickupAddress:      delivery.pickupAddress,
    pickupContact:      delivery.pickupContact,
    dropoffAddress:     delivery.dropoffAddress,
    dropoffContact:     delivery.dropoffContact,
    estimatedFee:       delivery.estimatedFee,
    distance:           delivery.distance,
    etaMinutes:         Math.ceil(delivery.distance / 0.4),
    packageDescription: delivery.packageDescription,
    packageWeight:      delivery.packageWeight,
    payer:              orgEval ? 'ORGANIZATION' : 'SELF',
    organizationName:   orgEval?.company.name ?? null,
    proofOfDeliveryRequired: withCode,
    customer: {
      firstName:    delivery.customer.firstName,
      profileImage: delivery.customer.profileImage,
    },
  };

  if (selectedPartnerId) {
    emitToPartner(io, selectedPartnerId, 'delivery:incoming_request', deliveryPayload);
    logger.info(`[Delivery] Request ${delivery.id} sent to partner ${selectedPartnerId}`);
  } else {
    broadcastToPartners(io, 'delivery:incoming_request', deliveryPayload);
  }

  // Recipient gets the code by SMS (best effort, international format). The sender also sees it in the app.
  // WP-07: SMS goes through the durable SMS outbox (status, retries, provider id), never a fire-and-forget direct send. Disabled channel: nothing queued, status DISABLED.
  if ((optionB && recipientEmail) || smsQueued) comms.dispatchRegistered(delivery.id);       // best-effort immediate send; the outbox workers retry anything that fails

  // The sender sees the code only when the recipient's email does NOT carry it (legacy / unset scope).
  const senderSeesCode = withCode && comms.senderMayViewCode({ recipientEmail });
  res.status(201).json({
    success: true,
    message: 'Delivery requested successfully. Looking for nearby delivery partners...',
    data: { delivery: withProof(delivery, req.user), feeBreakdown: feeResult, partnerFloorApplied: !!partnerFloorResult, promoApplied: !!appliedPromo, ...(senderSeesCode ? { podCode } : {}) }
  });
};

exports.getActiveDelivery = async (req, res) => {
  const whereClause = req.user.role === 'DELIVERY_PARTNER'
    ? { partnerId: req.user.id }
    : { customerId: req.user.id };

  const delivery = await prisma.delivery.findFirst({
    where: { ...whereClause, status: { in: ['PENDING', 'ASSIGNED', 'PICKED_UP', 'IN_TRANSIT'] } },
    include: {
      customer: { select: { id: true, firstName: true, lastName: true, phone: true, profileImage: true } },
      partner: { select: tracking.partnerUserSelect }      // safe subset only: no coordinates, no documents
    }
  });

  // Exact courier position: only for the assigned CUSTOMER, only while consented and online. `stale` after 90 s.
  let partnerLocation = null;
  if (delivery?.partnerId && req.user.role !== 'DELIVERY_PARTNER' && delivery.customerId === req.user.id) {
    const pp = await prisma.deliveryPartnerProfile.findUnique({
      where: { userId: delivery.partnerId },
      select: { isOnline: true, currentLat: true, currentLng: true, lastLocationAt: true, locationAccuracy: true, locationHeading: true,
                locationConsentAt: true, locationConsentVersion: true, locationConsentRevokedAt: true },
    });
    partnerLocation = tracking.assignedLocation(pp);
  }

  res.status(200).json({ success: true, data: { delivery: withProof(delivery, req.user), partnerLocation } });
};

exports.acceptDelivery = async (req, res) => {
  const { id } = req.params;

  const partnerProfile = await prisma.deliveryPartnerProfile.findUnique({ where: { userId: req.user.id } });
  if (!partnerProfile || !partnerProfile.isApproved) throw new AppError('Delivery partner profile not approved', 403);
  if (!partnerProfile.isOnline) throw new AppError('Please go online to accept deliveries', 400);
  await fleetService.assertDriverDispatchable(req.user.id);

  const activeDelivery = await prisma.delivery.findFirst({
    where: { partnerId: req.user.id, status: { in: ['ASSIGNED', 'PICKED_UP', 'IN_TRANSIT'] } }
  });
  if (activeDelivery) throw new AppError('You already have an active delivery', 400);

  const delivery = await prisma.delivery.findUnique({ where: { id } });
  if (!delivery) throw new AppError('Delivery not found', 404);
  if (delivery.status !== 'PENDING') throw new AppError('Delivery is no longer available', 400);

  // Company-paid deliveries are billed to the organisation monthly — no wallet balance needed to accept.
  const isOrgDelivery = delivery.payerType === 'ORGANIZATION';
  if (isOrgDelivery) {
    const co = await prisma.company.findUnique({ where: { id: delivery.companyId }, select: { status: true } });
    if (!co || co.status !== 'ACTIVE') throw new AppError('This organisation account is no longer active', 400);
  }

  const wallet          = await prisma.wallet.findUnique({ where: { userId: req.user.id } });
  const walletBalance   = wallet?.balance ?? 0;
  const partnerCtx      = await getPricingContextForUserId(req.user.id);
  const requiredPct     = await countrySettingsService.getSetting(partnerCtx.countryCode, 'driver_min_balance_percent');
  const requiredBalance = Math.ceil(delivery.estimatedFee * (requiredPct / 100));
  const cur             = delivery.currency || partnerCtx.currencyCode;

  if (!isOrgDelivery && walletBalance < requiredBalance) {
    throw new AppError(
      `Insufficient wallet balance. You need at least ${formatMoney(requiredBalance, cur)} to accept this delivery. ` +
      `Your current balance is ${formatMoney(walletBalance, cur)}. Please top up your wallet.`,
      402
    );
  }

  // CONDITIONAL claim: only one courier can move PENDING → ASSIGNED (a plain update let two couriers accept at once).
  const claim = await prisma.delivery.updateMany({
    where: { id, status: 'PENDING' },
    data: { partnerId: req.user.id, status: 'ASSIGNED', assignedAt: new Date() },
  });
  if (claim.count !== 1) throw new AppError('Delivery is no longer available', 409);

  // Write-then-verify against the consent-withdrawal race (see acceptRide).
  const verify = await prisma.deliveryPartnerProfile.findUnique({ where: { userId: req.user.id }, select: { isApproved: true, isOnline: true, locationConsentAt: true, locationConsentVersion: true, locationConsentRevokedAt: true } });
  if (!verify?.isApproved || !verify.isOnline || !tracking.hasValidConsent(verify)) {
    await prisma.delivery.updateMany({ where: { id, partnerId: req.user.id, status: 'ASSIGNED' }, data: { partnerId: null, status: 'PENDING', assignedAt: null } });
    throw new AppError('You went offline or stopped sharing your location while accepting. The delivery was not assigned to you.', 409);
  }

  const updatedDelivery = await prisma.delivery.findUnique({
    where: { id },
    include: {
      customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
      partner:  { select: tracking.partnerUserSelect }
    }
  });

  await notificationService.notify({
    userId:  delivery.customerId,
    title:   'Delivery Partner Found! 🛵',
    message: `${req.user.firstName} ${req.user.lastName} will pick up your package shortly.`,
    type:    notificationService.TYPES.DELIVERY_ASSIGNED,
    data: {
      deliveryId:   id,
      partnerName:  `${req.user.firstName} ${req.user.lastName}`,
      vehicleType:  partnerProfile.vehicleType,
      vehiclePlate: partnerProfile.vehiclePlate
    }
  });

  res.status(200).json({ success: true, message: 'Delivery accepted successfully', data: { delivery: updatedDelivery } });
};

exports.pickupDelivery = async (req, res) => {
  const { id } = req.params;
  const delivery = await prisma.delivery.findUnique({ where: { id } });

  if (!delivery) throw new AppError('Delivery not found', 404);
  if (delivery.partnerId !== req.user.id) throw new AppError('Unauthorized', 403);
  if (delivery.status !== 'ASSIGNED') throw new AppError('Cannot pickup at this status', 400);

  const updatedDelivery = await prisma.delivery.update({ where: { id }, data: { status: 'PICKED_UP', pickedUpAt: new Date() } });

  await notificationService.notify({
    userId:  delivery.customerId,
    title:   'Package Picked Up 📦',
    message: 'Your package has been picked up and is heading to the destination.',
    type:    notificationService.TYPES.DELIVERY_PICKED_UP,
    data:    { deliveryId: id }
  });

  res.status(200).json({ success: true, message: 'Package picked up', data: { delivery: updatedDelivery } });
};

exports.startTransit = async (req, res) => {
  const { id } = req.params;
  const delivery = await prisma.delivery.findUnique({ where: { id } });

  if (!delivery) throw new AppError('Delivery not found', 404);
  if (delivery.partnerId !== req.user.id) throw new AppError('Unauthorized', 403);
  if (delivery.status !== 'PICKED_UP') throw new AppError('Package must be picked up first', 400);

  const updatedDelivery = await prisma.delivery.update({ where: { id }, data: { status: 'IN_TRANSIT' } });

  await notificationService.notify({
    userId:  delivery.customerId,
    title:   'Package In Transit 🚚',
    message: 'Your package is on the way to the delivery address!',
    type:    notificationService.TYPES.DELIVERY_IN_TRANSIT,
    data:    { deliveryId: id }
  });

  res.status(200).json({ success: true, message: 'Delivery in transit', data: { delivery: updatedDelivery } });
};

exports.completeDelivery = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  const { id } = req.params;
  const { actualFee, recipientName, deliveryImageUrl } = req.body;
  let paymentMethod; // from the sender's stored choice; the courier's body is ignored

  const delivery = await prisma.delivery.findUnique({ where: { id } });
  if (!delivery) throw new AppError('Delivery not found', 404);
  if (delivery.partnerId !== req.user.id) throw new AppError('Unauthorized', 403);
  if (delivery.status !== 'IN_TRANSIT') throw new AppError('Delivery is not in transit', 400);
  // M15: a failed delivery is returned to the sender, never completed; a delivery with a hand-over code needs that code first.
  if (delivery.failedAt) throw Object.assign(new AppError('This delivery was marked as failed and is being returned to the sender.', 409), { code: 'ALREADY_FAILED' });
  if (pod.proofPending(delivery)) throw Object.assign(new AppError('Enter the recipient\'s hand-over code before completing this delivery.', 409), { code: 'POD_REQUIRED' });
  const isOrg = delivery.payerType === 'ORGANIZATION';

  const { countryCode: deliveryCountry } = await getPricingContextForUserId(delivery.customerId);
  const settings        = await fareEngine.getSettings(deliveryCountry);
  // The courier can only ever lower the fee, never raise it above what the sender was quoted.
  const claimed         = Number(actualFee);
  const finalFee        = isOrg ? delivery.estimatedFee : (Number.isFinite(claimed) && claimed > 0 ? Math.min(claimed, delivery.estimatedFee) : delivery.estimatedFee);
  const orgSplit        = isOrg ? await corporateService.splitForCompany(delivery.companyId, finalFee) : null;
  const commissionRate  = isOrg ? orgSplit.rate : settings.delivery.platformCommission;
  const platformFee     = isOrg ? orgSplit.platformFee : Math.round(finalFee * commissionRate);
  const partnerEarnings = isOrg ? orgSplit.driverEarnings : finalFee - platformFee;

  // One transaction: complete only if still IN_TRANSIT for this courier (no double pay), take a wallet fee only if the
  // balance covers it (else the sender pays the courier in cash), credit the courier in the same step. The method is the
  // sender's stored choice; the courier's request body cannot change it.
  const wanted = isOrg ? 'CORPORATE' : (delivery.paymentMethod || 'CASH');
  const deliveredAt = new Date();
  const { updatedDelivery, payment, method } = await prisma.$transaction(async (tx) => {
    const done = await tx.delivery.updateMany({ where: { id, status: 'IN_TRANSIT', partnerId: req.user.id }, data: { status: 'DELIVERED', actualFee: finalFee, recipientName, deliveryImageUrl, deliveredAt } });
    if (done.count !== 1) throw new AppError('Delivery is not in transit', 409);
    // M13: the "trip completed" event commits atomically with the completion (see services/outbox.service.js).
    await outbox.enqueueTx(tx, { type: 'TRIP_COMPLETED', aggregateType: 'DELIVERY', aggregateId: id, payload: outbox.tripCompletedPayload({ serviceType: 'DELIVERY', deliveryId: id, driverUserId: delivery.partnerId, fare: finalFee, currency: delivery.currency, completedAt: deliveredAt }) });
    const prepaid = await tx.payment.findFirst({ where: { deliveryId: id, status: 'COMPLETED' } });
    if (prepaid) { return { updatedDelivery: await tx.delivery.findUnique({ where: { id } }), payment: prepaid, method: prepaid.method }; } // already paid in the app: nothing more to take or credit
    let m = wanted;
    if (m === 'WALLET') {
      const taken = await tryDebitWallet(tx, { userId: delivery.customerId }, finalFee, { refType: 'DELIVERY_PAYMENT', refId: id, actor: req.user.id, memo: 'Wallet payment at completion', idempotencyKey: `DELIVERY_PAYMENT_DEBIT:${id}` });
      if (taken) {
        await creditWallet(tx, { userId: req.user.id }, partnerEarnings, { refType: 'DELIVERY_EARNING', refId: id, actor: req.user.id, memo: 'Earnings at completion', idempotencyKey: `DELIVERY_EARNING_CREDIT:${id}` });
        await tx.walletTransaction.create({ data: { walletId: (await tx.wallet.findUnique({ where: { userId: delivery.customerId }, select: { id: true } })).id, type: 'DEBIT', amount: finalFee, description: `Delivery payment - ${delivery.pickupAddress} to ${delivery.dropoffAddress}`, status: 'COMPLETED', reference: `DEL-${id}` } });
      } else { m = 'CASH'; }
    }
    const pay = await tx.payment.create({ data: { userId: delivery.customerId, deliveryId: id, amount: finalFee, currency: delivery.currency, method: m, status: m === 'WALLET' ? 'COMPLETED' : 'PENDING', transactionId: `DEL-${id}-${Date.now()}`, platformFee, driverEarnings: partnerEarnings } });
    return { updatedDelivery: await tx.delivery.findUnique({ where: { id } }), payment: pay, method: m };
  });
  paymentMethod = method;

  await prisma.deliveryPartnerProfile.update({ where: { userId: req.user.id }, data: { totalDeliveries: { increment: 1 } } });

  cashbackService.checkAndIssueRideCashback(delivery.customerId).catch(err => {
    console.error('[cashback] check failed for delivery', id, err.message);
  });


  // Write commission/ledger record — non-critical, never fails the response
  await commissionService.createCommissionRecord({
    paymentId:        payment.id,
    serviceType:      'DELIVERY',
    deliveryId:       id,
    earnerUserId:     delivery.partnerId,
    grossAmount:      finalFee,
    bookingFee:       0,
    commissionRate,
    commissionAmount: platformFee,
    earnerAmount:     partnerEarnings,
    surgeMultiplier:  1.0,
    currency:         delivery.currency,
  }).catch(err => {
    console.error('[commission] Failed to write ledger for delivery', id, err.message);
  });

  await outbox.processByKey({ type: 'TRIP_COMPLETED', aggregateType: 'DELIVERY', aggregateId: id })
    .catch(err => console.error('[outbox] immediate delivery failed for delivery', id, err.message));

  if (isOrg) {
    await corporateService.finalizeTrip({
      deliveryId: id, fare: finalFee, distanceKm: delivery.distance, earnerUserId: req.user.id, completedAt: new Date(),
    }).catch(err => logger.error(`[Org] finalizeTrip failed for delivery ${id}: ${err.message}`));
  }

  await notificationService.notify({
    userId:  delivery.customerId,
    title:   'Package Delivered! ✅',
    message: `Your package has been delivered to ${recipientName || 'the recipient'}. Total: ${formatMoney(finalFee, delivery.currency, deliveryCountry)}. Please rate your delivery partner!`,
    type:    notificationService.TYPES.DELIVERY_COMPLETED,
    data:    { deliveryId: id, fee: finalFee, deliveryImageUrl }
  });
  await notificationService.notify({
    userId:  req.user.id,
    title:   'Delivery Completed 💰',
    message: isOrg
      ? `Package delivered. Do not collect cash — ${orgSplit.company.name} is billed monthly. Your earnings of ${formatMoney(partnerEarnings, delivery.currency, deliveryCountry)} will be paid to your wallet once the company settles its invoice.`
      : `Package delivered. Earnings: ${formatMoney(partnerEarnings, delivery.currency, deliveryCountry)} (after ${Math.round(commissionRate * 100)}% platform fee).`,
    type:    notificationService.TYPES.PAYMENT_RECEIVED,
    data:    { deliveryId: id, earnings: partnerEarnings, platformFee }
  });

  emitTrackingEnded(notificationService._io, 'delivery', id, [delivery.customerId, req.user.id], 'DELIVERED');

  res.status(200).json({ success: true, message: 'Delivery completed successfully', data: { delivery: updatedDelivery, payment } });
};

exports.cancelDelivery = async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  const delivery = await prisma.delivery.findUnique({ where: { id } });
  if (!delivery) throw new AppError('Delivery not found', 404);
  if (delivery.customerId !== req.user.id && delivery.partnerId !== req.user.id) {
    throw new AppError('Unauthorized', 403);
  }
  if (delivery.status === 'DELIVERED' || delivery.status === 'CANCELLED') {
    throw new AppError('Cannot cancel this delivery', 400);
  }

  const cancelledByPartner = delivery.partnerId === req.user.id;

  const updatedDelivery = await prisma.delivery.update({
    where: { id },
    data:  { status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: reason }
  });

  if (delivery.payerType === 'ORGANIZATION') await corporateService.cancelTrip({ deliveryId: id }).catch(() => {});

  emitTrackingEnded(notificationService._io, 'delivery', id, [delivery.customerId, delivery.partnerId], 'CANCELLED');

  const notifyUserId = cancelledByPartner ? delivery.customerId : delivery.partnerId;
  if (notifyUserId) {
    await notificationService.notify({
      userId:  notifyUserId,
      title:   'Delivery Cancelled',
      message: cancelledByPartner
        ? "Your delivery partner cancelled. We're finding another partner for you."
        : `Your delivery was cancelled. ${reason ? `Reason: ${reason}` : ''}`,
      type:    notificationService.TYPES.DELIVERY_CANCELLED,
      data:    { deliveryId: id, reason }
    });
  }

  res.status(200).json({ success: true, message: 'Delivery cancelled', data: { delivery: updatedDelivery } });
};

exports.getDeliveryHistory = async (req, res) => {
  const { page = 1, limit = 10 } = req.query;
  const skip = (page - 1) * limit;

  const whereClause = req.user.role === 'DELIVERY_PARTNER'
    ? { partnerId: req.user.id }
    : { customerId: req.user.id };

  const [deliveries, total] = await Promise.all([
    prisma.delivery.findMany({
      where:   { ...whereClause, status: { in: ['DELIVERED', 'CANCELLED'] } },
      include: {
        customer: { select: { firstName: true, lastName: true } },
        partner:  { select: { firstName: true, lastName: true } },
        rating:   true,
        payment:  { select: { amount: true, method: true, status: true, driverEarnings: true } }
      },
      orderBy: { deliveredAt: 'desc' },
      skip:    parseInt(skip),
      take:    parseInt(limit)
    }),
    prisma.delivery.count({ where: { ...whereClause, status: { in: ['DELIVERED', 'CANCELLED'] } } })
  ]);

  res.status(200).json({
    success: true,
    data: { deliveries, pagination: { total, page: parseInt(page), pages: Math.ceil(total / limit) } }
  });
};

exports.getDeliveryById = async (req, res) => {
  const { id } = req.params;

  const delivery = await prisma.delivery.findUnique({
    where:   { id },
    include: {
      customer: { select: { id: true, firstName: true, lastName: true, phone: true, profileImage: true } },
      partner:  { select: tracking.partnerUserSelect },
      payment:  true,
      rating:   true
    }
  });

  if (!delivery) throw new AppError('Delivery not found', 404);
  if (delivery.customerId !== req.user.id && delivery.partnerId !== req.user.id) {
    throw new AppError('Unauthorized', 403);
  }

  res.status(200).json({ success: true, data: { delivery: withProof(delivery, req.user) } });
};

exports.rateDelivery = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  const { id } = req.params;
  const { rating, comment } = req.body;

  const delivery = await prisma.delivery.findUnique({ where: { id }, include: { rating: true } });
  if (!delivery) throw new AppError('Delivery not found', 404);
  if (delivery.customerId !== req.user.id) throw new AppError('Only customer can rate the delivery', 403);
  if (delivery.status !== 'DELIVERED') throw new AppError('Can only rate completed deliveries', 400);
  if (delivery.rating) throw new AppError('Delivery already rated', 400);

  const newRating = await prisma.rating.create({ data: { userId: req.user.id, deliveryId: id, rating, comment } });

  // Recalculate partner's average rating from all their delivery ratings
  const partnerRatings = await prisma.rating.findMany({ where: { delivery: { partnerId: delivery.partnerId } } });
  const avgRating      = partnerRatings.reduce((sum, r) => sum + r.rating, 0) / partnerRatings.length;

  await prisma.deliveryPartnerProfile.update({ where: { userId: delivery.partnerId }, data: { rating: avgRating } });

  await notificationService.notify({
    userId:  delivery.partnerId,
    title:   `New Rating: ${'⭐'.repeat(rating)}`,
    message: `You received a ${rating}-star rating for your delivery. ${comment ? `"${comment}"` : ''}`,
    type:    'rating_received',
    data:    { deliveryId: id, rating, comment }
  });

  res.status(201).json({ success: true, message: 'Rating submitted successfully', data: { rating: newRating } });
};

exports.getNearbyPartners = async (req, res) => {
  const { pickupLat, pickupLng, dropoffLat, dropoffLng, radiusKm = 15 } = req.query;
  if (!pickupLat || !pickupLng) throw new AppError('Please provide pickup coordinates', 400);

  const routeKm = (dropoffLat && dropoffLng)
    ? calculateDistance(parseFloat(pickupLat), parseFloat(pickupLng), parseFloat(dropoffLat), parseFloat(dropoffLng))
    : null;

  const lat    = parseFloat(pickupLat);
  const lng    = parseFloat(pickupLng);
  const radius = parseFloat(radiusKm);

  const partners = await prisma.deliveryPartnerProfile.findMany({
    where: tracking.nearbyWhere(),                     // approved, online, consented on the current wording, fix under 90 s old
    include: { user: { select: { id: true, firstName: true, lastName: true, profileImage: true } } }
  });

  const nearby = partners
    .map(p => ({
      ...p,
      distanceKm: parseFloat(calculateDistance(lat, lng, p.currentLat, p.currentLng).toFixed(2)),
    }))
    .filter(p => p.distanceKm <= radius)
    .sort((a, b) => {
      const ratingA = (a.rating > 0 ? a.rating : 3.0) / 5;
      const ratingB = (b.rating > 0 ? b.rating : 3.0) / 5;
      const distA   = a.distanceKm / radius;
      const distB   = b.distanceKm / radius;
      const scoreA  = ratingA * 0.65 - distA * 0.35;
      const scoreB  = ratingB * 0.65 - distB * 0.35;
      return scoreB - scoreA;
    })
    .slice(0, 20)
    .map(p => ({
      partnerId:       p.user.id,
      firstName:       p.user.firstName,
      lastName:        p.user.lastName,
      profileImage:    p.user.profileImage,
      vehicleType:     p.vehicleType,
      vehiclePlate:    p.vehiclePlate,
      rating:          parseFloat((p.rating || 0).toFixed(1)),
      totalDeliveries: p.totalDeliveries,
      distanceKm:      p.distanceKm,
      etaMinutes:      Math.ceil(p.distanceKm / 0.4),
      approxLat:       tracking.approx(p.currentLat),      // ~110 m: a neighbourhood, not a doorway
      approxLng:       tracking.approx(p.currentLng),
      heading:         p.locationHeading ?? null,
      lastSeenAt:      p.lastLocationAt ?? null,
      floorMultiplier: parseFloat(p.floorMultiplier ?? 1.0),
      preferredFloorPrice: p.preferredFloorPrice ?? 0,
    }));

  // Compute fee per partner using real route distance (or fallback 3 km)
  const estimateKm = routeKm ?? 3;
  const requesterCtx      = await getPricingContextForUserId(req.user.id); // ← looked up once, not per partner
  const requesterCurrency = requesterCtx.currencyCode;
  const formatted  = await Promise.all(nearby.map(async (p) => {
    const feeResult       = await fareEngine.calculateDeliveryFee(estimateKm, 0, requesterCurrency, requesterCtx.countryCode);
    const floorMultiplier = p.floorMultiplier;
    let   effectiveFee    = feeResult.estimatedFee;

    if (floorMultiplier > 1.0) {
      const floored  = fareEngine.applyDriverFloor(effectiveFee * floorMultiplier, effectiveFee, feeResult.roundingStep);
      effectiveFee   = floored.adjustedFare;
    }

    return { ...p, effectiveFee, routeKm: estimateKm };
  }));

  res.status(200).json({ success: true, data: { partners: formatted, total: formatted.length, routeKm: routeKm ? parseFloat(routeKm.toFixed(2)) : null } });
};

module.exports = exports;

// ── M15: proof of delivery / failed delivery (partner only; routes in delivery.routes.js) ──────────────────────────────
exports.verifyProof = async (req, res) => {
  const r = await pod.verifyProof({ deliveryId: req.params.id, partnerId: req.user.id, code: req.body.code, photoUrl: req.body.photoUrl, ip: req.ip });
  res.status(200).json({ success: true, message: 'Hand-over confirmed. You can now complete the delivery.', data: r });
};
exports.failDelivery = async (req, res) => {
  const r = await pod.markFailed({ deliveryId: req.params.id, partnerId: req.user.id, reason: req.body.reason, note: req.body.note, photoUrl: req.body.photoUrl, ip: req.ip });
  res.status(200).json({ success: true, message: 'Recorded. Return the parcel to the sender.', data: r });
};
exports.confirmReturned = async (req, res) => {
  const r = await pod.confirmReturned({ deliveryId: req.params.id, partnerId: req.user.id, ip: req.ip });
  res.status(200).json({ success: true, message: 'Return recorded.', data: r });
};
