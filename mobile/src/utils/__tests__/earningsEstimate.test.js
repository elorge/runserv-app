import {
  driverTrip, driverWeek, askGain, courierRun, courierShift, requestShare, roundNice, clampMultiplier, safeCommission,
  formatRange, ASSUMPTIONS, PARCEL_KG,
} from '../earningsEstimate';

// Reference numbers come from backend/tests/fareEngine.test.js and fareEngine.js (the server is the source of truth).
describe('driverTrip mirrors backend fareEngine.calculateFinalFare (no surge)', () => {
  it('5 km car trip: fare 1500, driver keeps (1500 - 100 booking) x 0.8 = 1120', () => {
    const r = driverTrip({ km: 5, vehicleType: 'CAR', multiplier: 1 });
    expect(r.fare).toBe(1500);
    expect(r.bookingFee).toBe(100);
    expect(r.earnings).toBe(1120);
  });
  it('a +20% ask multiplies the core charge, then adds the booking fee and rounds', () => {
    // core 1400 x 1.2 = 1680 -> +100 = 1780 -> nearest 50 = 1800; keeps (1800-100) x 0.8 = 1360
    const r = driverTrip({ km: 5, vehicleType: 'CAR', multiplier: 1.2 });
    expect(r.fare).toBe(1800);
    expect(r.earnings).toBe(1360);
  });
  it('never goes below the minimum fare', () => {
    expect(driverTrip({ km: 0.1, vehicleType: 'VAN' }).fare).toBeGreaterThanOrEqual(1000 + 150);
  });
  it('uses the commission it is given and ignores nonsense', () => {
    expect(driverTrip({ km: 5, vehicleType: 'CAR', commission: 0.25 }).earnings).toBe(1050);
    expect(driverTrip({ km: 5, vehicleType: 'CAR', commission: 7 }).earnings).toBe(1120);   // out of range -> standard 20%
    expect(driverTrip({ km: 5, vehicleType: 'CAR', commission: 'x' }).earnings).toBe(1120);
  });
  it('clamps the multiplier to the server cap of 1.30', () => {
    expect(clampMultiplier(2)).toBe(1.3);
    expect(clampMultiplier(0.5)).toBe(1);
    expect(driverTrip({ km: 5, vehicleType: 'CAR', multiplier: 9 })).toEqual(driverTrip({ km: 5, vehicleType: 'CAR', multiplier: 1.3 }));
  });
});

describe('driverWeek is always a RANGE that widens with the ask', () => {
  const base = { vehicleType: 'CAR', hoursPerDay: 8, daysPerWeek: 5 };
  it('low <= high and both are rounded to 2 significant figures', () => {
    const w = driverWeek(base);
    expect(w.perWeek.low).toBeLessThan(w.perWeek.high);
    expect(String(w.perWeek.high).replace(/0+$/, '').length).toBeLessThanOrEqual(2);
  });
  it('more hours or days never lowers the estimate', () => {
    expect(driverWeek({ ...base, hoursPerDay: 10 }).perWeek.high).toBeGreaterThan(driverWeek(base).perWeek.high);
    expect(driverWeek({ ...base, daysPerWeek: 6 }).perWeek.low).toBeGreaterThan(driverWeek(base).perWeek.low);
  });
  it('a higher ask raises per-trip earnings and the top of the range, and widens the range', () => {
    const std = driverWeek(base);
    const ask = driverWeek({ ...base, multiplier: 1.3 });
    expect(ask.trip.earnings).toBeGreaterThan(std.trip.earnings);
    expect(ask.perWeek.high).toBeGreaterThan(std.perWeek.high);
    expect(ask.perWeek.high - ask.perWeek.low).toBeGreaterThan(std.perWeek.high - std.perWeek.low);
  });
  it('at +30% the low end plans for fewer requests', () => {
    expect(requestShare(1)).toBe(1);
    expect(requestShare(1.3)).toBeCloseTo(1 - ASSUMPTIONS.driver.requestLossAtMax, 3);
    expect(driverWeek({ ...base, multiplier: 1.3 }).tripsPerDay.low).toBeLessThan(driverWeek(base).tripsPerDay.low);
  });
  it('askGain reports the extra kept per trip', () => {
    const g = askGain({ km: 5, vehicleType: 'CAR', multiplier: 1.2 });
    expect(g).toEqual({ base: 1120, asked: 1360, extra: 240 });
  });
});

describe('courierRun mirrors backend fareEngine.calculateDeliveryFee', () => {
  it('5 km small parcel: 500 + 80x5 + 50x2 = 1000, Runserv takes 15%, courier keeps 850', () => {
    const r = courierRun({ km: 5, parcel: 'SMALL' });
    expect(PARCEL_KG.SMALL).toBe(2);
    expect(r.fee).toBe(1000);
    expect(r.earnings).toBe(850);
  });
  it('a heavier parcel or longer run pays more', () => {
    expect(courierRun({ km: 5, parcel: 'LARGE' }).earnings).toBeGreaterThan(courierRun({ km: 5, parcel: 'DOCUMENT' }).earnings);
    expect(courierRun({ km: 15, parcel: 'SMALL' }).earnings).toBeGreaterThan(courierRun({ km: 5, parcel: 'SMALL' }).earnings);
  });
  it('uses the live delivery card and commission when given', () => {
    const r = courierRun({ km: 5, parcel: 'SMALL', delivery: { baseFee: 1000, perKm: 100, weightFeePerKg: 0 }, commission: 0.1 });
    expect(r.fee).toBe(1500);
    expect(r.earnings).toBe(1350);
  });
});

describe('courierShift: how many runs fit', () => {
  const base = { km: 5, parcel: 'SMALL', shiftHours: 8 };
  it('a busy day fits at least as many runs as a quiet one', () => {
    const s = courierShift(base);
    expect(s.runs.high).toBeGreaterThanOrEqual(s.runs.low);
    expect(s.runs.low).toBeGreaterThan(0);
  });
  it('the runs fit inside the shift', () => {
    const s = courierShift(base);
    const perRunBusy = s.tape.runMin + s.tape.gapBusy;
    expect(s.runs.high * perRunBusy).toBeLessThanOrEqual(s.tape.shiftMin + 1e-6);
  });
  it('longer shifts fit more runs; longer runs fit fewer', () => {
    expect(courierShift({ ...base, shiftHours: 12 }).runs.high).toBeGreaterThan(courierShift(base).runs.high);
    expect(courierShift({ ...base, km: 25 }).runs.high).toBeLessThan(courierShift(base).runs.high);
  });
  it('asking more stretches the waits, so the quiet-day count cannot rise', () => {
    expect(courierShift({ ...base, multiplier: 1.3 }).runs.low).toBeLessThanOrEqual(courierShift(base).runs.low);
  });
});

describe('helpers', () => {
  it('roundNice keeps two significant figures', () => {
    expect(roundNice(123456)).toBe(120000);
    expect(roundNice(98765)).toBe(99000);
    expect(roundNice(1234)).toBe(1200);
  });
  it('safeCommission rejects values outside 0..0.9', () => {
    expect(safeCommission(0.18, 0.2)).toBe(0.18);
    expect(safeCommission(18, 0.2)).toBe(0.2);
    expect(safeCommission(undefined, 0.2)).toBe(0.2);
  });
  it('formatRange collapses a zero-width range', () => {
    const f = (n) => `N${n}`;
    expect(formatRange(100, 100, f)).toBe('N100');
    expect(formatRange(100, 200, f)).toBe('N100 – N200');
  });
});
