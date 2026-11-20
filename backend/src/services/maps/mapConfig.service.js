// backend/src/services/maps/mapConfig.service.js
//
// M14: ONE runtime setting that decides which map technology Runserv uses — stored in SystemSettings, changed from the admin
// console, NO code change, rebuild or redeploy.
//
//   renderer : how the app DRAWS the map        maplibre | google | osm
//   routing  : who computes road routes         osrm | google          (always called through THIS server; keys never reach the app)
//   places   : who powers address search        auto | photon | google (auto = google when its key exists, else photon)
//   styleUrl : MapLibre tile style (https) — lets you move to MapTiler / your own tiles without an app update
//
// Defaults come from environment variables (used until someone saves a setting). A provider can only be SELECTED if the server
// has what it needs (e.g. Google routing needs a key); the app additionally falls back safely if its build lacks a renderer.
'use strict';

const prisma = require('../../lib/prisma');
const { AppError } = require('../../middleware/errorHandler');
const { logActivity } = require('../../utils/auditLog');

const KEY = 'maps.config';
const RENDERERS = ['maplibre', 'google', 'osm'];
const ROUTING = ['osrm', 'google'];
const PLACES = ['auto', 'photon', 'google'];
const CACHE_MS = 30 * 1000;

const googleKeyForRouting = (env = process.env) => env.GOOGLE_ROUTES_API_KEY || env.GOOGLE_PLACES_API_KEY || '';
const googleKeyForPlaces = (env = process.env) => env.GOOGLE_PLACES_API_KEY || '';

const isProd = (env = process.env) => require('../../utils/envGuard').isProduction(env); // same definition as the boot guard: only development|test are relaxed
const osrmConfigured = (env = process.env) => !!(env.OSRM_URL || env.ROUTING_URL);
/** The public OSRM demo server is DEVELOPMENT ONLY: in production it is refused unless ALLOW_PUBLIC_OSRM=true is set deliberately. */
const demoAllowed = (env = process.env) => !isProd(env) || env.ALLOW_PUBLIC_OSRM === 'true';

/** What this server can actually do right now (never exposes the keys themselves). */
const availability = (env = process.env) => ({
  production: isProd(env),
  renderer: { maplibre: true, google: true, osm: true }, // google/osm also depend on the APP BUILD; the app falls back if absent
  routing: { osrm: osrmConfigured(env) || demoAllowed(env), google: !!googleKeyForRouting(env) },
  places: { auto: true, photon: true, google: !!googleKeyForPlaces(env) },
  osrmIsPublicDemo: !osrmConfigured(env),
});

/** Things an operator should read before saving. Shown in the admin console. */
const warningsFor = (c, env = process.env) => {
  const w = [];
  if (!osrmConfigured(env) && c.routing === 'osrm') w.push('OSRM is not configured: set OSRM_URL to your own routing server.');
  if ((c.routing === 'google' || c.places === 'google') && c.renderer !== 'google') w.push('Google routing / places data is being shown on a non-Google map. Google\'s terms may restrict this: review the current Google Maps Platform terms before relying on it.');
  return w;
};

const defaults = (env = process.env) => ({
  renderer: RENDERERS.includes(env.MAP_RENDERER) ? env.MAP_RENDERER : 'maplibre',
  routing: ROUTING.includes(env.MAP_ROUTING_PROVIDER) ? env.MAP_ROUTING_PROVIDER : 'osrm',
  places: PLACES.includes(env.MAP_PLACES_PROVIDER) ? env.MAP_PLACES_PROVIDER : 'auto',
  styleUrl: /^https:\/\//.test(env.MAP_STYLE_URL || '') ? env.MAP_STYLE_URL : '',
  routingFallback: true,
});

const bad = (msg) => { const e = new AppError(msg, 400); e.code = 'INVALID_MAP_CONFIG'; return e; };

/** Validate + normalise an admin-supplied config. Throws a clear 400 when a provider is chosen that the server cannot serve. */
const validateConfig = (input, env = process.env) => {
  const d = defaults(env);
  const c = { ...d, ...Object.fromEntries(Object.entries(input || {}).filter(([k, v]) => ['renderer', 'routing', 'places', 'styleUrl', 'routingFallback'].includes(k) && v !== undefined)) };
  if (!RENDERERS.includes(c.renderer)) throw bad(`renderer must be one of: ${RENDERERS.join(', ')}`);
  if (!ROUTING.includes(c.routing)) throw bad(`routing must be one of: ${ROUTING.join(', ')}`);
  if (!PLACES.includes(c.places)) throw bad(`places must be one of: ${PLACES.join(', ')}`);
  const a = availability(env);
  if (!a.routing[c.routing]) throw bad(c.routing === 'osrm' ? 'OSRM is not configured: set OSRM_URL to your own routing server (the public demo server is not allowed in production).' : 'Google routing needs GOOGLE_ROUTES_API_KEY (or GOOGLE_PLACES_API_KEY) on the server.');
  if (!a.places[c.places]) throw bad('Google places needs GOOGLE_PLACES_API_KEY on the server.');
  c.styleUrl = String(c.styleUrl || '').trim();
  if (c.styleUrl && (!/^https:\/\/[^\s]+$/.test(c.styleUrl) || c.styleUrl.length > 500)) throw bad('styleUrl must be an https URL.');
  c.routingFallback = c.routingFallback === false || c.routingFallback === 'false' ? false : true;
  return c;
};

let cache = null; // { at, value, updatedAt }
const clearCache = () => { cache = null; };

/** Effective config: saved setting merged over environment defaults. Cached briefly; a DB hiccup serves the last good value. */
const getConfig = async (env = process.env) => {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let saved = null; let updatedAt = null;
  try {
    const row = await prisma.systemSettings.findUnique({ where: { key: KEY } });
    if (row?.value && typeof row.value === 'object') { saved = row.value; updatedAt = row.updatedAt; }
  } catch (e) {
    if (cache) return cache.value;
  }
  const d = defaults(env);
  const value = { ...d, ...(saved || {}), updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null };
  // A saved choice that is no longer servable (key removed) degrades to the safe default instead of breaking the app.
  const a = availability(env);
  if (!a.routing[value.routing]) value.routing = a.routing[value.routing === 'osrm' ? 'google' : 'osrm'] ? (value.routing === 'osrm' ? 'google' : 'osrm') : value.routing;
  if (!a.places[value.places]) value.places = 'auto';
  cache = { at: Date.now(), value };
  return value;
};

/** What the APP is allowed to see: no keys, no internals. */
const publicConfig = async (env = process.env) => {
  const c = await getConfig(env);
  return { renderer: c.renderer, routing: 'server', places: 'server', styleUrl: c.styleUrl || null, version: c.updatedAt ? Date.parse(c.updatedAt) : 0 };
};

const setConfig = async (input, user, req, env = process.env) => {
  const next = validateConfig(input, env);
  // Production: a configuration that may breach a provider's terms must be acknowledged by a named person, and that is recorded.
  const risky = warningsFor(next, env).filter((w) => /terms/i.test(w));
  if (isProd(env) && risky.length && input?.acknowledgeTerms !== true) {
    const e = bad('You must acknowledge the provider-terms warning before saving this combination.'); e.code = 'TERMS_ACK_REQUIRED'; throw e;
  }
  if (risky.length) next.termsAcknowledged = { by: user?.id ?? null, at: new Date().toISOString() };
  const before = await getConfig(env);
  await prisma.systemSettings.upsert({
    where: { key: KEY },
    create: { key: KEY, value: next, category: 'maps', description: 'Map renderer / routing / places provider', updatedBy: user?.id ?? null },
    update: { value: next, updatedBy: user?.id ?? null },
  });
  clearCache();
  await logActivity({ userId: user?.id ?? null, action: 'map_config_changed', entityType: 'SystemSettings', entityId: KEY, details: { from: { renderer: before.renderer, routing: before.routing, places: before.places, styleUrl: before.styleUrl }, to: next }, req });
  return getConfig(env);
};

module.exports = { isProd, osrmConfigured, demoAllowed, warningsFor, KEY, RENDERERS, ROUTING, PLACES, availability, defaults, validateConfig, getConfig, publicConfig, setConfig, clearCache, googleKeyForRouting, googleKeyForPlaces };
