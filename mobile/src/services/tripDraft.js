// mobile/src/services/tripDraft.js
//
// The "Boarding Pass" draft: a trip a visitor planned BEFORE creating an account.
// Stored on-device only (AsyncStorage). It survives app restarts, sign-up, email/OTP
// verification and Google sign-in, and is picked up by HomeScreen once the person is in.
//
// What it holds is deliberately small and honest: distance, vehicle, an estimated fare and a
// pass code. It does NOT hold a made-up destination — the real pickup/drop-off are chosen on
// the real booking screen, where GPS and Places search are available.
import AsyncStorage from '@react-native-async-storage/async-storage';

const DRAFT_KEY = '@runserv_trip_draft';
const SEEN_KEY  = '@runserv_trip_preview_seen';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // a week

export const newPassCode = () => {
  // No 0/O/1/I so it can be read out loud.
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i += 1) s += A[Math.floor(Math.random() * A.length)];
  return `RS-${s}`;
};

export async function loadTripDraft() {
  try {
    const raw = await AsyncStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || d.v !== 1 || !Number.isFinite(d.distanceKm)) return null;
    if (Date.now() - (d.updatedAt || 0) > MAX_AGE_MS) { await AsyncStorage.removeItem(DRAFT_KEY); return null; }
    return d;
  } catch { return null; }
}

export async function saveTripDraft(patch) {
  try {
    const prev = (await loadTripDraft()) || { v: 1, passCode: newPassCode(), createdAt: Date.now() };
    const next = { ...prev, ...patch, v: 1, updatedAt: Date.now() };
    await AsyncStorage.setItem(DRAFT_KEY, JSON.stringify(next));
    return next;
  } catch { return null; }
}

export async function clearTripDraft() {
  try { await AsyncStorage.removeItem(DRAFT_KEY); } catch {}
}

/** First-run flag: the preview is the front door until the visitor has moved on once. */
export async function markPreviewSeen() {
  try { await AsyncStorage.setItem(SEEN_KEY, '1'); } catch {}
}
export async function hasSeenPreview() {
  try { return (await AsyncStorage.getItem(SEEN_KEY)) === '1'; } catch { return true; }
}
