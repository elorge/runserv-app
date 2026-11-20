// mobile/src/services/routing.js
// Road-following routes (OSRM-compatible). Default is the public OSRM demo server, which is for
// DEVELOPMENT ONLY (and is no longer used outside __DEV__). For production set EXPO_PUBLIC_ROUTING_URL to your own OSRM/Valhalla (OSRM API) or a hosted provider.
// If routing fails, callers fall back to a straight line, so the map never breaks.
import api from './api';
// Production: NEVER the public demo server. A direct fallback exists only if you set your own EXPO_PUBLIC_ROUTING_URL, or in development.
const BASE = process.env.EXPO_PUBLIC_ROUTING_URL || (typeof __DEV__ !== 'undefined' && __DEV__ ? 'https://router.project-osrm.org' : null);
const cache = new Map();

const key = (a, b) => [a.latitude, a.longitude, b.latitude, b.longitude].map((n) => Number(n).toFixed(4)).join(',');

// M14: routes now come from OUR server (POST /api/maps/route), which uses whichever provider you selected in the admin console
// (OSRM or Google). API keys stay on the server. The direct OSRM call below is only a last-resort fallback.
async function fetchViaServer(from, to) {
  try {
    const res = await api.post('/maps/route', { from: { latitude: from.latitude, longitude: from.longitude }, to: { latitude: to.latitude, longitude: to.longitude } }, { timeout: 8000 });
    const d = res?.data?.data ?? res?.data;
    if (d?.coords?.length) return { coords: d.coords, distanceM: d.distanceM, durationS: d.durationS };
  } catch { /* fall through */ }
  return null;
}

export async function fetchRoadRoute(from, to, { signal } = {}) {
  if (!from || !to) return null;
  const k = key(from, to);
  if (cache.has(k)) return cache.get(k);
  const viaServer = await fetchViaServer(from, to);
  if (viaServer) { cache.set(k, viaServer); return viaServer; }
  if (!BASE) return null; // caller draws a straight line; the map never breaks
  try {
    const url = `${BASE}/route/v1/driving/${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=full&geometries=geojson`;
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const json = await res.json();
    const r = json?.routes?.[0];
    if (!r?.geometry?.coordinates?.length) return null;
    const out = {
      coords: r.geometry.coordinates.map(([lng, lat]) => ({ latitude: lat, longitude: lng })),
      distanceM: r.distance,
      durationS: r.duration, // an estimate, not a guarantee
    };
    cache.set(k, out);
    return out;
  } catch {
    return null;
  }
}

const toRad = (d) => (d * Math.PI) / 180;
const bearing = (a, b) => {
  const dLng = toRad(b.longitude - a.longitude);
  const y = Math.sin(dLng) * Math.cos(toRad(b.latitude));
  const x = Math.cos(toRad(a.latitude)) * Math.sin(toRad(b.latitude)) -
    Math.sin(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
};

/**
 * Snap a GPS point onto the route so the car sits on the road and faces the road direction.
 * Returns { latitude, longitude, heading, offRouteM } or null when no route / too far (> maxM).
 */
export function snapToRoute(coords, p, maxM = 40) {
  if (!coords || coords.length < 2 || !p) return null;
  const kx = 111320 * Math.cos(toRad(p.latitude)); const ky = 111320;
  let best = null;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1];
    const ax = (a.longitude - p.longitude) * kx, ay = (a.latitude - p.latitude) * ky;
    const bx = (b.longitude - p.longitude) * kx, by = (b.latitude - p.latitude) * ky;
    const dx = bx - ax, dy = by - ay; const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const cx = ax + t * dx, cy = ay + t * dy; const dist = Math.sqrt(cx * cx + cy * cy);
    if (!best || dist < best.dist) {
      best = { dist, i, latitude: a.latitude + t * (b.latitude - a.latitude), longitude: a.longitude + t * (b.longitude - a.longitude) };
    }
  }
  if (!best || best.dist > maxM) return null;
  return { latitude: best.latitude, longitude: best.longitude, heading: bearing(coords[best.i], coords[best.i + 1]), offRouteM: best.dist };
}
