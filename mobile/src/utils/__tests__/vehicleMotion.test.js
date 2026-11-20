const {
  VehicleMotion, bearingBetween, easeInOut, glideDuration, isStale, ageLabel,
  STALE_AFTER_MS, MIN_GLIDE_MS, MAX_GLIDE_MS, TELEPORT_M,
} = require('../vehicleMotion');

const T0 = 1_700_000_000_000;
// ~11 m north per 0.0001 degree of latitude
const north = (m) => 6.5 + m / 111320;

describe('bearingBetween', () => {
  it('north, east, south, west', () => {
    expect(Math.round(bearingBetween(6.5, 3.3, 6.6, 3.3))).toBe(0);
    expect(Math.round(bearingBetween(6.5, 3.3, 6.5, 3.4))).toBe(90);
    expect(Math.round(bearingBetween(6.5, 3.3, 6.4, 3.3))).toBe(180);
    expect(Math.round(bearingBetween(6.5, 3.3, 6.5, 3.2))).toBe(270);
  });
});

describe('easing and timing', () => {
  it('easeInOut is 0 at start, 1 at end, 0.5 in the middle, and clamps', () => {
    expect(easeInOut(0)).toBe(0); expect(easeInOut(1)).toBe(1); expect(easeInOut(0.5)).toBeCloseTo(0.5);
    expect(easeInOut(-3)).toBe(0); expect(easeInOut(7)).toBe(1);
  });
  it('glideDuration follows the gap but is clamped', () => {
    expect(glideDuration(3000)).toBe(3000);
    expect(glideDuration(50)).toBe(MIN_GLIDE_MS);
    expect(glideDuration(60000)).toBe(MAX_GLIDE_MS);
    expect(glideDuration(NaN)).toBe(3000);
  });
  it('stale after 90 s or with no fix', () => {
    expect(isStale(T0, T0 + 30000)).toBe(false);
    expect(isStale(T0, T0 + STALE_AFTER_MS + 1)).toBe(true);
    expect(isStale(null, T0)).toBe(true);
  });
  it('ageLabel', () => { expect(ageLabel(12000)).toBe('12s'); expect(ageLabel(180000)).toBe('3 min'); });
});

describe('VehicleMotion', () => {
  it('first fix appears in place and is live', () => {
    const m = new VehicleMotion();
    expect(m.push({ lat: 6.5, lng: 3.3, heading: 90 }, T0)).toBe(true);
    const s = m.sample(T0);
    expect(s).toMatchObject({ lat: 6.5, lng: 3.3, rotation: 90, stale: false });
  });
  it('has nothing to draw before any fix, and rejects bad fixes', () => {
    const m = new VehicleMotion();
    expect(m.sample(T0).lat).toBeNull();
    expect(m.push({ lat: NaN, lng: 3 }, T0)).toBe(false);
    expect(m.push(null, T0)).toBe(false);
  });
  it('glides between real fixes instead of jumping', () => {
    const m = new VehicleMotion();
    m.push({ lat: 6.5, lng: 3.3 }, T0);
    m.push({ lat: north(300), lng: 3.3, speed: 10 }, T0 + 3000);       // 300 m in 3 s
    const start = m.sample(T0 + 3000).lat;
    const mid = m.sample(T0 + 3000 + 1500).lat;
    const end = m.sample(T0 + 3000 + 3000).lat;
    expect(start).toBeCloseTo(6.5, 6);
    expect(mid).toBeGreaterThan(6.5); expect(mid).toBeLessThan(north(300));
    expect(end).toBeCloseTo(north(300), 6);
    expect(m.sample(T0 + 3000 + 9000).lat).toBeCloseTo(north(300), 6);   // and stays there
  });
  it('turns to the bearing of the move when the phone sends no heading', () => {
    const m = new VehicleMotion();
    m.push({ lat: 6.5, lng: 3.3 }, T0);
    m.push({ lat: 6.5, lng: 3.3 + 0.003, speed: 8 }, T0 + 3000);        // due east
    expect(m.sample(T0 + 3000 + 5000).rotation).toBeCloseTo(90, 0);
  });
  it('uses the phone heading while moving, and turns the short way (350 -> 10 is 20 degrees)', () => {
    const m = new VehicleMotion();
    m.push({ lat: 6.5, lng: 3.3, heading: 350 }, T0);
    m.push({ lat: north(100), lng: 3.3, heading: 10, speed: 9 }, T0 + 3000);
    const r = m.sample(T0 + 3000 + 5000).rotation;
    expect(r).toBeCloseTo(370, 0);                                       // cumulative angle, i.e. 10 deg the short way
  });
  it('ignores GPS jitter while stationary: no movement, no turn, still live', () => {
    const m = new VehicleMotion();
    m.push({ lat: 6.5, lng: 3.3, heading: 120 }, T0);
    for (let i = 1; i <= 10; i++) m.push({ lat: north(i % 2 ? 2 : -2), lng: 3.3 + (i % 3) * 0.00001, speed: 0.2 }, T0 + i * 3000);
    const s = m.sample(T0 + 33000);
    expect(s.lat).toBeCloseTo(6.5, 6); expect(s.rotation).toBeCloseTo(120, 3);
    expect(s.stale).toBe(false);                                         // jitter fixes still prove the phone is alive
  });
  it('a poor fix (accuracy 20 m) widens the jitter allowance; a good fix does not', () => {
    const a = new VehicleMotion(); a.push({ lat: 6.5, lng: 3.3 }, T0);
    a.push({ lat: north(8), lng: 3.3, speed: 0.3, accuracy: 20 }, T0 + 3000);
    expect(a.sample(T0 + 9000).lat).toBeCloseTo(6.5, 6);                 // 8 m < 10 m allowance: ignored
    const b = new VehicleMotion(); b.push({ lat: 6.5, lng: 3.3 }, T0);
    b.push({ lat: north(8), lng: 3.3, speed: 0.3, accuracy: 5 }, T0 + 3000);
    expect(b.sample(T0 + 9000).lat).toBeCloseTo(north(8), 6);            // 8 m > 4 m allowance: real move
  });
  it('a genuine move at low speed (> jitter) is not swallowed', () => {
    const m = new VehicleMotion();
    m.push({ lat: 6.5, lng: 3.3 }, T0);
    m.push({ lat: north(20), lng: 3.3, speed: 0.4 }, T0 + 3000);
    expect(m.sample(T0 + 9000).lat).toBeCloseTo(north(20), 6);
  });
  it('goes stale when fixes stop, instead of looking live', () => {
    const m = new VehicleMotion();
    m.push({ lat: 6.5, lng: 3.3 }, T0);
    expect(m.sample(T0 + 60000).stale).toBe(false);
    const late = m.sample(T0 + STALE_AFTER_MS + 5000);
    expect(late.stale).toBe(true); expect(late.ageMs).toBeGreaterThan(STALE_AFTER_MS);
    m.push({ lat: north(50), lng: 3.3, speed: 5 }, T0 + STALE_AFTER_MS + 6000);
    expect(m.sample(T0 + STALE_AFTER_MS + 6100).stale).toBe(false);      // a new fix revives it
  });
  it('never goes backwards: an older fix is dropped', () => {
    const m = new VehicleMotion();
    m.push({ lat: 6.5, lng: 3.3, timestamp: T0 + 10000 }, T0 + 10000);
    expect(m.push({ lat: 6.6, lng: 3.3, timestamp: T0 + 5000 }, T0 + 11000)).toBe(false);
    expect(m.sample(T0 + 20000).lat).toBeCloseTo(6.5, 6);
  });
  it('a huge jump (reconnect) snaps instead of sliding across the city', () => {
    const m = new VehicleMotion();
    m.push({ lat: 6.5, lng: 3.3 }, T0);
    m.push({ lat: north(TELEPORT_M + 500), lng: 3.3, speed: 10 }, T0 + 4000);
    expect(m.sample(T0 + 4000).lat).toBeCloseTo(north(TELEPORT_M + 500), 6);
  });
  it('a new fix mid-glide continues from where the car is drawn (no snap back)', () => {
    const m = new VehicleMotion();
    m.push({ lat: 6.5, lng: 3.3 }, T0);
    m.push({ lat: north(300), lng: 3.3, speed: 10 }, T0 + 3000);
    const midNow = m.sample(T0 + 4500).lat;
    m.push({ lat: north(600), lng: 3.3, speed: 10 }, T0 + 4500);
    expect(m.sample(T0 + 4500).lat).toBeCloseTo(midNow, 6);
  });
  it('isAnimating is true while gliding and false when settled', () => {
    const m = new VehicleMotion();
    m.push({ lat: 6.5, lng: 3.3 }, T0);
    m.push({ lat: north(100), lng: 3.3, speed: 9 }, T0 + 3000);
    expect(m.isAnimating(T0 + 3500)).toBe(true);
    expect(m.isAnimating(T0 + 20000)).toBe(false);
  });
});
