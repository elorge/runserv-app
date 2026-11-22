// mobile/src/services/guestSession.js
//
// Where the guest keeps (1) the phone-verification session and (2) the in-flight booking attempt.
//   * The session token is a credential for this phone number's bookings: it lives in the secure store (Keychain / Keystore),
//     never in AsyncStorage, never in logs. It expires on the server (about 2 hours) and is dropped here the moment it does.
//   * The attempt (idempotency key + request fingerprint) is not sensitive. It is saved BEFORE the request is sent, so if the app
//     dies mid-request the next tap reuses the same key and the server hands back the original booking instead of booking twice.
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { sessionUsable } from '../utils/guestBooking';

const SESSION_KEY = 'runserv_guest_session';
const ATTEMPT_KEY = '@runserv_guest_attempt';
const LAST_KEY = '@runserv_guest_last_booking';

let cache; // undefined = not loaded yet

export async function loadGuestSession(now = Date.now()) {
  if (cache === undefined) {
    try { const raw = await SecureStore.getItemAsync(SESSION_KEY); cache = raw ? JSON.parse(raw) : null; } catch { cache = null; }
  }
  if (cache && !sessionUsable(cache, now)) { await clearGuestSession(); return null; }
  return cache || null;
}

/**
 * s = { session, expiresAt, email? (masked), phone? (masked), countryCode, channel } straight from POST /guest/otp/verify.
 * M16.1: FAILS CLOSED. The credential is written to the secure store and READ BACK; if either step fails this rejects and nothing is
 * kept in memory, so the caller never treats the guest as verified while the device could not actually hold the credential.
 */
export async function saveGuestSession(s) {
  const next = { session: s.session, expiresAt: s.expiresAt, phone: s.phone, email: s.email, countryCode: s.countryCode, channel: s.channel };
  const raw = JSON.stringify(next);
  try {
    await SecureStore.setItemAsync(SESSION_KEY, raw);
    const back = await SecureStore.getItemAsync(SESSION_KEY);
    if (back !== raw) throw new Error('read-back mismatch');
  } catch {
    cache = null;
    try { await SecureStore.deleteItemAsync(SESSION_KEY); } catch { /* best effort */ }
    throw new Error('SECURE_STORAGE_UNAVAILABLE');
  }
  cache = next;
  return cache;
}

/** The CREDENTIAL only (session expiry, "use a different address"). The booking reference is kept: see clearBookingContext. */
export const clearCredential = () => clearGuestSession();
/** The non-secret booking context (last booking id + in-flight attempt). Only after explicit user action, closure, or confirmed conversion. */
export async function clearBookingContext() { await Promise.all([clearAttempt(), clearLastBooking()]); }

export async function clearGuestSession() {
  cache = null;
  try { await SecureStore.deleteItemAsync(SESSION_KEY); } catch { /* nothing to clear */ }
}

export async function loadAttempt() { try { const r = await AsyncStorage.getItem(ATTEMPT_KEY); return r ? JSON.parse(r) : null; } catch { return null; } }
export async function saveAttempt(a) { try { await AsyncStorage.setItem(ATTEMPT_KEY, JSON.stringify(a)); } catch { /* best effort */ } }
export async function clearAttempt() { try { await AsyncStorage.removeItem(ATTEMPT_KEY); } catch { /* nothing to clear */ } }

/** The booking the guest was last looking at, so reopening the app resumes it. */
export async function saveLastBooking(id) { try { await AsyncStorage.setItem(LAST_KEY, String(id)); } catch { /* best effort */ } }
export async function loadLastBooking() { try { return await AsyncStorage.getItem(LAST_KEY); } catch { return null; } }
export async function clearLastBooking() { try { await AsyncStorage.removeItem(LAST_KEY); } catch { /* nothing to clear */ } }

/** Everything guest-related: only after a server-confirmed account conversion or an explicit "forget this booking". */
export async function clearAllGuestState() { await Promise.all([clearGuestSession(), clearAttempt(), clearLastBooking()]); }

/** Forget the in-memory copy so the next load re-reads the secure store (used on cold start paths and by tests). */
export function resetGuestSessionCache() { cache = undefined; }
