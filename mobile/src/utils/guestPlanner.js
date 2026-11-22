// mobile/src/utils/guestPlanner.js — pure helpers for the guest Trip Planner (no React, no network).
//
// Rule: distance, ETA and fares are whatever the SERVER returned from POST /guest/quote. Nothing here invents them.
import { parseApiError } from './apiError';

/** Places "session token" (groups keystrokes + the final details call into one billable session). */
export const newSessionToken = (rand = Math.random) =>
  Array.from({ length: 24 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rand() * 36)]).join('');

/** A suggestion is only "ready" when it has coordinates (Photon) or still needs a details lookup (Google). */
export const needsDetails = (s) => !!s && s.provider === 'google' && !(Number.isFinite(s.lat) && Number.isFinite(s.lng));

/** Normalise a suggestion/details pair into the place the planner stores: { label, latitude, longitude } or null. */
export function toPlace(suggestion, details) {
  const lat = Number(details?.lat ?? suggestion?.lat);
  const lng = Number(details?.lng ?? suggestion?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const label = String(details?.formattedAddress || suggestion?.description || suggestion?.mainText || '').trim();
  return { label: label || `${lat.toFixed(4)}, ${lng.toFixed(4)}`, latitude: lat, longitude: lng };
}

/** Same point twice is not a trip. ~11 m tolerance. */
export const samePlace = (a, b) => !!a && !!b && Math.abs(a.latitude - b.latitude) < 1e-4 && Math.abs(a.longitude - b.longitude) < 1e-4;

/** Project route coordinates into an SVG box. Returns { points:'x,y x,y…', start:{x,y}, end:{x,y} } or null. Keeps aspect ratio. */
export function routeToPath(coords, width, height, pad = 14, maxPoints = 200) {
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const step = Math.max(1, Math.ceil(coords.length / maxPoints));
  const pts = coords.filter((_, i) => i % step === 0 || i === coords.length - 1);
  const lats = pts.map((p) => p.latitude); const lngs = pts.map((p) => p.longitude);
  const minLat = Math.min(...lats); const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs); const maxLng = Math.max(...lngs);
  // longitude degrees shrink with latitude: correct so the shape is not stretched
  const k = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const spanX = Math.max((maxLng - minLng) * k, 1e-6); const spanY = Math.max(maxLat - minLat, 1e-6);
  const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
  const offX = (width - spanX * scale) / 2; const offY = (height - spanY * scale) / 2;
  const xy = (p) => ({ x: Math.round((offX + (p.longitude - minLng) * k * scale) * 10) / 10, y: Math.round((offY + (maxLat - p.latitude) * scale) * 10) / 10 });
  const proj = pts.map(xy);
  return { points: proj.map((p) => `${p.x},${p.y}`).join(' '), start: proj[0], end: proj[proj.length - 1] };
}

export const formatKm = (m) => `${(Math.max(0, Number(m) || 0) / 1000).toFixed(1)} km`;
export const formatMinutes = (s) => { const m = Math.max(1, Math.round((Number(s) || 0) / 60)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

/** Seconds left on a quote (0 when expired). The server re-validates at confirmation; this only drives the UI. */
export const secondsLeft = (expiresAt, now = Date.now()) => Math.max(0, Math.floor((Number(expiresAt) - now) / 1000));
export const isExpired = (expiresAt, now = Date.now()) => !(Number(expiresAt) > now);

/** Friendly message for a failed /guest/quote call. */
export function quoteErrorMessage(err) {
  // services/api.js rejects with the response body (+ status), so read it through parseApiError rather than err.response.
  const p = parseApiError(err);
  if (p.code === 'ROUTE_UNAVAILABLE') return 'We could not find a route between these places. Try different locations.';
  if (p.code === 'GUEST_PLANNING_DISABLED' || p.status === 404) return 'Trip planning is not available yet.';
  if (p.status === 429) return 'Too many requests. Please wait a moment and try again.';
  if (p.network) return 'No connection. Check your network and try again.';
  return 'Could not get an estimate. Please try again.';
}
