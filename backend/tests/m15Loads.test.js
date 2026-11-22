'use strict';
// Smoke test: every module touched by M15 loads together (no syntax errors, bad requires or circular-import crashes)
// and the routers that expose the new endpoints contain them.
process.env.JWT_SECRET = 'test-secret';
jest.mock('../src/lib/prisma', () => new Proxy({}, { get: () => ({}) }));
jest.mock('../src/services/upload.service', () => ({ signedPrivateUrl: jest.fn(), uploadSingle: () => (q, r, n) => n(), uploadPrivateSingle: () => [(q, r, n) => n()], uploadMultiple: () => (q, r, n) => n() }));

const routeList = (router) => router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);

test('M15 modules load in any order', () => {
  jest.isolateModules(() => {
    require('../src/services/guestBooking.service');
    require('../src/services/proofOfDelivery.service');
    require('../src/controllers/guestBooking.controller');
    require('../src/controllers/adminGuest.controller');
    require('../src/controllers/delivery.controller');
    require('../src/controllers/upload.controller');
    require('../src/services/documentAccess.service');
  });
  jest.isolateModules(() => { require('../src/controllers/delivery.controller'); require('../src/services/guestBooking.service'); });
});

test('delivery routes expose proof / failed / returned for couriers', () => {
  const r = routeList(require('../src/routes/delivery.routes'));
  for (const p of ['POST /:id/proof', 'POST /:id/failed', 'POST /:id/returned']) expect(r).toContain(p);
});

test('upload routes expose the private pod-photo endpoint', () => {
  expect(routeList(require('../src/routes/upload.routes'))).toContain('POST /delivery/pod-photo');
});
