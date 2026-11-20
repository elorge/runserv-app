import { toFix, isStale, agoLabel, STALE_AFTER_MS } from '../liveFix';
test('socket update keeps heading', () => expect(toFix({ lat: 6.5, lng: 3.3, heading: 45, speed: 6, timestamp: '2026-11-19T10:00:00Z' })).toMatchObject({ latitude: 6.5, heading: 45, timestamp: Date.parse('2026-11-19T10:00:00Z') }));
test('API location uses lastLocationAt', () => expect(toFix({ latitude: 6.5, longitude: 3.3, lastLocationAt: '2026-11-19T10:00:00Z' }).timestamp).toBe(Date.parse('2026-11-19T10:00:00Z')));
test('unusable input is null', () => { expect(toFix(null)).toBeNull(); expect(toFix({ lat: 'x', lng: 1 })).toBeNull(); });
test('stale after 90 s', () => { const f = { timestamp: 0 }; expect(isStale(f, STALE_AFTER_MS)).toBe(false); expect(isStale(f, STALE_AFTER_MS + 1)).toBe(true); });
test('ago label', () => { expect(agoLabel({ timestamp: 0 }, 30000)).toBe('30 s'); expect(agoLabel({ timestamp: 0 }, 300000)).toBe('5 min'); });
