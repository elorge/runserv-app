import { routeForNotification } from '../notifications';
jest.mock('../../services/api', () => ({ __esModule: true, default: { post: jest.fn(), delete: jest.fn() } }));
jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(), setItem: jest.fn() }));
jest.mock('react-native', () => ({ Alert: { alert: jest.fn() }, Platform: { OS: 'android' } }));
test('routeForNotification maps payloads defensively', () => {
  expect(routeForNotification({ route: 'Wallet' })).toEqual({ name: 'Wallet', params: undefined });
  expect(routeForNotification({ type: 'RIDE_ACCEPTED', rideId: 'r1' })).toEqual({ name: 'RideDetails', params: { rideId: 'r1' } });
  expect(routeForNotification({ type: 'PAYOUT_FAILED' })).toEqual({ name: 'Wallet' });
  expect(routeForNotification({})).toBeNull();
  expect(routeForNotification(undefined)).toBeNull();
});
