'use strict';
const mockDb = { systemSettings: { findUnique: jest.fn(), upsert: jest.fn() }, activityLog: { create: jest.fn().mockResolvedValue({}) } };
jest.mock('../src/lib/prisma', () => mockDb);
jest.mock('axios');
const axios = require('axios');
const cfg = require('../src/services/maps/mapConfig.service');
const routing = require('../src/services/maps/routing.service');

const A = { latitude: 6.5244, longitude: 3.3792 }; const B = { latitude: 6.6018, longitude: 3.3515 };
const DEV = { NODE_ENV: 'test' };                    // an unset/other NODE_ENV counts as PRODUCTION (same rule as the boot guard)
const GKEY = { NODE_ENV: 'test', GOOGLE_ROUTES_API_KEY: 'k-routes', GOOGLE_PLACES_API_KEY: 'k-places' };
beforeEach(() => { jest.clearAllMocks(); cfg.clearCache(); routing.clearCache(); mockDb.systemSettings.findUnique.mockResolvedValue(null); mockDb.systemSettings.upsert.mockResolvedValue({}); mockDb.activityLog.create.mockResolvedValue({}); });

describe('config validation', () => {
  test('defaults: maplibre + osrm + auto places', () => expect(cfg.defaults(DEV)).toMatchObject({ renderer: 'maplibre', routing: 'osrm', places: 'auto', routingFallback: true }));
  test('env sets the starting defaults', () => expect(cfg.defaults({ ...DEV, MAP_RENDERER: 'google', MAP_ROUTING_PROVIDER: 'google' })).toMatchObject({ renderer: 'google', routing: 'google' }));
  test('rejects unknown values', () => {
    expect(() => cfg.validateConfig({ renderer: 'bing' }, DEV)).toThrow(/renderer/);
    expect(() => cfg.validateConfig({ routing: 'here' }, DEV)).toThrow(/routing/);
  });
  test('Google routing/places can only be selected when the server has the key', () => {
    expect(() => cfg.validateConfig({ routing: 'google' }, DEV)).toThrow(/GOOGLE_ROUTES_API_KEY/);
    expect(() => cfg.validateConfig({ places: 'google' }, DEV)).toThrow(/GOOGLE_PLACES_API_KEY/);
    expect(cfg.validateConfig({ routing: 'google', places: 'google' }, GKEY)).toMatchObject({ routing: 'google', places: 'google' });
  });
  test('renderer google/osm need no server key (the app build decides)', () => expect(cfg.validateConfig({ renderer: 'google' }, DEV).renderer).toBe('google'));
  test('styleUrl must be https', () => {
    expect(() => cfg.validateConfig({ styleUrl: 'http://x.example/style.json' }, DEV)).toThrow(/https/);
    expect(cfg.validateConfig({ styleUrl: 'https://tiles.example/style.json' }, DEV).styleUrl).toBe('https://tiles.example/style.json');
    expect(cfg.validateConfig({ styleUrl: '' }, DEV).styleUrl).toBe('');
  });
});

describe('saved config', () => {
  test('saved value overrides env defaults', async () => {
    mockDb.systemSettings.findUnique.mockResolvedValue({ value: { renderer: 'osm', routing: 'osrm' }, updatedAt: new Date('2026-11-20T10:00:00Z') });
    expect(await cfg.getConfig(DEV)).toMatchObject({ renderer: 'osm', updatedAt: '2026-11-20T10:00:00.000Z' });
  });
  test('a saved Google choice degrades safely if the key is later removed', async () => {
    mockDb.systemSettings.findUnique.mockResolvedValue({ value: { routing: 'google', places: 'google' }, updatedAt: new Date() });
    expect(await cfg.getConfig(DEV)).toMatchObject({ routing: 'osrm', places: 'auto' });
  });
  test('a database failure serves the last good value instead of breaking the apps', async () => {
    mockDb.systemSettings.findUnique.mockResolvedValueOnce({ value: { renderer: 'osm' }, updatedAt: new Date() });
    await cfg.getConfig(DEV); cfg.clearCache(); // clears; now simulate failure with no cache -> defaults
    mockDb.systemSettings.findUnique.mockRejectedValue(new Error('db down'));
    expect(await cfg.getConfig(DEV)).toMatchObject({ renderer: 'maplibre' });
  });
  test('setConfig persists, audits the before/after, and clears the cache', async () => {
    const out = await cfg.setConfig({ renderer: 'google' }, { id: 'su' }, null, DEV);
    expect(mockDb.systemSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { key: 'maps.config' } }));
    expect(mockDb.activityLog.create.mock.calls[0][0].data.action).toBe('map_config_changed');
    expect(out).toBeDefined();
  });
  test('the public config never contains keys or internals', async () => {
    const p = await cfg.publicConfig({ ...GKEY });
    expect(Object.keys(p).sort()).toEqual(['places', 'renderer', 'routing', 'styleUrl', 'version']);
    expect(JSON.stringify(p)).not.toMatch(/k-routes|k-places/);
    expect(p.routing).toBe('server');
  });
});

describe('routing adapters', () => {
  test('decodePolyline decodes the canonical Google example', () => {
    const pts = routing.decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(pts[0]).toEqual({ latitude: 38.5, longitude: -120.2 });
    expect(pts[2]).toEqual({ latitude: 43.252, longitude: -126.453 });
  });
  test('OSRM: parses geometry, distance, duration', async () => {
    axios.get.mockResolvedValue({ data: { routes: [{ distance: 1234, duration: 321, geometry: { coordinates: [[3.37, 6.52], [3.38, 6.53]] } }] } });
    const r = await routing.routeBetween(A, B, { env: DEV, config: { routing: 'osrm', routingFallback: true } });
    expect(r).toMatchObject({ provider: 'osrm', distanceM: 1234, durationS: 321 });
    expect(r.coords[0]).toEqual({ latitude: 6.52, longitude: 3.37 });
  });
  test('Google: sends key + field mask server-side and parses the route', async () => {
    axios.post.mockResolvedValue({ data: { routes: [{ distanceMeters: 5000, duration: '600s', polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC' } }] } });
    const r = await routing.routeBetween(A, B, { env: GKEY, config: { routing: 'google', routingFallback: false } });
    expect(r).toMatchObject({ provider: 'google', distanceM: 5000, durationS: 600 });
    const [url, body, opts] = axios.post.mock.calls[0];
    expect(url).toMatch(/routes\.googleapis\.com/); expect(opts.headers['X-Goog-Api-Key']).toBe('k-routes'); expect(body.travelMode).toBe('DRIVE');
  });
  test('falls back to the other provider when the primary fails (if enabled and available)', async () => {
    axios.post.mockRejectedValue(new Error('google 500'));
    axios.get.mockResolvedValue({ data: { routes: [{ distance: 10, duration: 1, geometry: { coordinates: [[1, 1], [2, 2]] } }] } });
    const r = await routing.routeBetween(A, B, { env: GKEY, config: { routing: 'google', routingFallback: true } });
    expect(r.provider).toBe('osrm');
  });
  test('no fallback when disabled -> null (app draws a straight line)', async () => {
    axios.post.mockRejectedValue(new Error('google 500'));
    expect(await routing.routeBetween(A, B, { env: GKEY, config: { routing: 'google', routingFallback: false } })).toBeNull();
    expect(axios.get).not.toHaveBeenCalled();
  });
  test('results are cached per provider; invalid coordinates return null without calling out', async () => {
    axios.get.mockResolvedValue({ data: { routes: [{ distance: 1, duration: 1, geometry: { coordinates: [[1, 1], [2, 2]] } }] } });
    const o = { env: DEV, config: { routing: 'osrm' } };
    await routing.routeBetween(A, B, o); await routing.routeBetween(A, B, o);
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(await routing.routeBetween({ latitude: 999, longitude: 0 }, B, o)).toBeNull();
  });
  test('switching provider is a setting: the same call returns the same shape from either', async () => {
    axios.get.mockResolvedValue({ data: { routes: [{ distance: 1, duration: 2, geometry: { coordinates: [[1, 1], [2, 2]] } }] } });
    axios.post.mockResolvedValue({ data: { routes: [{ distanceMeters: 1, duration: '2s', polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC' } }] } });
    const a = await routing.routeBetween(A, B, { env: GKEY, config: { routing: 'osrm' } });
    routing.clearCache();
    const g = await routing.routeBetween(A, B, { env: GKEY, config: { routing: 'google' } });
    for (const r of [a, g]) expect(Object.keys(r).sort()).toEqual(['coords', 'distanceM', 'durationS', 'provider']);
  });
});

describe('PRODUCTION behaviour (NODE_ENV unset or production = production)', () => {
  const PROD = { NODE_ENV: 'production' };
  const PROD_OWN = { NODE_ENV: 'production', OSRM_URL: 'https://osrm.example.com' };
  const PROD_G = { NODE_ENV: 'production', GOOGLE_ROUTES_API_KEY: 'k' };
  test('the public OSRM demo server is refused in production, but allowed in development', async () => {
    expect(cfg.availability(PROD).routing.osrm).toBe(false);
    expect(cfg.availability(DEV).routing.osrm).toBe(true);
    expect(cfg.availability(PROD_OWN).routing.osrm).toBe(true);
    expect(cfg.availability({ NODE_ENV: 'production', ALLOW_PUBLIC_OSRM: 'true' }).routing.osrm).toBe(true);
    expect(await routing.routeBetween(A, B, { env: PROD, config: { routing: 'osrm', routingFallback: false } })).toBeNull();
    expect(axios.get).not.toHaveBeenCalled(); // never even contacted the demo server
  });
  test('an unset NODE_ENV is production (matches the boot guard)', () => expect(cfg.availability({}).production).toBe(true));
  test('selecting OSRM without OSRM_URL in production is rejected with an actionable message', () => {
    expect(() => cfg.validateConfig({ routing: 'osrm' }, PROD)).toThrow(/OSRM_URL/);
    expect(cfg.validateConfig({ routing: 'osrm' }, PROD_OWN).routing).toBe('osrm');
  });
  test('production with only a Google key: the effective routing becomes Google, not a broken OSRM', async () => {
    mockDb.systemSettings.findUnique.mockResolvedValue(null);
    expect((await cfg.getConfig(PROD_G)).routing).toBe('google');
  });
  test('Google data on a non-Google map needs a recorded acknowledgement in production', async () => {
    const env = { ...PROD_G, GOOGLE_PLACES_API_KEY: 'p', OSRM_URL: 'https://osrm.example.com' };
    await expect(cfg.setConfig({ renderer: 'maplibre', routing: 'google' }, { id: 'su' }, null, env)).rejects.toMatchObject({ code: 'TERMS_ACK_REQUIRED' });
    expect(mockDb.systemSettings.upsert).not.toHaveBeenCalled();
    await cfg.setConfig({ renderer: 'maplibre', routing: 'google', acknowledgeTerms: true }, { id: 'su' }, null, env);
    const saved = mockDb.systemSettings.upsert.mock.calls[0][0].create.value;
    expect(saved.termsAcknowledged).toMatchObject({ by: 'su' });
  });
  test('Google routing with the Google renderer or OSRM with MapLibre needs no acknowledgement', async () => {
    const env = { ...PROD_G, OSRM_URL: 'https://osrm.example.com' };
    await cfg.setConfig({ renderer: 'google', routing: 'google' }, { id: 'su' }, null, env);
    cfg.clearCache(); await cfg.setConfig({ renderer: 'maplibre', routing: 'osrm' }, { id: 'su' }, null, env);
    expect(mockDb.systemSettings.upsert).toHaveBeenCalledTimes(2);
  });
  test('warnings are surfaced for the admin screen', () => {
    expect(cfg.warningsFor({ renderer: 'maplibre', routing: 'google', places: 'auto' }, PROD_G).join(' ')).toMatch(/terms/i);
    expect(cfg.warningsFor({ renderer: 'google', routing: 'google', places: 'google' }, PROD_G)).toEqual([]);
    expect(cfg.warningsFor({ renderer: 'maplibre', routing: 'osrm', places: 'auto' }, PROD).join(' ')).toMatch(/OSRM_URL/);
  });
});

describe('boot guard (production)', () => {
  const g = require('../src/utils/envGuard');
  const base = { NODE_ENV: 'production', JWT_SECRET: 'q'.repeat(48), DATABASE_URL: 'x', CLIENT_URL: 'https://a', CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's' };
  test('refuses to start without a real routing provider or document storage', () => {
    const p = g.productionProblems({ ...base, CLOUDINARY_API_SECRET: '' }).join(' | ');
    expect(p).toMatch(/CLOUDINARY/); expect(p).toMatch(/routing provider/);
  });
  test('starts with your own OSRM, or a Google routing key, or an explicit override', () => {
    for (const extra of [{ OSRM_URL: 'https://osrm.example.com' }, { GOOGLE_ROUTES_API_KEY: 'k' }, { ALLOW_PUBLIC_OSRM: 'true' }]) expect(g.productionProblems({ ...base, ...extra })).toEqual([]);
  });
  test('OSRM_URL must be https', () => expect(g.productionProblems({ ...base, OSRM_URL: 'http://osrm.example.com' }).join(' ')).toMatch(/https/));
  test('warnings: empty licence rules, enforcement off, categories unset, demo override', () => {
    const w = g.productionWarnings({ ...base, OSRM_URL: 'https://o', ENFORCE_LICENCE_ELIGIBILITY: 'false', ALLOW_PUBLIC_OSRM: 'true' }).join(' | ');
    expect(w).toMatch(/LICENCE_CLASS_RULES is empty/); expect(w).toMatch(/checks are OFF/); expect(w).toMatch(/ENABLED_VEHICLE_CATEGORIES/); expect(w).toMatch(/ALLOW_PUBLIC_OSRM/);
    expect(g.productionWarnings({ ...base, OSRM_URL: 'https://o', ENABLED_VEHICLE_CATEGORIES: 'CAR', LICENCE_CLASS_RULES: '{"CAR":["B"]}' })).toEqual([]);
    expect(g.productionWarnings({ NODE_ENV: 'development' })).toEqual([]);
  });
  test('licence enforcement defaults ON when NODE_ENV is unset (production), off only for development/test', () => {
    const lic = require('../src/services/driverLicence.service');
    expect(lic.licenceEnforced({})).toBe(true); expect(lic.licenceEnforced({ NODE_ENV: 'development' })).toBe(false); expect(lic.licenceEnforced({ NODE_ENV: 'staging' })).toBe(true);
  });
});
