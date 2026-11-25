'use strict';
// P1 release-blocker regressions: logout-all boundary, durable parcel SMS, scheduled fleet-trip scan.
const { issuedBeforeRevocation: before } = (() => { jest.mock('../src/lib/prisma', () => ({})); return require('../src/services/tokenRevocation.service'); })();

describe('logout-all boundary (millisecond, inclusive)', () => {
  const T = Date.parse('2026-11-25T10:00:00.500Z');
  test('a token issued in the SAME second but before the revocation is refused; one issued after is accepted', () => {
    expect(before({ iat: Math.floor(T / 1000), iatMs: T - 300 }, new Date(T))).toBe(true);
    expect(before({ iat: Math.floor(T / 1000), iatMs: T }, new Date(T))).toBe(true);             // exactly at the boundary: inclusive
    expect(before({ iat: Math.floor(T / 1000), iatMs: T + 1 }, new Date(T))).toBe(false);        // a fresh login straight afterwards works
    expect(before({ iat: Math.floor(T / 1000) + 5, iatMs: T + 5000 }, new Date(T))).toBe(false);
  });
  test('legacy tokens without iatMs fall back to whole seconds, also inclusive (the safe direction)', () => {
    expect(before({ iat: Math.floor(T / 1000) }, new Date(T))).toBe(true);
    expect(before({ iat: Math.floor(T / 1000) - 1 }, new Date(T))).toBe(true);
    expect(before({ iat: Math.floor(T / 1000) + 1 }, new Date(T))).toBe(false);
  });
  test('no revocation recorded → never revoked; new tokens carry iatMs', () => {
    expect(before({ iat: 1, iatMs: 1 }, null)).toBe(false);
    process.env.JWT_SECRET = 'x'.repeat(40); jest.isolateModules(() => {});
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/controllers/auth.controller.js'), 'utf8');
    expect(src).toMatch(/iatMs: Date\.now\(\)/);
  });
});

describe('parcel SMS is queued in the same transaction as the delivery', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/controllers/delivery.controller.js'), 'utf8');
  test('the controller enqueues the SMS inside prisma.$transaction and no longer after commit', () => {
    expect(src).toMatch(/enqueueRegisteredSmsTx\(tx,/); expect(src).not.toMatch(/comms\.enqueueRegisteredSms\(\{/);
  });
  test('enqueueRegisteredSmsTx writes through the given tx with a stable idempotency key; disabled channel or no phone queues nothing', async () => {
    jest.resetModules();
    const enqueueTx = jest.fn(async () => ({ id: 's1' }));
    jest.doMock('../src/services/smsOutbox.service', () => ({ enabled: (e) => e.SMS_ENABLED === 'true', enqueueTx, KINDS: { RECIPIENT_CODE: 'RECIPIENT_CODE' } }));
    jest.doMock('../src/services/emailOutbox.service', () => ({ KINDS: {} }));
    const comms = require('../src/services/deliveryComms.service'); const tx = {};
    expect(await comms.enqueueRegisteredSmsTx(tx, { deliveryId: 'd1', phone: '+2348000000000', countryCode: 'NG', env: { SMS_ENABLED: 'false' } })).toBeNull();
    expect(await comms.enqueueRegisteredSmsTx(tx, { deliveryId: 'd1', phone: '', env: { SMS_ENABLED: 'true' } })).toBeNull();
    await comms.enqueueRegisteredSmsTx(tx, { deliveryId: 'd1', phone: '+2348000000000', countryCode: 'NG', codeVersion: 2, env: { SMS_ENABLED: 'true' } });
    expect(enqueueTx).toHaveBeenCalledWith(tx, expect.objectContaining({ deliveryId: 'd1', idempotencyKey: 'RECIPIENT_CODE:d1:2' }));
  });
});

describe('scheduled fleet-trip scan', () => {
  const load = ({ missing = [], failed = [], amount = [], fields = [], ambiguous = [], dead = 0, repaired = 0 } = {}) => {
    jest.resetModules();
    const raise = jest.fn(async () => ({}));
    jest.doMock('../src/lib/prisma', () => ({ outboxEvent: { count: jest.fn(async () => dead) } }));
    jest.doMock('../src/services/opsAlert.service', () => ({ raiseAndDeliver: raise }));
    const repair = jest.fn(async () => ({ repaired, failed }));
    jest.doMock('../src/services/fleetTripReconcile.service', () => ({ findMissingFleetTrips: jest.fn(async () => ({ checked: 5, missing, amountMismatch: amount, fieldMismatch: fields, ambiguous, truncated: false })), repairMissingFleetTrips: repair }));
    return { svc: require('../src/services/fleetTripMonitor.service'), raise, repair };
  };
  test('clean scan: nothing repaired, no alert', async () => {
    const { svc, raise, repair } = load(); const s = await svc.scan(); expect(s.missing).toBe(0); expect(raise).not.toHaveBeenCalled(); expect(repair).not.toHaveBeenCalled();
  });
  test('missing trips are repaired automatically and reported as a warning', async () => {
    const { svc, raise, repair } = load({ missing: [{ rideId: 'r' }], repaired: 1 }); await svc.scan();
    expect(repair).toHaveBeenCalled(); expect(raise).toHaveBeenCalledWith(expect.objectContaining({ kind: 'FLEET_TRIP_REPAIRED', severity: 'WARNING' }));
  });
  test('an unrepaired trip, a mismatch, or a dead-letter completion event raises a CRITICAL alert', async () => {
    for (const o of [{ missing: [{ rideId: 'r' }], failed: [{ error: 'x' }] }, { amount: [{}] }, { fields: [{}] }, { ambiguous: [{}] }, { dead: 2 }]) {
      const { svc, raise } = load(o); await svc.scan(); expect(raise).toHaveBeenCalledWith(expect.objectContaining({ kind: 'FLEET_TRIP_RECONCILIATION', severity: 'CRITICAL' }));
    }
  });
  test('the scheduler can be switched off and is started from server.js', () => {
    const { svc } = load(); expect(svc.start({ info() {}, warn() {}, error() {} }, { FLEET_TRIP_SCAN_ENABLED: 'false' })).toBe(false);
    expect(require('fs').readFileSync(require('path').join(__dirname, '../src/server.js'), 'utf8')).toMatch(/fleetTripMonitor\.service'\)\.start/);
  });
});
