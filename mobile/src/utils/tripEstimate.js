// mobile/src/utils/tripEstimate.js
//
// On-device fare estimate for the signed-out Trip Preview. Same formula as the server's
// fareEngine.estimateFare (base + per-km + per-minute, minimum fare, booking fee, rounding),
// fed by the PUBLIC /rides/platform-rates card. Surge is not included, so the UI says "estimate".

export const AVERAGE_SPEED_KMPH = 18; // keep in sync with backend/src/utils/fareEngine.js

// Mirrors backend FALLBACK_RATES so the preview still works offline.
export const FALLBACK_RATES = {
  TRICYCLE:   { baseFare: 300, perKm: 100, perMinute: 10, minimumFare: 300,  bookingFee: 75 },
  MOTORCYCLE: { baseFare: 200, perKm: 80,  perMinute: 8,  minimumFare: 250,  bookingFee: 50 },
  CAR:        { baseFare: 500, perKm: 130, perMinute: 15, minimumFare: 500,  bookingFee: 100 },
  VAN:        { baseFare: 800, perKm: 180, perMinute: 20, minimumFare: 1000, bookingFee: 150 },
};

export const PREVIEW_VEHICLES = ['TRICYCLE', 'MOTORCYCLE', 'CAR', 'VAN'];

export const tripMinutes = (km) => Math.max(1, Math.ceil((km / AVERAGE_SPEED_KMPH) * 60));

export function estimateTrip(km, vehicleType, rates = FALLBACK_RATES, roundingStep = 50) {
  const r = rates?.[vehicleType] ?? FALLBACK_RATES[vehicleType] ?? FALLBACK_RATES.CAR;
  const mins = (km / AVERAGE_SPEED_KMPH) * 60;
  const core = r.baseFare + r.perKm * km + r.perMinute * mins;
  let total = Math.max(r.minimumFare, core) + r.bookingFee;
  const step = Number(roundingStep) > 0 ? Number(roundingStep) : 1;
  total = Math.round(total / step) * step;
  return { fare: total, minutes: tripMinutes(km) };
}

const WHOLE_UNIT = ['XOF', 'XAF', 'GNF', 'MGA', 'CDF'];
export function formatMoneyFor(amount, currency = 'NGN') {
  const value = Number(amount) || 0;
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency', currency, currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 0, maximumFractionDigits: WHOLE_UNIT.includes(currency) ? 0 : 0,
    }).format(value);
  } catch {
    return `${currency} ${Math.round(value).toLocaleString()}`;
  }
}
