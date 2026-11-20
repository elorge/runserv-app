const { snapToRoute } = require('../../services/routing');

const road = [
  { latitude: 6.5000, longitude: 3.3000 },
  { latitude: 6.5100, longitude: 3.3000 }, // due north
  { latitude: 6.5100, longitude: 3.3100 }, // then due east
];

describe('snapToRoute', () => {
  it('puts a drifting GPS point on the road and faces north', () => {
    const r = snapToRoute(road, { latitude: 6.5050, longitude: 3.30015 });
    expect(r.longitude).toBeCloseTo(3.3000, 5);
    expect(Math.round(r.heading)).toBe(0);
  });
  it('faces east on the second leg', () => {
    const r = snapToRoute(road, { latitude: 6.50995, longitude: 3.3050 });
    expect(Math.round(r.heading)).toBe(90);
  });
  it('returns null when the point is far from the road', () => {
    expect(snapToRoute(road, { latitude: 6.5050, longitude: 3.3100 })).toBeNull();
    expect(snapToRoute(null, { latitude: 1, longitude: 1 })).toBeNull();
  });
});
