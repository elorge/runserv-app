// mobile/src/utils/earningsEstimate.js
//
// Honest, on-device earnings maths for the signed-out Earnings Simulator (drivers) and Parcel Run (couriers).
// Pure functions, no React, no network: easy to test and to keep in step with the server.
//
// WHAT IS REAL AND WHAT IS ASSUMED
//   Real (from the public rate card, GET /rides/platform-rates):
//     - fares: base + per-km + per-minute, minimum fare, booking fee, rounding, the driver's price multiplier;
//     - the standard platform commission, so the figure shown is what the driver KEEPS.
//   Assumed (a planning assumption, not Runserv data; every number lives in ASSUMPTIONS below and is shown to the visitor):
//     - how many trips a driver gets per online hour (a quiet-to-busy RANGE, never one number);
//     - how a higher asking price reduces requests.
//   So the weekly figure is always a RANGE, rounded to two significant figures, and labelled an estimate. There is no
//   "earn X per month" claim anywhere. Surge, tips, fuel and running costs are not included.
import { AVERAGE_SPEED_KMPH, FALLBACK_RATES, tripMinutes } from './tripEstimate';

// Mirrors backend FALLBACK_PLATFORM / FALLBACK_DELIVERY so the simulator still works offline.
export const FALLBACK_COMMISSION = { rides: 0.20, delivery: 0.15 };
export const FALLBACK_DELIVERY = { baseFee: 500, perKm: 80, weightFeePerKg: 50 };

/** Backend cap on the driver/courier price multiplier (applyDriverFloor MAX_DRIVER_MARKUP). */
export const MAX_MULTIPLIER = 1.30;
export const MIN_MULTIPLIER = 1.0;
export const MULTIPLIER_STEP = 0.05;

export const ASSUMPTIONS = {
  driver: {
    typicalTripKm: 6,        // one "typical" trip, shown on screen
    tripsPerHourQuiet: 0.5,  // trips per ONLINE hour when it is quiet (waiting included)
    tripsPerHourBusy: 1.2,   // ...and when it is busy
    requestLossAtMax: 0.36,  // share of requests a driver may lose at the maximum +30% ask (linear below that)
  },
  courier: {
    handoffMinutes: 8,       // pickup + hand-over time per run
    gapQuietMinutes: 15,     // waiting for the next request when it is quiet
    gapBusyMinutes: 5,       // ...and when it is busy
    requestLossAtMax: 0.36,
  },
};

/** What a typical parcel weighs. Delivery fee = base + per-km + weight-fee × kg, so type → weight is the only link. */
export const PARCEL_TYPES = [
  { id: 'DOCUMENT', kg: 0.5 },
  { id: 'SMALL',    kg: 2 },
  { id: 'MEDIUM',   kg: 6 },
  { id: 'LARGE',    kg: 15 },
];
export const PARCEL_KG = Object.fromEntries(PARCEL_TYPES.map((p) => [p.id, p.kg]));

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const num = (n, fallback = 0) => (Number.isFinite(Number(n)) ? Number(n) : fallback);

export const clampMultiplier = (m) => {
  const v = Math.round(clamp(num(m, 1), MIN_MULTIPLIER, MAX_MULTIPLIER) / MULTIPLIER_STEP) * MULTIPLIER_STEP;
  return Math.round(v * 100) / 100;
};

/** Normalise a commission share: a real 0..1 value, else the fallback. Never trusts a value outside [0, 0.9]. */
export const safeCommission = (value, fallback) => {
  const v = Number(value);
  return Number.isFinite(v) && v >= 0 && v <= 0.9 ? v : fallback;
};

/** Share of normal requests still arriving when asking `multiplier`× (1 = all of them). Linear, floored at 1 - loss. */
export const requestShare = (multiplier, lossAtMax = ASSUMPTIONS.driver.requestLossAtMax) => {
  const k = (clampMultiplier(multiplier) - MIN_MULTIPLIER) / (MAX_MULTIPLIER - MIN_MULTIPLIER);
  return Math.round((1 - lossAtMax * k) * 1000) / 1000;
};

/** Two significant figures: 123,456 -> 120,000. Signals "about" instead of false precision. */
export const roundNice = (n) => {
  const v = Math.abs(num(n));
  if (v < 100) return Math.round(num(n) / 5) * 5;
  const mag = 10 ** (Math.floor(Math.log10(v)) - 1);
  return Math.sign(n) * Math.round(v / mag) * mag;
};

const roundToStep = (n, step) => { const s = Number(step) > 0 ? Number(step) : 1; return Math.round(n / s) * s; };

// ───────────────────────────── DRIVER ─────────────────────────────

/**
 * One trip for a driver, mirroring backend fareEngine.calculateFinalFare (no surge):
 *   core = (base + perKm × km + perMinute × minutes) × multiplier
 *   total = round(max(minimumFare, core) + bookingFee)
 *   commission = (total − bookingFee) × rate;  driver keeps total − bookingFee − commission
 */
export function driverTrip({ km, vehicleType, rates = FALLBACK_RATES, roundingStep = 50, commission = FALLBACK_COMMISSION.rides, multiplier = 1 }) {
  const r = rates?.[vehicleType] ?? FALLBACK_RATES[vehicleType] ?? FALLBACK_RATES.CAR;
  const m = clampMultiplier(multiplier);
  const rate = safeCommission(commission, FALLBACK_COMMISSION.rides);
  const mins = (km / AVERAGE_SPEED_KMPH) * 60;
  const core = (r.baseFare + r.perKm * km + r.perMinute * mins) * m;
  const fare = roundToStep(Math.max(r.minimumFare, core) + r.bookingFee, roundingStep);
  const kept = Math.round((fare - r.bookingFee) * (1 - rate));
  return { fare, bookingFee: r.bookingFee, earnings: kept, commissionRate: rate, minutes: tripMinutes(km) };
}

/**
 * A driver's planned week as a RANGE.
 *   low  = quiet demand, and (when asking more than standard) fewer requests;
 *   high = busy demand with no loss of requests.
 * so the range widens as the ask goes up, which is the honest picture of the trade-off.
 */
export function driverWeek({ vehicleType, hoursPerDay, daysPerWeek, multiplier = 1, rates, roundingStep, commission, a = ASSUMPTIONS.driver }) {
  const hours = clamp(Math.round(num(hoursPerDay, 8)), 1, 16);
  const days = clamp(Math.round(num(daysPerWeek, 5)), 1, 7);
  const m = clampMultiplier(multiplier);
  const trip = driverTrip({ km: a.typicalTripKm, vehicleType, rates, roundingStep, commission, multiplier: m });
  const share = requestShare(m, a.requestLossAtMax);

  const tripsLowDay = hours * a.tripsPerHourQuiet * share;
  const tripsHighDay = hours * a.tripsPerHourBusy;
  const dayLow = tripsLowDay * trip.earnings;
  const dayHigh = tripsHighDay * trip.earnings;
  return {
    trip,
    multiplier: m,
    hours, days,
    share,
    tripsPerDay: { low: tripsLowDay, high: tripsHighDay },
    perDay:  { low: roundNice(dayLow),  high: roundNice(dayHigh) },
    perWeek: { low: roundNice(dayLow * days), high: roundNice(dayHigh * days) },
    // for the week strip: the unrounded daily band, so bar heights move smoothly
    rawDay: { low: dayLow, high: dayHigh },
  };
}

/** Extra a driver keeps per trip by asking `multiplier`× instead of the standard fare. */
export function askGain(args) {
  const base = driverTrip({ ...args, multiplier: 1 }).earnings;
  const asked = driverTrip(args).earnings;
  return { base, asked, extra: asked - base };
}

// ───────────────────────────── COURIER ─────────────────────────────

/**
 * What one run pays, mirroring backend fareEngine.calculateDeliveryFee (+ the courier's price multiplier, which the
 * delivery controller applies to the fee): total = round(base + perKm × km + weightFee × kg), partner keeps total − commission.
 */
export function courierRun({ km, parcel = 'SMALL', delivery = FALLBACK_DELIVERY, roundingStep = 50, commission = FALLBACK_COMMISSION.delivery, multiplier = 1 }) {
  const d = { ...FALLBACK_DELIVERY, ...(delivery || {}) };
  const kg = PARCEL_KG[parcel] ?? PARCEL_KG.SMALL;
  const m = clampMultiplier(multiplier);
  const rate = safeCommission(commission, FALLBACK_COMMISSION.delivery);
  const standard = roundToStep(d.baseFee + d.perKm * km + d.weightFeePerKg * kg, roundingStep);
  const total = m > 1 ? roundToStep(standard * m, roundingStep) : standard;
  const platformFee = Math.round(total * rate);
  return { fee: total, earnings: total - platformFee, standardFee: standard, commissionRate: rate, kg, minutes: tripMinutes(km) };
}

/** Minutes one run takes from request to the next request: the ride itself, the hand-over, and the wait for the next job. */
export const runMinutes = (km, gapMinutes, a = ASSUMPTIONS.courier) =>
  tripMinutes(km) + a.handoffMinutes + gapMinutes;

/**
 * A courier's shift: what a run pays and how many runs fit, as RANGES.
 *   low  = quiet gaps between jobs and (when asking more) fewer requests, which lengthens the gaps;
 *   high = busy gaps.
 */
export function courierShift({ km, parcel, shiftHours = 8, multiplier = 1, delivery, roundingStep, commission, a = ASSUMPTIONS.courier }) {
  const hours = clamp(Math.round(num(shiftHours, 8)), 1, 16);
  const m = clampMultiplier(multiplier);
  const run = courierRun({ km, parcel, delivery, roundingStep, commission, multiplier: m });
  const share = requestShare(m, a.requestLossAtMax);

  const minutes = hours * 60;
  // Fewer requests stretch the waiting time: a share of 0.8 means the gap is 1/0.8 as long.
  const quietPerRun = tripMinutes(km) + a.handoffMinutes + a.gapQuietMinutes / share;
  const busyPerRun = tripMinutes(km) + a.handoffMinutes + a.gapBusyMinutes;
  const runsLow = Math.max(0, Math.floor(minutes / quietPerRun));
  const runsHigh = Math.max(runsLow, Math.floor(minutes / busyPerRun));
  return {
    run, multiplier: m, hours, share,
    runs: { low: runsLow, high: runsHigh },
    perShift: { low: roundNice(runsLow * run.earnings), high: roundNice(runsHigh * run.earnings) },
    // for the shift tape: minutes per run in each case
    tape: { runMin: tripMinutes(km) + a.handoffMinutes, gapQuiet: a.gapQuietMinutes / share, gapBusy: a.gapBusyMinutes, shiftMin: minutes },
  };
}

// ───────────────────────────── breakdown (transparency) ─────────────────────────────

/** Costs that are NOT deducted from any figure above; shown so nobody mistakes an estimate for take-home pay. */
export const EXCLUDED_COSTS = ['fuel', 'maintenance', 'data', 'insurance', 'taxes'];

/**
 * Turns one trip/run into the lines shown to the visitor: customer fare, Runserv commission, estimated payout.
 * Reconciles by construction: payout = fare - bookingFee - commission (commission is derived, not re-rounded).
 * `kind` = 'DRIVER' (trip from driverTrip) or 'COURIER' (run from courierRun).
 */
export function payoutBreakdown(kind, t) {
  const fare = Math.round(num(kind === 'COURIER' ? t.fee : t.fare));
  const bookingFee = kind === 'COURIER' ? 0 : Math.round(num(t.bookingFee));
  const payout = Math.round(num(t.earnings));
  const commission = fare - bookingFee - payout;
  return {
    fare, bookingFee, commissionBase: fare - bookingFee,
    commissionRate: num(t.commissionRate), commission, payout,
    reconciles: fare - bookingFee - commission === payout,
  };
}

// ───────────────────────────── shared ─────────────────────────────

/** "₦120,000 – ₦210,000", or one figure when the range collapses. `fmt` formats a number as money. */
export const formatRange = (low, high, fmt) => (Math.round(low) === Math.round(high) ? fmt(low) : `${fmt(low)} – ${fmt(high)}`);

export const DAY_KEYS = [0, 1, 2, 3, 4, 5, 6]; // Mon..Sun
