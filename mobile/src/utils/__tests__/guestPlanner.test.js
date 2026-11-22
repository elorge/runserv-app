import { newSessionToken, needsDetails, toPlace, samePlace, routeToPath, formatKm, formatMinutes, secondsLeft, isExpired, quoteErrorMessage } from '../guestPlanner';

describe('guestPlanner', () => {
  it('session token is 24 url-safe chars and varies', () => {
    const a = newSessionToken(); const b = newSessionToken();
    expect(a).toMatch(/^[a-z0-9]{24}$/); expect(a).not.toBe(b);
  });
  it('photon suggestions carry coords; google ones need a details call', () => {
    expect(needsDetails({ provider: 'photon', lat: 6.5, lng: 3.3 })).toBe(false);
    expect(needsDetails({ provider: 'google', placeId: 'x' })).toBe(true);
    expect(needsDetails(null)).toBe(false);
  });
  it('toPlace prefers details, validates coordinates', () => {
    expect(toPlace({ provider: 'google', description: 'Ikeja' }, { lat: 6.6, lng: 3.35, formattedAddress: 'Ikeja, Lagos' })).toEqual({ label: 'Ikeja, Lagos', latitude: 6.6, longitude: 3.35 });
    expect(toPlace({ lat: 6.5, lng: 3.3, description: 'Yaba' })).toEqual({ label: 'Yaba', latitude: 6.5, longitude: 3.3 });
    expect(toPlace({ description: 'x' })).toBeNull();
    expect(toPlace({ lat: 99, lng: 3 })).toBeNull();
  });
  it('samePlace', () => {
    expect(samePlace({ latitude: 6.5, longitude: 3.3 }, { latitude: 6.50001, longitude: 3.30001 })).toBe(true);
    expect(samePlace({ latitude: 6.5, longitude: 3.3 }, { latitude: 6.6, longitude: 3.3 })).toBe(false);
    expect(samePlace(null, null)).toBe(false);
  });
  it('routeToPath fits inside the box and orients north-up', () => {
    const coords = [{ latitude: 6.5, longitude: 3.3 }, { latitude: 6.55, longitude: 3.32 }, { latitude: 6.6, longitude: 3.4 }];
    const r = routeToPath(coords, 300, 200, 14);
    const pts = r.points.split(' ').map((p) => p.split(',').map(Number));
    for (const [x, y] of pts) { expect(x).toBeGreaterThanOrEqual(14 - 0.2); expect(x).toBeLessThanOrEqual(286.2); expect(y).toBeGreaterThanOrEqual(13.8); expect(y).toBeLessThanOrEqual(186.2); }
    expect(r.start.y).toBeGreaterThan(r.end.y); // start is further south => lower on screen
    expect(routeToPath([], 10, 10)).toBeNull();
    expect(routeToPath([{ latitude: 1, longitude: 1 }], 10, 10)).toBeNull();
  });
  it('routeToPath thins very long routes', () => {
    const coords = Array.from({ length: 5000 }, (_, i) => ({ latitude: 6 + i * 1e-4, longitude: 3 + i * 1e-4 }));
    expect(routeToPath(coords, 300, 200).points.split(' ').length).toBeLessThanOrEqual(260);
  });
  it('formats distance and time', () => {
    expect(formatKm(5234)).toBe('5.2 km'); expect(formatMinutes(900)).toBe('15 min'); expect(formatMinutes(4500)).toBe('1 h 15 min'); expect(formatMinutes(0)).toBe('1 min');
  });
  it('quote expiry', () => {
    expect(secondsLeft(10_000, 4_000)).toBe(6); expect(secondsLeft(1, 5000)).toBe(0);
    expect(isExpired(5000, 5000)).toBe(true); expect(isExpired(5001, 5000)).toBe(false);
  });
  it('maps server errors to friendly text', () => {
    expect(quoteErrorMessage({ response: { status: 503, data: { code: 'ROUTE_UNAVAILABLE' } } })).toMatch(/route/);
    expect(quoteErrorMessage({ response: { status: 429, data: {} } })).toMatch(/Too many/);
    expect(quoteErrorMessage({})).toMatch(/connection/);
  });
});
