// M16.1: SecureStore fails closed; expiring a session keeps the booking reference.
jest.mock('expo-secure-store', () => { const m = new Map(); return { __m: m, setItemAsync: jest.fn(async (k, v) => { m.set(k, v); }), getItemAsync: jest.fn(async (k) => (m.has(k) ? m.get(k) : null)), deleteItemAsync: jest.fn(async (k) => { m.delete(k); }) }; });
jest.mock('@react-native-async-storage/async-storage', () => { const m = new Map(); return { __m: m, setItem: jest.fn(async (k, v) => { m.set(k, v); }), getItem: jest.fn(async (k) => (m.has(k) ? m.get(k) : null)), removeItem: jest.fn(async (k) => { m.delete(k); }) }; });
const SecureStore = require('expo-secure-store');
const Async = require('@react-native-async-storage/async-storage');
const g = require('../guestSession');

const sess = { session: 'gs_abc', expiresAt: new Date(Date.now() + 3600e3).toISOString(), email: 'a***@example.com', phone: '+234****678', countryCode: 'NG', channel: 'EMAIL' };
beforeEach(() => { SecureStore.__m.clear(); Async.__m.clear(); g.resetGuestSessionCache(); jest.clearAllMocks(); });

test('a successful save is written and read back', async () => {
  await g.saveGuestSession(sess);
  expect(await g.loadGuestSession()).toMatchObject({ session: 'gs_abc', email: 'a***@example.com' });
});
test('FAIL CLOSED: if the secure write throws, the save rejects and nothing is held in memory', async () => {
  SecureStore.setItemAsync.mockRejectedValueOnce(new Error('keystore locked'));
  await expect(g.saveGuestSession(sess)).rejects.toThrow('SECURE_STORAGE_UNAVAILABLE');
  g.resetGuestSessionCache(); expect(await g.loadGuestSession()).toBeNull();
});
test('FAIL CLOSED: a write that did not stick (read-back mismatch) is a failure too', async () => {
  SecureStore.getItemAsync.mockResolvedValueOnce(null);
  await expect(g.saveGuestSession(sess)).rejects.toThrow('SECURE_STORAGE_UNAVAILABLE');
  expect(await g.loadGuestSession()).toBeNull();
});
test('expiring the credential keeps the booking reference; only explicit/confirmed clearing removes it', async () => {
  await g.saveGuestSession(sess); await g.saveLastBooking('booking-1');
  await g.clearCredential();
  expect(await g.loadGuestSession()).toBeNull(); expect(await g.loadLastBooking()).toBe('booking-1');
  await g.clearBookingContext(); expect(await g.loadLastBooking()).toBeNull();
});
test('an expired stored session is dropped but the booking reference stays', async () => {
  await g.saveGuestSession({ ...sess, expiresAt: new Date(Date.now() - 1000).toISOString() }); await g.saveLastBooking('booking-1');
  expect(await g.loadGuestSession()).toBeNull(); expect(await g.loadLastBooking()).toBe('booking-1');
});
