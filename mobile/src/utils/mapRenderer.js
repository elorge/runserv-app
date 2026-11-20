// mobile/src/utils/mapRenderer.js
// Pure helpers (no imports, CommonJS) so the switching logic is unit-testable without a device.
//
// The renderer the ADMIN selects is a REQUEST. What actually draws depends on what this app BUILD contains
// (MapLibre native module, react-native-maps). resolveRenderer() always lands on something that works.
const RENDERERS = ['maplibre', 'google', 'osm'];

/** @returns {'maplibre'|'google'|'osm'} */
function resolveRenderer({ requested, maplibreAvailable, googleAvailable }) {
  const order = requested === 'google' ? ['google', 'maplibre', 'osm']
    : requested === 'osm' ? ['osm']
    : ['maplibre', 'google', 'osm'];
  for (const r of order) {
    if (r === 'maplibre' && maplibreAvailable) return 'maplibre';
    if (r === 'google' && googleAvailable) return 'google';
    if (r === 'osm') return 'osm';
  }
  return 'osm'; // always available (WebView/Leaflet)
}

/** Accept only well-formed remote config; anything else keeps the fallback. Never throws. */
function normaliseMapConfig(raw, fallback) {
  const f = fallback || { renderer: 'maplibre', routing: 'server', styleUrl: null, version: 0 };
  if (!raw || typeof raw !== 'object') return { ...f };
  return {
    renderer: RENDERERS.includes(raw.renderer) ? raw.renderer : f.renderer,
    routing: 'server',
    styleUrl: typeof raw.styleUrl === 'string' && /^https:\/\//.test(raw.styleUrl) ? raw.styleUrl : null,
    version: Number.isFinite(+raw.version) ? +raw.version : f.version,
  };
}

/** The renderer used before any remote config arrives (and offline on a first launch). */
function envDefaultRenderer(envValue) {
  if (envValue === 'legacy') return 'google';
  return RENDERERS.includes(envValue) ? envValue : 'maplibre';
}

module.exports = { RENDERERS, resolveRenderer, normaliseMapConfig, envDefaultRenderer };
