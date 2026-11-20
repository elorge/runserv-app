// mobile/src/utils/liveFix.js — helpers for the customer's tracking screens.
export const STALE_AFTER_MS = 90 * 1000;      // same as the server (tracking.service STALE_AFTER_MS)

/** Server position (API `driverLocation` / `partnerLocation`, or a socket update) -> the fix the map takes. null if unusable. */
export function toFix(d) {
  if (!d) return null;
  const lat = d.lat ?? d.latitude, lng = d.lng ?? d.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const ts = d.timestamp ?? d.updatedAt ?? d.lastLocationAt;
  const ms = typeof ts === 'number' ? ts : ts ? Date.parse(ts) : NaN;
  return {
    latitude: lat, longitude: lng,
    heading: Number.isFinite(d.heading) ? d.heading : undefined,
    speed: Number.isFinite(d.speed) ? d.speed : undefined,
    accuracy: Number.isFinite(d.accuracy) ? d.accuracy : undefined,
    timestamp: Number.isFinite(ms) ? ms : Date.now(),
  };
}
export const isStale = (fix, now = Date.now()) => !!fix && now - fix.timestamp > STALE_AFTER_MS;
/** "1 min", "5 min", "2 h": for the "Last seen … ago" label. */
export function agoLabel(fix, now = Date.now()) {
  const s = Math.max(0, Math.round((now - fix.timestamp) / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
}
