import { routeForNotification } from '../notifications';
jest.mock('../../services/api', () => ({ __esModule: true, default: { post: jest.fn(), delete: jest.fn() } }));
jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(), setItem: jest.fn() }));
jest.mock('react-native', () => ({ Alert: { alert: jest.fn() }, Platform: { OS: 'android' } }));
jest.mock('../../config/variant', () => ({ APP_VARIANT: { id: 'customer' } }));
test('routeForNotification maps backend route keys to real screens (customer app)', () => {
  expect(routeForNotification({ route: 'ride', rideId: 'r1' })).toEqual({ name: 'HomeTab', params: { screen: 'RideTracking', params: { rideId: 'r1' } } });
  expect(routeForNotification({ route: 'delivery', deliveryId: 'd1' })).toEqual({ name: 'HomeTab', params: { screen: 'DeliveryTracking', params: { deliveryId: 'd1' } } });
  expect(routeForNotification({ route: 'wallet' })).toEqual({ name: 'WalletTab' });
  expect(routeForNotification({ route: 'account' })).toEqual({ name: 'ProfileTab' });
  expect(routeForNotification({ route: 'ride' })).toEqual({ name: 'HomeTab', params: { screen: 'Notifications' } });
  expect(routeForNotification({ type: 'PAYOUT_FAILED' })).toEqual({ name: 'WalletTab' });
  expect(routeForNotification({})).toBeNull();
  expect(routeForNotification(undefined)).toBeNull();
});
