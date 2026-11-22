import { estimateTrip, tripMinutes, FALLBACK_RATES } from '../tripEstimate';

describe('tripEstimate (mirrors backend fareEngine.estimateFare, no surge)', () => {
  it('prices a 7 km car trip: (500 + 130*7 + 15*23.33) + 100 booking, rounded to 50', () => {
    expect(estimateTrip(7, 'CAR', FALLBACK_RATES, 50)).toEqual({ fare: 1850, minutes: 24 });
  });
  it('never goes below the minimum fare plus booking fee', () => {
    expect(estimateTrip(0.1, 'VAN', FALLBACK_RATES, 50).fare).toBeGreaterThanOrEqual(1000 + 150);
  });
  it('falls back to CAR rates for an unknown vehicle', () => {
    expect(estimateTrip(5, 'HOVERCRAFT', FALLBACK_RATES, 50)).toEqual(estimateTrip(5, 'CAR', FALLBACK_RATES, 50));
  });
  it('estimates minutes at 18 km/h', () => { expect(tripMinutes(18)).toBe(60); });
});
