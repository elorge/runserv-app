// src/utils/notifications.js
// Push: permission, FCM token, registration with the Runserv API (POST/DELETE /notifications/devices), tap routing.
// Every Firebase call is defensive: a missing/unconfigured native module must never crash the app.
import { Alert, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api from '../services/api';

let messaging = null;
try { messaging = require('@react-native-firebase/messaging').default; } catch { messaging = null; }

const DEVICE_KEY = 'pushDeviceId';
const platform = () => (Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web');
const deviceId = async () => {
  try {
    let id = await AsyncStorage.getItem(DEVICE_KEY);
    if (!id) { id = `${Platform.OS}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; await AsyncStorage.setItem(DEVICE_KEY, id); }
    return id;
  } catch { return undefined; }
};

export const requestUserPermission = async () => {
  if (!messaging) return false;
  try {
    const s = await messaging().requestPermission();
    const ok = s === messaging.AuthorizationStatus.AUTHORIZED || s === messaging.AuthorizationStatus.PROVISIONAL;
    if (ok) await getFCMToken();
    return ok;
  } catch { return false; }
};

export const getFCMToken = async () => {
  if (!messaging) return null;
  try { const t = await messaging().getToken(); await AsyncStorage.setItem('fcmToken', t); return t; } catch { return null; }
};

/** Tell the API about this device's token (idempotent). Call when signed in, and again when the token rotates. */
export const registerDeviceToken = async (token) => {
  try {
    const t = token || (await AsyncStorage.getItem('fcmToken')) || (await getFCMToken());
    if (!t) return false;
    await api.post('/notifications/devices', { token: t, platform: platform(), deviceId: await deviceId() });
    return true;
  } catch { return false; }
};

/** Call BEFORE the auth token is cleared (the API needs it). */
export const unregisterDeviceToken = async () => {
  try {
    const t = await AsyncStorage.getItem('fcmToken');
    const id = await deviceId();
    if (!t && !id) return false;
    await api.delete('/notifications/devices', { data: { token: t || undefined, deviceId: t ? undefined : id } });
    return true;
  } catch { return false; }
};

/** Map a push payload (data.route / data.type) to a navigation target. Returns { name, params } or null. */
export const routeForNotification = (data = {}) => {
  const id = data.id || data.rideId || data.deliveryId || data.bookingId;
  if (data.route) return { name: String(data.route), params: id ? { id } : undefined };
  const t = String(data.type || '').toUpperCase();
  if (t.startsWith('RIDE')) return { name: 'RideDetails', params: { rideId: data.rideId || id } };
  if (t.startsWith('DELIVERY') || t.startsWith('POD')) return { name: 'DeliveryDetails', params: { deliveryId: data.deliveryId || id } };
  if (t.startsWith('WALLET') || t.startsWith('PAYMENT') || t.startsWith('PAYOUT')) return { name: 'Wallet' };
  return t ? { name: 'Notifications' } : null;
};

export const setupNotificationListeners = (navigate) => {
  if (!messaging) return () => {};
  const unsubs = [];
  try {
    unsubs.push(messaging().onMessage(async (m) => { Alert.alert(m?.notification?.title || 'New Notification', m?.notification?.body || ''); }));
    unsubs.push(messaging().onTokenRefresh((t) => { AsyncStorage.setItem('fcmToken', t).catch(() => {}); registerDeviceToken(t); }));
    messaging().setBackgroundMessageHandler(async () => {});
    const go = (m) => { const r = routeForNotification(m?.data); if (r && navigate) navigate(r.name, r.params); };
    unsubs.push(messaging().onNotificationOpenedApp(go));
    messaging().getInitialNotification().then((m) => { if (m) go(m); }).catch(() => {});
  } catch { /* firebase not configured */ }
  return () => unsubs.forEach((u) => { try { u && u(); } catch { /* ignore */ } });
};
