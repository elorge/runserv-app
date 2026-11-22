// mobile/src/services/earnerDraft.js
//
// The driver / courier "pass" draft: what a visitor played with in the signed-out Earnings Simulator (drivers) or
// Parcel Run (couriers) BEFORE creating an account. Stored on the device only (AsyncStorage). It survives app restarts,
// sign-up, OTP and Google sign-in, and is shown again on the Road-to-online screen once they are in.
//
// The pass code is a LOCAL PREVIEW identifier only: it is not an application ID, approval code, driver ID or booking reference.
// It holds the visitor's CHOICES and the estimate that followed from them, never a promise: no income claims are stored.
import AsyncStorage from '@react-native-async-storage/async-storage';

const DRAFT_KEY = '@runserv_earner_draft';
const SEEN_KEY  = '@runserv_earner_preview_seen';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // onboarding (documents, review) takes longer than a trip: a month

export const PATHS = ['DRIVER', 'COURIER'];
export const ROLE_FOR_PATH = { DRIVER: 'DRIVER', COURIER: 'DELIVERY_PARTNER' };
export const PATH_FOR_ROLE = { DRIVER: 'DRIVER', DELIVERY_PARTNER: 'COURIER' };

/** No 0/O/1/I so it can be read out loud. DP- = Driver Pass, CP- = Courier Pass. */
export const newPassCode = (path = 'DRIVER') => {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i += 1) s += A[Math.floor(Math.random() * A.length)];
  return `${path === 'COURIER' ? 'CP' : 'DP'}-${s}`;
};

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

/** Accepts only a well-formed draft; anything else is dropped rather than half-trusted. Exported for tests. */
export function sanitizeDraft(d, now = Date.now()) {
  if (!d || d.v !== 1 || !PATHS.includes(d.path)) return null;
  if (!isNum(d.updatedAt) || now - d.updatedAt > MAX_AGE_MS) return null;
  const out = {
    v: 1, path: d.path,
    passCode: typeof d.passCode === 'string' && /^(DP|CP)-[A-Z0-9]{4}$/.test(d.passCode) ? d.passCode : newPassCode(d.path),
    step: Number.isInteger(d.step) ? Math.min(4, Math.max(0, d.step)) : 0,
    currency: typeof d.currency === 'string' ? d.currency : 'NGN',
    countryCode: typeof d.countryCode === 'string' ? d.countryCode : 'NG',
    createdAt: isNum(d.createdAt) ? d.createdAt : d.updatedAt,
    updatedAt: d.updatedAt,
    summary: d.summary && typeof d.summary === 'object' ? d.summary : null,
  };
  const dr = d.driver;
  if (dr && typeof dr === 'object') {
    out.driver = {
      vehicleType: ['TRICYCLE', 'MOTORCYCLE', 'CAR', 'VAN'].includes(dr.vehicleType) ? dr.vehicleType : 'CAR',
      hours: isNum(dr.hours) ? Math.min(14, Math.max(2, Math.round(dr.hours))) : 8,
      days: Array.isArray(dr.days) ? [...new Set(dr.days.filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))].sort() : [0, 1, 2, 3, 4],
      multiplier: isNum(dr.multiplier) ? Math.min(1.3, Math.max(1, dr.multiplier)) : 1,
    };
    if (!out.driver.days.length) out.driver.days = [0, 1, 2, 3, 4];
  }
  const co = d.courier;
  if (co && typeof co === 'object') {
    out.courier = {
      km: isNum(co.km) ? Math.min(30, Math.max(1, Math.round(co.km))) : 6,
      parcel: ['DOCUMENT', 'SMALL', 'MEDIUM', 'LARGE'].includes(co.parcel) ? co.parcel : 'SMALL',
      shiftHours: isNum(co.shiftHours) ? Math.min(12, Math.max(2, Math.round(co.shiftHours))) : 8,
      multiplier: isNum(co.multiplier) ? Math.min(1.3, Math.max(1, co.multiplier)) : 1,
    };
  }
  return out;
}

export async function loadEarnerDraft() {
  try {
    const raw = await AsyncStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = sanitizeDraft(JSON.parse(raw));
    if (!d) { await AsyncStorage.removeItem(DRAFT_KEY); return null; }
    return d;
  } catch { return null; }
}

/** True when `code` is a well-formed pass code FOR THIS PATH (a Driver Pass is never a Courier Pass). */
export const isPassCodeForPath = (code, path) =>
  typeof code === 'string' && new RegExp(`^${path === 'COURIER' ? 'CP' : 'DP'}-[A-Z0-9]{4}$`).test(code);

/**
 * Pure merge used by saveEarnerDraft (exported for tests). ONE place decides the pass code:
 *   1. the caller's `patch.passCode`, if it is valid for the path being saved (the screen generated it once);
 *   2. else the stored code, if the path did not change and the code is valid;
 *   3. else a freshly generated code for the path.
 * So the code the screen shows and the code that is persisted can never diverge.
 */
export function mergeDraft(prev, patch, now = Date.now()) {
  const path = patch.path || prev?.path || 'DRIVER';
  let passCode;
  if (isPassCodeForPath(patch.passCode, path)) passCode = patch.passCode;
  else if (prev && prev.path === path && isPassCodeForPath(prev.passCode, path)) passCode = prev.passCode;
  else passCode = newPassCode(path);
  return { ...(prev || { createdAt: now }), ...patch, path, passCode, v: 1, updatedAt: now };
}

/** Saves the draft and returns the SAVED draft (callers should adopt `saved.passCode`), or null if storage failed. */
export async function saveEarnerDraft(patch) {
  try {
    const prev = await loadEarnerDraft();
    const next = mergeDraft(prev, patch);
    await AsyncStorage.setItem(DRAFT_KEY, JSON.stringify(next));
    return next;
  } catch { return null; }
}

export async function clearEarnerDraft() {
  try { await AsyncStorage.removeItem(DRAFT_KEY); } catch {}
}

/** First-run flag: the simulator is the Driver app's front door until the visitor has moved on once. */
export async function markEarnerPreviewSeen() {
  try { await AsyncStorage.setItem(SEEN_KEY, '1'); } catch {}
}
export async function hasSeenEarnerPreview() {
  try { return (await AsyncStorage.getItem(SEEN_KEY)) === '1'; } catch { return true; }
}
