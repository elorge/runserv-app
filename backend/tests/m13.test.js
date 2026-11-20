'use strict';
const mockDb = { fleetPartner: { findUnique: jest.fn() }, activityLog: { create: jest.fn() }, fleetDriverAssignment: {}, ride: {}, delivery: {}, fleetTrip: {} };
jest.mock('../src/lib/prisma', () => mockDb);
const ref = require('../src/utils/storageRef');
const cats = require('../src/utils/vehicleCategories');
const lic = require('../src/services/driverLicence.service');
const { assignmentAt } = require('../src/services/fleetTripReconcile.service');
const fleet = require('../src/services/fleet.service');

describe('storageRef', () => {
  test('round-trips a private ref and rejects traversal/foreign ids', () => {
    const r = ref.makePrivateRef({ resourceType: 'image', format: 'jpg', publicId: 'runserv/kyc/ids/abc123' });
    expect(ref.parsePrivateRef(r)).toEqual({ resourceType: 'image', format: 'jpg', publicId: 'runserv/kyc/ids/abc123' });
    expect(ref.parsePrivateRef('cldp:image:jpg:runserv/../x')).toBeNull();
    expect(ref.parsePrivateRef('cldp:image:jpg:other/x')).toBeNull();
    expect(ref.parsePrivateRef('https://res.cloudinary.com/x')).toBeNull();
  });
  test('sniffs real content, not the claimed type', () => {
    const png = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.alloc(20)]);
    expect(ref.validateUpload({ buffer: png, claimedMime: 'image/png' }).ok).toBe(true);
    expect(ref.validateUpload({ buffer: png, claimedMime: 'application/pdf' }).code).toBe('FILE_TYPE_MISMATCH');
    expect(ref.validateUpload({ buffer: Buffer.from('<script>alert(1)</script>'), claimedMime: 'image/png' }).code).toBe('FILE_TYPE_NOT_ALLOWED');
    expect(ref.validateUpload({ buffer: Buffer.alloc(6 * 1024 * 1024, 1) }).code).toBe('FILE_TOO_LARGE');
  });
  test('sensitive folders', () => {
    expect(ref.isSensitiveFolder('runserv/kyc/ids')).toBe(true);
    expect(ref.isSensitiveFolder('runserv/fleet/documents')).toBe(true);
    expect(ref.isSensitiveFolder('runserv/profile')).toBe(false);
  });
});

describe('vehicleCategories', () => {
  test('tricycle is out by default; BIKE = MOTORCYCLE; pilot can be CAR only', () => {
    expect(cats.enabledCategories({})).toEqual(['CAR', 'MOTORCYCLE', 'VAN']);
    expect(cats.isCategoryEnabled('TRICYCLE', {})).toBe(false);
    expect(cats.isCategoryEnabled('bike', {})).toBe(true);
    expect(() => cats.assertCategoryEnabled('VAN', { ENABLED_VEHICLE_CATEGORIES: 'CAR' })).toThrow(/not available/);
  });
});

describe('licence eligibility', () => {
  const env = { LICENCE_CLASS_RULES: '{"CAR":["B"]}' };
  const ok = { vehicleType: 'CAR', licenseClass: 'b', licenseExpiresAt: '2030-01-01', licenseVerificationStatus: 'VERIFIED', licenseVerifiedAt: new Date() };
  const codes = (p, e = env) => lic.checkLicence({ profile: p, env: e, now: new Date('2026-11-20') }).failures.map((f) => f.code);
  test('passes when verified, unexpired, class permitted', () => expect(codes(ok)).toEqual([]));
  test('unverified / expired / missing class / wrong class / no rules', () => {
    expect(codes({ ...ok, licenseVerificationStatus: 'UNVERIFIED' })).toContain('LICENCE_NOT_VERIFIED');
    expect(codes({ ...ok, licenseExpiresAt: '2026-11-19' })).toContain('LICENCE_EXPIRED');
    expect(codes({ ...ok, licenseExpiresAt: '2026-11-20' })).toEqual([]);
    expect(codes({ ...ok, licenseClass: null })).toContain('LICENCE_CLASS_MISSING');
    expect(codes({ ...ok, licenseClass: 'A' })).toContain('LICENCE_CLASS_NOT_PERMITTED');
    expect(codes(ok, {})).toContain('LICENCE_RULES_NOT_CONFIGURED');
  });
  test('enforcement default: on in production only', () => {
    expect(lic.licenceEnforced({ NODE_ENV: 'production' })).toBe(true);
    expect(lic.licenceEnforced({ NODE_ENV: 'test' })).toBe(false);
    expect(lic.licenceEnforced({ NODE_ENV: 'production', ENFORCE_LICENCE_ELIGIBILITY: 'false' })).toBe(false);
  });
});

describe('P1 fixes', () => {
  test('settlement rejects Invalid Date and reversed range with 400', async () => {
    await expect(fleet.createSettlement({ fleetPartnerId: 'f1', periodStart: 'garbage', periodEnd: '2026-11-02' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(fleet.createSettlement({ fleetPartnerId: 'f1', periodStart: '2026-11-05', periodEnd: '2026-11-02' })).rejects.toMatchObject({ statusCode: 400 });
  });
  test('overlap is ambiguous across fleets OR vehicles, not for a single assignment', () => {
    const a = (id, f, v) => ({ id, fleetPartnerId: f, vehicleId: v, driverUserId: 'd', startsAt: '2026-11-01', endsAt: null });
    const at = '2026-11-10';
    expect(assignmentAt([a('1','f1','v1'), a('2','f1','v2')], 'd', at).ambiguous).toBe(true);
    expect(assignmentAt([a('1','f1','v1'), a('2','f2','v1')], 'd', at).ambiguous).toBe(true);
    expect(assignmentAt([a('1','f1','v1')], 'd', at).ambiguous).toBe(false);
  });
});

describe('M13 reconciliation cursor', () => {
  const mk = () => {
    const m = require('../src/lib/prisma');
    return m;
  };
  test('parseCursor validates', () => {
    const { parseCursor } = require('../src/services/fleetTripReconcile.service');
    expect(parseCursor('2026-11-18T10:00:00.000Z|r5')).toMatchObject({ id: 'r5' });
    expect(parseCursor(undefined)).toBeNull();
    expect(() => parseCursor('nonsense')).toThrow(/cursor/);
    expect(() => parseCursor('2026-11-18T10:00:00.000Z|')).toThrow(/cursor/);
  });
  test('rows sharing the cutoff timestamp are resumed by id, not repeated', async () => {
    const db = mk();
    db.fleetDriverAssignment.findMany = jest.fn().mockResolvedValue([{ id: 'a', fleetPartnerId: 'f1', vehicleId: 'v1', driverUserId: 'd1', startsAt: '2026-11-01T00:00:00Z', endsAt: null }]);
    const T = '2026-11-18T10:00:00Z';
    db.ride = { findMany: jest.fn().mockResolvedValue([1, 2, 3].map((n) => ({ id: `r${n}`, driverId: 'd1', actualFare: '100', currency: 'NGN', completedAt: T }))) };
    db.delivery = { findMany: jest.fn().mockResolvedValue([]) };
    db.fleetTrip = { findMany: jest.fn().mockResolvedValue([]) };
    const svc = require('../src/services/fleetTripReconcile.service');
    const r = await svc.findMissingFleetTrips({ since: '2026-11-18T00:00:00Z', until: '2026-11-19T00:00:00Z', limit: 2 });
    expect(r.truncated).toBe(true);
    expect(r.nextCursor).toBe(`${new Date(T).toISOString()}|r2`);
    expect(r.missing.map((m) => m.rideId)).toEqual(['r1', 'r2']);
    await svc.findMissingFleetTrips({ since: '2026-11-18T00:00:00Z', until: '2026-11-19T00:00:00Z', limit: 2, cursor: r.nextCursor });
    const where = db.ride.findMany.mock.calls[1][0];
    expect(where.orderBy).toEqual([{ completedAt: 'asc' }, { id: 'asc' }]);
    expect(where.where.AND[0].OR[1]).toMatchObject({ id: { gt: 'r2' } });
  });
});

describe('M13 dispatch gate: licence + category apply to EVERY driver', () => {
  const OLD = { ...process.env };
  afterEach(() => { process.env = { ...OLD }; });
  const db = () => require('../src/lib/prisma');
  const goodProfile = { vehicleType: 'CAR', licenseClass: 'B', licenseExpiresAt: new Date(Date.now() + 90 * 864e5), licenseVerificationStatus: 'VERIFIED', licenseVerifiedAt: new Date() };
  const setup = (profile) => { db().fleetDriverAssignment.findFirst = jest.fn().mockResolvedValue(null); db().driverProfile = { findUnique: jest.fn().mockResolvedValue(profile) }; };
  test('a SOLO (non-fleet) driver with an unverified licence cannot go online / accept when enforced', async () => {
    process.env.ENFORCE_LICENCE_ELIGIBILITY = 'true'; process.env.LICENCE_CLASS_RULES = '{"CAR":["B"]}';
    setup({ ...goodProfile, licenseVerificationStatus: 'UNVERIFIED', licenseVerifiedAt: null });
    await expect(fleet.assertDriverDispatchable('u1')).rejects.toMatchObject({ statusCode: 403, code: 'LICENCE_NOT_VERIFIED' });
  });
  test('an expired licence is refused; a verified, valid one passes', async () => {
    process.env.ENFORCE_LICENCE_ELIGIBILITY = 'true'; process.env.LICENCE_CLASS_RULES = '{"CAR":["B"]}';
    setup({ ...goodProfile, licenseExpiresAt: new Date(Date.now() - 2 * 864e5) });
    await expect(fleet.assertDriverDispatchable('u1')).rejects.toMatchObject({ code: 'LICENCE_EXPIRED' });
    setup(goodProfile); await expect(fleet.assertDriverDispatchable('u1')).resolves.toEqual({ fleet: false });
  });
  test('a disabled category blocks a driver registered for it (pilot = CAR only)', async () => {
    process.env.ENABLED_VEHICLE_CATEGORIES = 'CAR'; process.env.ENFORCE_LICENCE_ELIGIBILITY = 'false';
    setup({ ...goodProfile, vehicleType: 'VAN' });
    await expect(fleet.assertDriverDispatchable('u1')).rejects.toMatchObject({ code: 'VEHICLE_CATEGORY_DISABLED' });
    setup({ ...goodProfile, vehicleType: 'CAR' }); await expect(fleet.assertDriverDispatchable('u1')).resolves.toEqual({ fleet: false });
  });
  test('couriers (no DriverProfile) are not subject to the licence rule', async () => {
    process.env.ENFORCE_LICENCE_ELIGIBILITY = 'true'; setup(null);
    await expect(fleet.assertDriverDispatchable('c1')).resolves.toEqual({ fleet: false });
  });
});
