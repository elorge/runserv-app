// backend/src/controllers/guest.controller.js
//
// POST /api/guest/quote — public, rate-limited, PREVIEW ONLY. Does NOT create a booking and does NOT weaken the
// authenticated ride/delivery routes. Distance and ETA come from the routing provider (never from the client).
'use strict';
const { AppError } = require('../middleware/errorHandler');
const routing = require('../services/maps/routing.service');
const fareEngine = require('../utils/fareEngine');
const { enabledCategories } = require('../utils/vehicleCategories');
const { COUNTRY_CENTERS } = require('../utils/countryGeo');
const guest = require('../services/guestQuote.service');

const pt = (p) => ({ latitude: Number(p?.latitude), longitude: Number(p?.longitude) });
const NOTE = 'Estimate only. This is a preview, not a booking. The final price can change with route, waiting time and demand.';

exports.quote = async (req, res) => {
  if (!guest.planningEnabled()) throw Object.assign(new AppError('Guest trip planning is not available yet.', 404), { code: 'GUEST_PLANNING_DISABLED' });
  const { service = 'RIDE', parcel } = req.body;
  const cc = String(req.body.countryCode || 'NG').toUpperCase();
  if (!COUNTRY_CENTERS[cc]) throw new AppError('Unsupported country.', 400);
  const from = pt(req.body.pickup); const to = pt(req.body.destination);
  if (!routing.valid(from) || !routing.valid(to)) throw new AppError('pickup and destination must be valid coordinates.', 400);

  const route = await routing.routeBetween(from, to);
  // No fabricated distance: if no provider can route this trip, say so instead of guessing.
  if (!route || !(route.distanceM > 0)) throw Object.assign(new AppError('We could not calculate a route for this trip. Please adjust the locations and try again.', 503), { code: 'ROUTE_UNAVAILABLE' });
  const distanceKm = route.distanceM / 1000;
  const cur = (await fareEngine.getSettings(cc)).currency || 'NGN';

  const options = [];
  const rejected = [];
  for (const vehicleType of enabledCategories()) {
    if (service === 'PARCEL') {
      const elig = guest.parcelEligibility({ vehicleType, category: parcel?.category, weightKg: parcel?.weightKg, longestSideCm: parcel?.longestSideCm });
      if (!elig.ok) { rejected.push({ vehicleType, reason: elig.reason, message: elig.message }); continue; }
      const f = await fareEngine.calculateDeliveryFee(distanceKm, Number(parcel?.weightKg) || 0, cur, cc);
      options.push({ vehicleType, fare: f.estimatedFee, breakdown: { baseFee: f.baseFee, distanceCharge: f.distanceCharge, weightCharge: f.weightCharge }, quote: guest.signQuote({ service, vehicleType, fare: f.estimatedFee, currency: f.currency, countryCode: f.countryCode, distanceM: route.distanceM, durationS: route.durationS, pickup: from, destination: to, parcel }) });
    } else {
      const f = await fareEngine.estimateFare(distanceKm, vehicleType, new Date(), 1.0, cur, cc);
      options.push({ vehicleType, fare: f.estimatedFare, surgeMultiplier: f.surgeMultiplier, breakdown: { baseFare: f.baseFare, distanceCharge: f.distanceCharge, timeCharge: f.timeCharge, bookingFee: f.bookingFee }, quote: guest.signQuote({ service, vehicleType, fare: f.estimatedFare, currency: f.currency, countryCode: f.countryCode, distanceM: route.distanceM, durationS: route.durationS, pickup: from, destination: to }) });
    }
  }
  res.set('Cache-Control', 'no-store').json({
    success: true,
    data: {
      service, preview: true, note: NOTE,
      route: { coords: route.coords, distanceM: Math.round(route.distanceM), durationS: Math.round(route.durationS), provider: route.provider },
      options, unavailable: rejected,
      ...(service === 'PARCEL' ? { prohibited: guest.PROHIBITED_PARCEL_ITEMS } : {}),
      expiresAt: options[0]?.quote.expiresAt ?? null,
    },
  });
};
