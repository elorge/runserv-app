// mobile/src/utils/guestLocation.js — pure helpers for the guest location picker.
import { parseApiError } from './apiError';
import { samePlace } from './guestPlanner';

/** The normalised location handed back to the Trip Planner: { latitude, longitude, address, label, placeId? }. `label` mirrors `address` for older helpers. */
export function normalizeLocation({ latitude, longitude, address, placeId } = {}) {
  const la = Number(latitude); const ln = Number(longitude);
  const addr = String(address || '').trim();
  if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180 || (la === 0 && ln === 0)) return null;
  if (!addr) return null;
  return { latitude: la, longitude: ln, address: addr, label: addr, ...(placeId ? { placeId: String(placeId) } : {}) };
}

/** { ok, reason } — a location needs coordinates AND a readable address, and pickup/destination must differ. */
export function validateLocation(loc, other = null) {
  if (!normalizeLocation(loc || {})) return { ok: false, reason: 'INVALID' };
  if (other && samePlace(loc, other)) return { ok: false, reason: 'SAME_AS_OTHER' };
  return { ok: true };
}

export const LOCATION_ERRORS = {
  INVALID: 'Choose a place with a clear address.',
  SAME_AS_OTHER: 'Pickup and destination must be different places.',
  PERMISSION_DENIED: 'Location permission is off. You can still search for an address or move the pin on the map.',
  UNAVAILABLE: 'We could not read your location. Search for an address or move the pin on the map.',
  REVERSE_FAILED: 'We could not find an address for this spot. Search for it instead, or move the pin slightly.',
};

/** Reverse-geocode response -> { address, approximate } (never invents an address). */
export function addressFromReverse(res) {
  const d = res?.data || res || {};
  const address = String(d.formattedAddress || d.address || d.description || '').trim();
  return { address, approximate: !address };
}

export function reverseErrorKey(err) { const p = parseApiError(err); return p.network ? 'UNAVAILABLE' : 'REVERSE_FAILED'; }

/** Debounce delay for typing and the minimum characters before a search (the server needs 2; 3 keeps results useful and cheaper). */
export const SEARCH_DEBOUNCE_MS = 350;
export const SEARCH_MIN_CHARS = 3;
