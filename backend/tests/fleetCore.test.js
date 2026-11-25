'use strict';
jest.mock('../src/lib/prisma', () => ({}));
const money = require('../src/utils/money');
const comp = require('../src/services/fleetCompliance');
const access = require('../src/services/fleetAccess');

describe('money (integer minor units)', () => {
  test('blueprint example: ₦10,000 at 15% → fee ₦1,500, net ₦8,500', () => {
    expect(money.splitFare(10000, 0.15)).toEqual({ fare: 10000, platformFee: 1500, net: 8500 });
  });
  test('no floating-point drift: 0.1 + 0.2 style amounts', () => {
    const s = money.splitFareMinor(money.toMinor('1234.57'), '0.105000');
    expect(s.feeMinor + s.netMinor).toBe(s.fareMinor);
    expect(s.feeMinor).toBe(12963); // 123457 * 0.105 = 12963.0 (rounded half-up)
  });
  test('fee + net always equals fare across many values', () => {
    for (let f = 0; f < 5000; f += 37) for (const r of [0, 0.1, 0.12, 0.15, 0.18, 0.333333]) {
      const s = money.splitFareMinor(f, r); expect(s.feeMinor + s.netMinor).toBe(f);
    }
  });
  test('rejects bad input', () => {
    expect(() => money.splitFareMinor(-1, 0.1)).toThrow(); expect(() => money.splitFareMinor(10.5, 0.1)).toThrow(); expect(() => money.splitFareMinor(100, 1.5)).toThrow();
  });
  test('handles Prisma Decimal-like objects', () => {
    expect(money.toMinor({ toString: () => '99.99' })).toBe(9999);
  });
});

describe('document state', () => {
  const now = new Date('2026-11-17T10:00:00Z');
  test('valid through the whole expiry day', () => {
    expect(comp.docState('2026-11-17', now)).toBe('EXPIRING');
    expect(comp.docState('2026-11-16', now)).toBe('EXPIRED');
    expect(comp.docState('2027-03-01', now)).toBe('VALID');
    expect(comp.docState(null, now)).toBe('MISSING');
  });
});

describe('vehicle dispatch eligibility', () => {
  const now = new Date('2026-11-17T10:00:00Z');
  const fleetOk = { status: 'ACTIVE', verificationStatus: 'VERIFIED' };
  const v = (o = {}) => ({ status: 'ACTIVE', isActive: true, insuranceExpiresAt: '2027-06-01', roadworthyExpiresAt: '2027-06-01', permitExpiresAt: null, ...o });
  test('clean vehicle is eligible', () => { expect(comp.dispatchEligibility({ fleetPartner: fleetOk, vehicle: v() }, { now }).ok).toBe(true); });
  test('expired insurance blocks', () => {
    const r = comp.dispatchEligibility({ fleetPartner: fleetOk, vehicle: v({ insuranceExpiresAt: '2026-11-01' }) }, { now });
    expect(r.ok).toBe(false); expect(r.reasons.join()).toMatch(/insurance has expired/);
  });
  test('missing mandatory document blocks', () => {
    expect(comp.dispatchEligibility({ fleetPartner: fleetOk, vehicle: v({ roadworthyExpiresAt: null }) }, { now }).ok).toBe(false);
  });
  test('permit is only mandatory when configured', () => {
    expect(comp.dispatchEligibility({ fleetPartner: fleetOk, vehicle: v() }, { now }).ok).toBe(true);
    expect(comp.dispatchEligibility({ fleetPartner: fleetOk, vehicle: v() }, { now, required: ['insurance', 'roadworthy', 'permit'] }).ok).toBe(false);
    expect(comp.requiredDocs({ FLEET_REQUIRED_VEHICLE_DOCS: 'insurance, permit, bogus' })).toEqual(['insurance', 'permit']);
  });
  test('suspended fleet or vehicle blocks', () => {
    expect(comp.dispatchEligibility({ fleetPartner: { status: 'SUSPENDED' }, vehicle: v() }, { now }).ok).toBe(false);
    expect(comp.dispatchEligibility({ fleetPartner: fleetOk, vehicle: v({ status: 'SUSPENDED' }) }, { now }).ok).toBe(false);
    expect(comp.dispatchEligibility({ fleetPartner: fleetOk, vehicle: v({ status: 'PENDING' }) }, { now }).ok).toBe(false);
  });
  test('expiring soon is a warning, not a blocker', () => {
    const c = comp.vehicleCompliance(v({ insuranceExpiresAt: '2026-12-01' }), { now });
    expect(c.blockers).toEqual([]); expect(c.warnings.join()).toMatch(/insurance expires/);
  });
});

describe('fleet role matrix', () => {
  const m = (role) => ({ role });
  test('finance officer: statements yes, driver identity no', () => {
    expect(access.can(m('FINANCE'), 'seeFinance')).toBe(true); expect(access.can(m('FINANCE'), 'seeDriverIdentity')).toBe(false); expect(access.can(m('FINANCE'), 'assignDrivers')).toBe(false);
  });
  test('operations officer: assign yes, finance no, identity no', () => {
    expect(access.can(m('OPERATIONS'), 'assignDrivers')).toBe(true); expect(access.can(m('OPERATIONS'), 'seeFinance')).toBe(false); expect(access.can(m('OPERATIONS'), 'seeDriverIdentity')).toBe(false);
  });
  test('viewer is read-only', () => {
    for (const a of ['manageVehicles', 'assignDrivers', 'manageUsers', 'manageSettings', 'seeFinance', 'manageDocuments']) expect(access.can(m('VIEWER'), a)).toBe(false);
    expect(access.can(m('VIEWER'), 'view')).toBe(true);
  });
  test('fleet manager manages fleet but not users or finance', () => {
    expect(access.can(m('FLEET_MANAGER'), 'manageVehicles')).toBe(true); expect(access.can(m('FLEET_MANAGER'), 'manageUsers')).toBe(false); expect(access.can(m('FLEET_MANAGER'), 'seeFinance')).toBe(false);
  });
  test('owner can do everything; no member → false', () => {
    for (const a of Object.keys(access.CAN)) expect(access.can(m('OWNER'), a)).toBe(true);
    expect(access.can(null, 'view')).toBe(false);
  });
  test('assertCan throws 403', () => { expect(() => access.assertCan(m('VIEWER'), 'manageVehicles')).toThrow(/permission/); });
});
