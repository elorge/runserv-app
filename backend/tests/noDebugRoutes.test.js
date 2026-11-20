// Regression guard: the unauthenticated /api/debug router must never be mounted.
const fs = require('fs');
const path = require('path');

describe('production security: debug routes', () => {
  const appSrc = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');

  test('app.js does not import, mount or advertise debug routes', () => {
    expect(appSrc).not.toMatch(/debug\.route/);
    expect(appSrc).not.toMatch(/\/api\/debug/);
    expect(appSrc).not.toMatch(/debugRoutes/);
  });

  test('debug.route.js is not present in the source tree', () => {
    expect(fs.existsSync(path.join(__dirname, '../src/routes/debug.route.js'))).toBe(false);
  });

  test('no source file exposes force-online / force-offline / cancel-ride helpers', () => {
    const walk = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
    const offenders = walk(path.join(__dirname, '../src'))
      .filter((f) => f.endsWith('.js'))
      .filter((f) => /force-online|force-offline|Debug: force cancelled/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
