// backend/src/routes/guest.routes.js — public guest PLANNING (preview) plus VERIFIED guest booking (flag GUEST_BOOKING_ENABLED, default off).
// Guest booking has its own namespace, its own opaque session ("Authorization: Guest <token>") and NEVER touches the authenticated ride/delivery routes.
'use strict';
const express = require('express');
const { body } = require('express-validator');
const rateLimit = require('express-rate-limit');
const validate = require('../middleware/validate');
const c = require('../controllers/guest.controller');
const gb = require('../controllers/guestBooking.controller');
const identity = require('../services/guestIdentity.service');
const places = require('../controllers/places.controller');
const guest = require('../services/guestQuote.service');
const { COUNTRY_CENTERS } = require('../utils/countryGeo');
const { AppError } = require('../middleware/errorHandler');

// Every guest endpoint is dark unless the flag is on; places lookups also need a supported country (and never trust req.user).
const requireFlag = (req, res, next) => (guest.planningEnabled()
  ? next()
  : next(Object.assign(new AppError('Guest trip planning is not available yet.', 404), { code: 'GUEST_PLANNING_DISABLED' })));
const guestCountry = (req, res, next) => {
  const cc = String(req.body?.countryCode || 'NG').toUpperCase();
  if (!COUNTRY_CENTERS[cc]) return next(new AppError('Unsupported country.', 400));
  req.guestCountry = cc; return next();
};

const router = express.Router();
const limiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Too many requests. Please try again shortly.' } });
/** GET /api/guest/config — lets the app decide between the real planner and the illustrative distance preview. */
router.get('/config', (req, res) => res.set('Cache-Control', 'public, max-age=60').json({ success: true, data: { planningEnabled: guest.planningEnabled(), bookingEnabled: guest.bookingEnabled(), otpChannels: identity.enabledChannels().map((x) => x.toLowerCase()) } }));

// Autocomplete is billed per request: tighter limit than quotes, short input, session token required.
const placesLimiter = rateLimit({ windowMs: 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Too many searches. Please slow down.' } });
router.post('/places/autocomplete', requireFlag, placesLimiter, [
  body('input').isString().trim().isLength({ min: 2, max: 100 }),
  body('sessionToken').isString().isLength({ min: 8, max: 64 }),
  body('countryCode').optional().isString().isLength({ min: 2, max: 2 }),
  body('lat').optional().isFloat({ min: -90, max: 90 }), body('lng').optional().isFloat({ min: -180, max: 180 }),
], validate, guestCountry, places.autocomplete);
router.post('/places/details', requireFlag, placesLimiter, [
  body('placeId').isString().isLength({ min: 3, max: 300 }),
  body('sessionToken').isString().isLength({ min: 8, max: 64 }),
], validate, places.placeDetails);

router.post('/quote', limiter, [
  body('service').optional().isIn(['RIDE', 'PARCEL']),
  body('countryCode').optional().isString().isLength({ min: 2, max: 2 }),
  body('pickup.latitude').isFloat({ min: -90, max: 90 }), body('pickup.longitude').isFloat({ min: -180, max: 180 }),
  body('destination.latitude').isFloat({ min: -90, max: 90 }), body('destination.longitude').isFloat({ min: -180, max: 180 }),
  body('parcel.category').optional().isIn(['DOCUMENT', 'SMALL', 'MEDIUM', 'LARGE']),
  body('parcel.weightKg').optional().isFloat({ min: 0.01, max: 1000 }),
  body('parcel.longestSideCm').optional().isFloat({ min: 1, max: 500 }),
], validate, c.quote);

// ── Verified guest booking (Stages 2-5). Every route is dark unless GUEST_BOOKING_ENABLED=true (and planning is on). ─────────────
const requireBookingFlag = (req, res, next) => (guest.bookingEnabled()
  ? next()
  : next(Object.assign(new AppError('Guest booking is not available yet.', 404), { code: 'GUEST_BOOKING_DISABLED' })));
// Rate-limit hits are written to the guest audit trail so support can see abuse (best effort, never blocks the 429).
const limited = (max, windowMs, label) => rateLimit({
  windowMs, max, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => { identity.audit('RATE_LIMITED', { ip: req.ip, meta: { route: label } }); res.status(429).json({ success: false, code: 'RATE_LIMITED', message: 'Too many requests. Please try again shortly.' }); },
});
// M16.1: the identity is an EMAIL (primary) or a PHONE (only while the SMS channel is on). With an email, the phone is the operational contact.
const phoneRules = [body('phone').isString().trim().isLength({ min: 7, max: 20 }), body('countryCode').optional().isString().isLength({ min: 2, max: 2 })];
const emailRule = body('email').optional().isString().trim().isLength({ min: 6, max: 254 });

router.post('/otp/request', requireBookingFlag, limited(5, 60 * 1000, 'otp/request'), [emailRule, ...phoneRules], validate, gb.requestOtp);
router.post('/otp/verify', requireBookingFlag, limited(10, 60 * 1000, 'otp/verify'), [emailRule, body('phone').optional().isString().trim().isLength({ min: 7, max: 20 }), body('countryCode').optional().isString().isLength({ min: 2, max: 2 }), body('code').isString().matches(/^\d{6}$/)], validate,
  (req, res, next) => ((req.body.email || req.body.phone) ? next() : next(Object.assign(new AppError('Enter your email address.', 400), { code: 'INVALID_EMAIL' }))), gb.verifyOtp);

// Reverse geocode (map pin / "use my current location"): billed like a search, so the same tight limit.
router.post('/places/reverse', requireFlag, placesLimiter, [body('lat').isFloat({ min: -90, max: 90 }), body('lng').isFloat({ min: -180, max: 180 }), body('countryCode').optional().isString().isLength({ min: 2, max: 2 })], validate, guestCountry, places.reverse);

const sess = [requireBookingFlag, identity.requireGuestSession];
router.post('/bookings', ...sess, limited(10, 60 * 1000, 'bookings'), [
  body('quote').isObject(), body('quote.id').isString(), body('quote.signature').isString(),
  body('pickup.latitude').isFloat({ min: -90, max: 90 }), body('pickup.longitude').isFloat({ min: -180, max: 180 }), body('pickup.address').isString().trim().isLength({ min: 2, max: 200 }),
  body('destination.latitude').isFloat({ min: -90, max: 90 }), body('destination.longitude').isFloat({ min: -180, max: 180 }), body('destination.address').isString().trim().isLength({ min: 2, max: 200 }),
  body('contactName').optional().isString().isLength({ max: 40 }), body('notes').optional().isString().isLength({ max: 300 }),
  body('parcel').optional().isObject(),
  body('parcel.recipientEmail').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ max: 254 }).isEmail().withMessage('Enter a valid recipient email address.'),   // WP-07: shape here; the REQUIRED rule (channel dependent) is enforced once, in guestBooking.service via deliveryComms.recipientEmailRequired
], validate, gb.create);
router.get('/bookings', ...sess, limited(30, 60 * 1000, 'bookings/list'), gb.list);
router.get('/bookings/:id', ...sess, limited(60, 60 * 1000, 'bookings/get'), gb.get);
router.post('/bookings/:id/cancel', ...sess, limited(10, 60 * 1000, 'bookings/cancel'), [body('reason').optional().isString().isLength({ max: 200 })], validate, gb.cancel);
router.post('/bookings/:id/tracking/rotate', ...sess, limited(10, 60 * 1000, 'tracking/rotate'), gb.rotateTracking);
router.post('/bookings/:id/tracking/revoke', ...sess, limited(10, 60 * 1000, 'tracking/revoke'), gb.revokeTracking);
router.post('/convert', ...sess, limited(5, 60 * 1000, 'convert'), [
  body('email').isEmail(), body('password').isString().isLength({ min: 8, max: 128 }),
  body('firstName').optional().isString().isLength({ max: 60 }), body('lastName').optional().isString().isLength({ max: 60 }),
], validate, gb.convert);

// PUBLIC tracking link: no session, but a 256-bit scoped token. Tight per-IP limit so tokens cannot be brute-forced or scraped.
router.get('/track/:token', requireBookingFlag, limited(60, 60 * 1000, 'track'), gb.track);

module.exports = router;
