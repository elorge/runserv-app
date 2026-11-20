// backend/src/controllers/locationConsent.controller.js
// Live-location consent for drivers (DriverProfile) and couriers (DeliveryPartnerProfile).
//   GET /api/drivers/location-consent , GET /api/partners/location-consent   → current state
//   PUT  (same paths) { granted: true|false, version }                      → agree / withdraw
// Withdrawing takes the person offline and erases their stored position. It is refused while a trip is in progress,
// the same rule as going offline (finish or cancel the trip first).
'use strict';
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { logActivity } = require('../utils/auditLog');
const tracking = require('./../services/tracking.service');

const KINDS = {
  driver: {
    model: 'driverProfile', room: 'drivers:online', entity: 'DriverProfile',
    active: (userId) => prisma.ride.findFirst({ where: { driverId: userId, status: { in: ['ACCEPTED', 'ARRIVED', 'IN_PROGRESS'] } }, select: { id: true } }),
  },
  partner: {
    model: 'deliveryPartnerProfile', room: 'partners:online', entity: 'DeliveryPartnerProfile',
    active: (userId) => prisma.delivery.findFirst({ where: { partnerId: userId, status: { in: ['ASSIGNED', 'PICKED_UP', 'IN_TRANSIT'] } }, select: { id: true } }),
  },
};

const appError = (message, status, code) => { const e = new AppError(message, status); e.code = code; return e; };

const loadProfile = async (kind, userId) => {
  const profile = await prisma[KINDS[kind].model].findUnique({
    where: { userId },
    select: { id: true, isOnline: true, locationConsentAt: true, locationConsentVersion: true, locationConsentRevokedAt: true },
  });
  if (!profile) throw new AppError(kind === 'driver' ? 'Driver profile not found.' : 'Delivery partner profile not found.', 404);
  return profile;
};

const makeHandlers = (kind) => ({
  get: async (req, res) => {
    const profile = await loadProfile(kind, req.user.id);
    res.status(200).json({ success: true, data: { consent: tracking.consentState(profile), isOnline: profile.isOnline } });
  },

  put: async (req, res) => {
    const cfg = KINDS[kind];
    const { granted, version } = req.body || {};
    if (typeof granted !== 'boolean') throw new AppError('granted must be true or false', 400);
    const profile = await loadProfile(kind, req.user.id);
    const now = new Date();

    if (granted) {
      // The phone must send the wording version it actually showed; an old build cannot grant consent to new wording.
      if (version !== tracking.CONSENT_VERSION) throw appError('The location-sharing terms have changed. Please read and accept them again.', 409, 'LOCATION_CONSENT_VERSION');
      const updated = await prisma[cfg.model].update({
        where: { userId: req.user.id },
        data: { locationConsentAt: now, locationConsentVersion: tracking.CONSENT_VERSION, locationConsentRevokedAt: null },
        select: { locationConsentAt: true, locationConsentVersion: true, locationConsentRevokedAt: true, isOnline: true },
      });
      await logActivity({ userId: req.user.id, action: 'location_consent_granted', entityType: cfg.entity, entityId: profile.id, details: { version: tracking.CONSENT_VERSION }, req });
      return res.status(200).json({ success: true, message: 'Location sharing allowed.', data: { consent: tracking.consentState(updated), isOnline: updated.isOnline } });
    }

    const blocked = () => appError('You cannot stop sharing your location during a trip. Finish or cancel the trip first.', 400, 'LOCATION_CONSENT_ACTIVE_TRIP');
    if (await cfg.active(req.user.id)) throw blocked();

    // ATOMIC: "no trip in progress" is part of the same UPDATE, so a trip accepted between the check above and this write
    // cannot be left running with consent withdrawn. If nothing matches, a trip slipped in: refuse.
    let updated;
    try {
      updated = await prisma[cfg.model].update({
        where: { userId: req.user.id, ...tracking.notOnTripWhere(kind === 'partner' ? 'DELIVERY_PARTNER' : 'DRIVER') },
        data: {
          locationConsentRevokedAt: now,
          isOnline: false,
          currentLat: null, currentLng: null, lastLocationAt: null, locationAccuracy: null, locationHeading: null,
        },
        select: { locationConsentAt: true, locationConsentVersion: true, locationConsentRevokedAt: true, isOnline: true },
      });
    } catch (e) {
      if (e?.code === 'P2025') throw blocked();
      throw e;
    }
    await logActivity({ userId: req.user.id, action: 'location_consent_withdrawn', entityType: cfg.entity, entityId: profile.id, details: { wasOnline: profile.isOnline }, req });

    // Drop any live socket out of the dispatch pool right now, not at the next reconnect.
    const io = req.app?.get?.('io');
    if (io) {
      const sockets = io.in(`user:${req.user.id}`);
      if (sockets.socketsLeave) sockets.socketsLeave(cfg.room);
      io.to(`user:${req.user.id}`).emit('location:consent:withdrawn', { at: now });
    }
    res.status(200).json({ success: true, message: 'Location sharing stopped and you are offline.', data: { consent: tracking.consentState(updated), isOnline: false } });
  },
});

module.exports = { driver: makeHandlers('driver'), partner: makeHandlers('partner') };
