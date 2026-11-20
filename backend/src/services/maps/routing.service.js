// backend/src/services/maps/routing.service.js
//
// M14: road routing behind provider adapters. The app asks THIS server (POST /api/maps/route); the server asks OSRM or Google.
// Result shape is identical for every provider:  { coords:[{latitude,longitude}], distanceM, durationS, provider }
// So switching provider is a setting, and nothing downstream (app, tracking, snapping) changes.
'use strict';

const axios = require('axios');
const { logger } = require('../../utils/logger');
const mapConfig = require('./mapConfig.service');

const TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 2000;
const cache = new Map(); // key -> { at, value }

const valid = (p) => p && Number.isFinite(+p.latitude) && Number.isFinite(+p.longitude) && Math.abs(+p.latitude) <= 90 && Math.abs(+p.longitude) <= 180;

/** Google "encoded polyline" (precision 5) -> [{latitude, longitude}] */
const decodePolyline = (str) => {
  const out = []; let i = 0; let lat = 0; let lng = 0;
  while (i < str.length) {
    for (const axis of ['lat', 'lng']) {
      let shift = 0; let result = 0; let b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i <= str.length);
      const d = (result & 1) ? ~(result >> 1) : (result >> 1);
      if (axis === 'lat') lat += d; else lng += d;
    }
    out.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }
  return out;
};

const osrmBase = (env = process.env) => {
  if (!mapConfig.osrmConfigured(env) && !mapConfig.demoAllowed(env)) throw new Error('OSRM_URL is not configured (the public demo server is refused in production)');
  return (env.OSRM_URL || env.ROUTING_URL || 'https://router.project-osrm.org').replace(/\/+$/, '');
};

const adapters = {
  osrm: async (from, to, env = process.env) => {
    const url = `${osrmBase(env)}/route/v1/driving/${+from.longitude},${+from.latitude};${+to.longitude},${+to.latitude}?overview=full&geometries=geojson`;
    const { data } = await axios.get(url, { timeout: TIMEOUT_MS });
    const r = data?.routes?.[0];
    if (!r?.geometry?.coordinates?.length) throw new Error('OSRM returned no route');
    return { coords: r.geometry.coordinates.map(([lng, lat]) => ({ latitude: lat, longitude: lng })), distanceM: r.distance, durationS: r.duration };
  },
  google: async (from, to, env = process.env) => {
    const key = mapConfig.googleKeyForRouting(env);
    if (!key) throw new Error('Google routing key not configured');
    const ll = (p) => ({ location: { latLng: { latitude: +p.latitude, longitude: +p.longitude } } });
    const { data } = await axios.post('https://routes.googleapis.com/directions/v2:computeRoutes',
      { origin: ll(from), destination: ll(to), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE', polylineEncoding: 'ENCODED_POLYLINE' },
      { timeout: TIMEOUT_MS, headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline', 'Content-Type': 'application/json' } });
    const r = data?.routes?.[0];
    if (!r?.polyline?.encodedPolyline) throw new Error('Google returned no route');
    return { coords: decodePolyline(r.polyline.encodedPolyline), distanceM: Number(r.distanceMeters), durationS: parseFloat(String(r.duration || '0').replace('s', '')) };
  },
};

const ck = (a, b) => [a.latitude, a.longitude, b.latitude, b.longitude].map((n) => Number(n).toFixed(4)).join(',');

/**
 * Route between two points using the configured provider; on failure optionally try the other one.
 * @returns {Promise<{coords, distanceM, durationS, provider}|null>}  null = no route (the app draws a straight line)
 */
const routeBetween = async (from, to, { env = process.env, config } = {}) => {
  if (!valid(from) || !valid(to)) return null;
  const cfg = config || await mapConfig.getConfig(env);
  const k = `${cfg.routing}|${ck(from, to)}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const order = [cfg.routing];
  const other = cfg.routing === 'google' ? 'osrm' : 'google';
  if (cfg.routingFallback !== false && mapConfig.availability(env).routing[other]) order.push(other);

  for (const name of order) {
    try {
      const r = await adapters[name](from, to, env);
      const value = { ...r, provider: name };
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(k, { at: Date.now(), value });
      return value;
    } catch (e) {
      logger?.warn?.(`[maps] ${name} routing failed: ${e.message}`);
    }
  }
  return null;
};

const clearCache = () => cache.clear();

module.exports = { routeBetween, decodePolyline, adapters, clearCache, valid };
