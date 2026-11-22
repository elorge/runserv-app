// M16: guest and registered sessions must never mix. Renders the real AuthProvider with storage / network mocked.
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';

const mockSecure = {};
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k) => (k in mockSecure ? mockSecure[k] : null)),
  setItemAsync: jest.fn(async (k, v) => { mockSecure[k] = v; }),
  deleteItemAsync: jest.fn(async (k) => { delete mockSecure[k]; }),
}));
jest.mock('../../services/api', () => ({ authAPI: { logout: jest.fn(async () => ({})), login: jest.fn(), register: jest.fn() } }));
jest.mock('../../services/socket', () => ({ __esModule: true, default: { connect: jest.fn(() => Promise.resolve()), disconnect: jest.fn() } }));
jest.mock('../../services/authEvents', () => ({ onForceLogout: () => () => {}, suppressForceLogout: jest.fn() }));

const { AuthProvider, useAuth } = require('../AuthContext');
const socket = require('../../services/socket').default;

let ctx;
const Probe = () => { ctx = useAuth(); return null; };
const mount = async () => { await act(async () => { TestRenderer.create(<AuthProvider><Probe /></AuthProvider>); }); };
const goodSession = () => ({ session: 's'.repeat(40), expiresAt: new Date(Date.now() + 3600_000).toISOString(), phone: '+234****678', countryCode: 'NG' });

beforeEach(async () => { require('../../services/guestSession').resetGuestSessionCache(); await AsyncStorage.clear(); Object.keys(mockSecure).forEach((k) => delete mockSecure[k]); socket.connect.mockClear(); });

test('guest-only: adopting a session sets guest state and leaves registered auth untouched', async () => {
  await mount();
  let r; await act(async () => { r = await ctx.adoptSession(goodSession()); });
  expect(r).toEqual({ success: true });
  expect(ctx.guestSession.phone).toBe('+234****678');
  expect(ctx.user).toBeNull(); expect(ctx.token).toBeNull();
  expect(await AsyncStorage.getItem('authToken')).toBeNull(); expect(await AsyncStorage.getItem('user')).toBeNull();
  expect(socket.connect).not.toHaveBeenCalled();
  expect(mockSecure.runserv_guest_session).toBeDefined();
});

test('an invalid or expired session is refused with a structured result', async () => {
  await mount();
  let r; await act(async () => { r = await ctx.adoptSession({ session: 'short' }); });
  expect(r.success).toBe(false); expect(r.message).toBeTruthy(); expect(ctx.guestSession).toBeNull();
  await act(async () => { r = await ctx.adoptSession({ ...goodSession(), expiresAt: new Date(Date.now() - 1000).toISOString() }); });
  expect(r.success).toBe(false);
});

test('registered-only: a stored registered login does not create a guest session', async () => {
  await AsyncStorage.multiSet([['authToken', 't'.repeat(30)], ['user', JSON.stringify({ id: 'u1', role: 'CUSTOMER' })]]);
  await mount();
  expect(ctx.user).toMatchObject({ id: 'u1' }); expect(ctx.guestSession).toBeNull();
});

test('conversion starts the registered session and clears guest credentials', async () => {
  await mount();
  await act(async () => { await ctx.adoptSession(goodSession()); });
  let r; await act(async () => { r = await ctx.completeConversion({ token: 'T'.repeat(30), user: { id: 'u9', role: 'CUSTOMER' } }); });
  expect(r.success).toBe(true);
  expect(ctx.user.id).toBe('u9'); expect(ctx.guestSession).toBeNull();
  expect(await AsyncStorage.getItem('authToken')).toBe('T'.repeat(30));
  expect(mockSecure.runserv_guest_session).toBeUndefined();
});

test('a malformed conversion payload never promotes the guest to a registered user', async () => {
  await mount();
  await act(async () => { await ctx.adoptSession(goodSession()); });
  let r; await act(async () => { r = await ctx.completeConversion({ token: 'x' }); });
  expect(r.success).toBe(false); expect(ctx.user).toBeNull(); expect(ctx.guestSession).not.toBeNull();
});

test('ending the guest session clears only the guest credential; registered logout leaves the guest one alone', async () => {
  await AsyncStorage.multiSet([['authToken', 't'.repeat(30)], ['user', JSON.stringify({ id: 'u1', role: 'CUSTOMER' })]]);
  await mount();
  await act(async () => { await ctx.adoptSession(goodSession()); });
  await act(async () => { await ctx.logout(); });
  expect(ctx.user).toBeNull(); expect(ctx.guestSession).not.toBeNull();
  await act(async () => { await ctx.endGuestSession(); });
  expect(ctx.guestSession).toBeNull(); expect(mockSecure.runserv_guest_session).toBeUndefined();
});

test('a guest session that has expired is dropped on load', async () => {
  mockSecure.runserv_guest_session = JSON.stringify({ ...goodSession(), expiresAt: new Date(Date.now() - 5000).toISOString() });
  await mount();
  expect(ctx.guestSession).toBeNull();
});
