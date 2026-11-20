'use strict';
const { resolveRenderer, normaliseMapConfig, envDefaultRenderer } = require('../../mobile/src/utils/mapRenderer');

describe('resolveRenderer — the admin choice is a request; the build decides what is possible', () => {
  const both = { maplibreAvailable: true, googleAvailable: true };
  test('maplibre requested -> maplibre', () => expect(resolveRenderer({ requested: 'maplibre', ...both })).toBe('maplibre'));
  test('google requested and available -> google', () => expect(resolveRenderer({ requested: 'google', ...both })).toBe('google'));
  test('google requested but the build lacks it -> falls back to maplibre, then osm', () => {
    expect(resolveRenderer({ requested: 'google', maplibreAvailable: true, googleAvailable: false })).toBe('maplibre');
    expect(resolveRenderer({ requested: 'google', maplibreAvailable: false, googleAvailable: false })).toBe('osm');
  });
  test('maplibre requested but not in this build (e.g. Expo Go) -> google, then osm', () => {
    expect(resolveRenderer({ requested: 'maplibre', maplibreAvailable: false, googleAvailable: true })).toBe('google');
    expect(resolveRenderer({ requested: 'maplibre', maplibreAvailable: false, googleAvailable: false })).toBe('osm');
  });
  test('osm is always honoured', () => expect(resolveRenderer({ requested: 'osm', ...both })).toBe('osm'));
  test('garbage requests still land on a working renderer', () => expect(['maplibre', 'google', 'osm']).toContain(resolveRenderer({ requested: 'bing', ...both })));
});

describe('normaliseMapConfig', () => {
  const fb = { renderer: 'maplibre', routing: 'server', styleUrl: null, version: 3 };
  test('accepts well-formed config', () => expect(normaliseMapConfig({ renderer: 'google', styleUrl: 'https://t.example/s.json', version: 9 }, fb)).toEqual({ renderer: 'google', routing: 'server', styleUrl: 'https://t.example/s.json', version: 9 }));
  test('rejects a bad renderer and a non-https style, never throws', () => {
    expect(normaliseMapConfig({ renderer: 'bing', styleUrl: 'http://x', version: 'nope' }, fb)).toEqual({ renderer: 'maplibre', routing: 'server', styleUrl: null, version: 3 });
    expect(normaliseMapConfig(null, fb)).toEqual(fb);
    expect(normaliseMapConfig('x', fb)).toEqual(fb);
  });
  test('env default: legacy means google; unknown means maplibre', () => {
    expect(envDefaultRenderer('legacy')).toBe('google'); expect(envDefaultRenderer('osm')).toBe('osm'); expect(envDefaultRenderer(undefined)).toBe('maplibre');
  });
});
