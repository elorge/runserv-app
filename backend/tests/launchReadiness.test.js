'use strict';
// Launch Readiness Guide fixes: §3.1 destructive script, §3.2 approved documents, §3.3 driver↔vehicle compatibility,
// §4.2 settlement concurrency. Pure/mocked: no database needed.
const mockDb = {
  user: { findUnique: jest.fn() },
  fleetVehicle: { findFirst: jest.fn() },
  fleetDriverAssignment: { findFirst: jest.fn(), create: jest.fn() },
  fleetTrip: { findMany: jest.fn() },
  fleetPartner: { findUnique: jest.fn() },
  fleetSettlement: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
  activityLog: { create: jest.fn().mockResolvedValue({}), findFirst: jest.fn() },
};
mockDb.$transaction = jest.fn(async (fn) => fn(mockDb));
mockDb.$executeRaw = jest.fn().mockResolvedValue(1);
jest.mock('../src/lib/prisma', () => mockDb);

const comp = require('../src/services/fleetCompliance');
const { checkDriverVehicle } = require('../src/services/driverVehicleCompat');
const svc = require('../src/services/fleet.service');
const { checkEnvironment, parseArgs } = require('../scripts/force-cancel-accepted');

const NOW = new Date('2026-11-19T10:00:00Z');
const FLEET = { id: 'fleet-aaaaaa', status: 'ACTIVE', commissionRate: '0.150000', currency: 'NGN' };

// ── §3.1 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('force-cancel script guard', () => {
  const dev = { NODE_ENV: 'development', ALLOW_DESTRUCTIVE_SCRIPTS: 'I_UNDERSTAND', DATABASE_URL: 'postgresql://u:p@localhost:5432/runserv_dev' };
  test('accepts only a clearly disposable development/test setup', () => {
    expect(checkEnvironment(dev).ok).toBe(true);
    expect(checkEnvironment({ ...dev, NODE_ENV: 'test', DATABASE_URL: 'postgresql://u:p@127.0.0.1/runserv_test' }).ok).toBe(true);
  });
  test.each([
    ['production NODE_ENV', { NODE_ENV: 'production' }],
    ['staging NODE_ENV', { NODE_ENV: 'staging' }],
    ['unset NODE_ENV', { NODE_ENV: undefined }],
    ['no acknowledgement flag', { ALLOW_DESTRUCTIVE_SCRIPTS: undefined }],
    ['production-looking database name', { DATABASE_URL: 'postgresql://u:p@h/runserv_prod' }],
    ['a dev-named but staging database', { DATABASE_URL: 'postgresql://u:p@h/dev_staging' }],
    ['database name not clearly disposable', { DATABASE_URL: 'postgresql://u:p@h/runserv' }],
    ['no DATABASE_URL', { DATABASE_URL: undefined }],
    ['M12: dev-named database on a REMOTE host', { DATABASE_URL: 'postgresql://u:p@db.prod-cluster.example.com/runserv_dev' }],
  ])('refuses: %s', (_n, over) => { expect(checkEnvironment({ ...dev, ...over }).ok).toBe(false); });
  test('M12: a remote host is accepted only when explicitly allowlisted', () => {
    const remote = { ...dev, DATABASE_URL: 'postgresql://u:p@sandbox-db.internal/runserv_dev' };
    expect(checkEnvironment(remote).ok).toBe(false);
    expect(checkEnvironment({ ...remote, DESTRUCTIVE_SCRIPT_ALLOWED_HOSTS: 'sandbox-db.internal' }).ok).toBe(true);
  });
  test('requires explicit IDs and defaults to dry-run (no --confirm)', () => {
    expect(parseArgs([])).toEqual({ rides: [], drivers: [], confirm: false });
    expect(parseArgs(['--rides=a, b', '--drivers=d1'])).toEqual({ rides: ['a', 'b'], drivers: ['d1'], confirm: false });
    expect(parseArgs(['--rides=a', '--confirm']).confirm).toBe(true);
  });
  test('main() refuses (and touches no database) outside dev/test, and refuses with no ride ids', async () => {
    const { main } = require('../scripts/force-cancel-accepted');
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['--rides=a', '--confirm'], { ...dev, NODE_ENV: 'production' })).toMatchObject({ refused: true });
    expect(await main([], dev)).toMatchObject({ refused: true, reason: 'no ride ids' });
    err.mockRestore(); process.exitCode = 0;
  });
});

// ── §3.2 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('approved fleet documents are required (every vehicle category)', () => {
  const doc = (type, o = {}) => ({ id: `d-${type}`, vehicleId: 'v1', documentType: type, isApproved: true, verifiedAt: new Date('2026-01-01'), rejectionNote: null, expiresAt: '2027-12-31', ...o });
  const vehicle = (type, docs) => ({ id: 'v1', vehicleType: type, status: 'ACTIVE', isActive: true, fleetPartnerId: 'f1', documents: docs,
    // Typed dates say "valid" — they must NOT count as proof.
    insuranceExpiresAt: '2099-01-01', roadworthyExpiresAt: '2099-01-01' });
  const run = (v) => comp.dispatchEligibility({ fleetPartner: { status: 'ACTIVE' }, vehicle: v }, { now: NOW, strict: true });
  const good = [doc('insurance'), doc('roadworthy')];

  describe.each(['CAR', 'MOTORCYCLE', 'VAN', 'TRICYCLE'])('%s', (cat) => {
    test('approved + unexpired documents → eligible', () => expect(run(vehicle(cat, good)).ok).toBe(true));
    test('typed expiry dates alone are NOT proof (no document records → blocked)', () => {
      const r = run(vehicle(cat, []));
      expect(r.ok).toBe(false); expect(r.reasons.join()).toMatch(/insurance is missing/); expect(r.reasons.join()).toMatch(/roadworthy is missing/);
    });
    test('pending (unreviewed) document blocks', () => {
      const r = run(vehicle(cat, [doc('insurance', { isApproved: false, verifiedAt: null }), doc('roadworthy')]));
      expect(r.ok).toBe(false); expect(r.reasons.join()).toMatch(/insurance is awaiting approval/);
    });
    test('rejected document blocks', () => {
      const r = run(vehicle(cat, [doc('insurance', { isApproved: false, verifiedAt: null, rejectionNote: 'blurry' }), doc('roadworthy')]));
      expect(r.ok).toBe(false); expect(r.reasons.join()).toMatch(/insurance was rejected/);
    });
    test('expired document blocks', () => {
      const r = run(vehicle(cat, [doc('insurance', { expiresAt: '2026-11-18' }), doc('roadworthy')]));
      expect(r.ok).toBe(false); expect(r.reasons.join()).toMatch(/insurance has expired/);
    });
    test('document attached to a DIFFERENT vehicle (or only to the fleet) never counts', () => {
      expect(run(vehicle(cat, [doc('insurance', { vehicleId: 'other-vehicle' }), doc('roadworthy')])).ok).toBe(false);
      expect(run(vehicle(cat, [doc('insurance', { vehicleId: null }), doc('roadworthy')])).ok).toBe(false);
    });
  });
  test('approved but without an expiry date cannot prove validity', () => {
    expect(run(vehicle('CAR', [doc('insurance', { expiresAt: null }), doc('roadworthy')])).ok).toBe(false);
  });
  test('the latest-expiring approved record wins over an old expired one (renewal)', () => {
    expect(run(vehicle('CAR', [doc('insurance', { id: 'old', expiresAt: '2026-01-01' }), doc('insurance', { id: 'new', expiresAt: '2027-12-31' }), doc('roadworthy')])).ok).toBe(true);
  });
  test('document type matching ignores case and whitespace', () => {
    expect(run(vehicle('CAR', [doc(' Insurance '), doc('ROADWORTHY')])).ok).toBe(true);
  });
  test('without documents loaded and without strict, the legacy display view still works (never used to authorise work)', () => {
    const c = comp.vehicleCompliance({ insuranceExpiresAt: '2027-01-01', roadworthyExpiresAt: '2027-01-01' }, { now: NOW });
    expect(c.strict).toBe(false); expect(c.blockers).toEqual([]);
    expect(comp.vehicleCompliance({ insuranceExpiresAt: '2027-01-01', roadworthyExpiresAt: '2027-01-01' }, { now: NOW, strict: true }).blockers.length).toBe(2);
  });
  test('driver-facing reasons carry stable codes for pending / rejected', () => {
    const r = comp.dispatchReasons({ fleetPartner: { status: 'ACTIVE' }, vehicle: vehicle('CAR', [doc('insurance', { isApproved: false, verifiedAt: null }), doc('roadworthy', { isApproved: false, verifiedAt: null, rejectionNote: 'x' })]) }, { now: NOW, strict: true });
    expect(r.reasons.map((x) => x.code).sort()).toEqual(['DOC_PENDING', 'DOC_REJECTED']);
  });
  test('the go-online / accept gate (assertDriverDispatchable) uses document records, and reports a stable code', async () => {
    const driver = { isActive: true, driverProfile: { isApproved: true, vehicleType: 'CAR', licenseNumber: 'L', licenseImageUrl: 'u' } };
    mockDb.fleetDriverAssignment.findFirst.mockResolvedValue({ fleetPartnerId: 'f1', vehicleId: 'v1', driver, fleetPartner: { id: 'f1', status: 'ACTIVE' }, vehicle: vehicle('CAR', []) });
    await expect(svc.assertDriverDispatchable('d1')).rejects.toMatchObject({ statusCode: 403, code: 'FLEET_NOT_DISPATCHABLE' });
    mockDb.fleetDriverAssignment.findFirst.mockResolvedValue({ fleetPartnerId: 'f1', vehicleId: 'v1', driver, fleetPartner: { id: 'f1', status: 'ACTIVE' }, vehicle: vehicle('CAR', good) });
    await expect(svc.assertDriverDispatchable('d1')).resolves.toMatchObject({ fleet: true });
  });
});

// ── §3.3 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('driver ↔ vehicle compatibility', () => {
  const profile = (o = {}) => ({ isApproved: true, isRejected: false, vehicleType: 'CAR', licenseNumber: 'LIC', licenseImageUrl: 'https://x/l.jpg', ...o });
  const driver = (o = {}, p = {}) => ({ id: 'd1', isActive: true, driverProfile: profile(p), ...o });
  const veh = (o = {}) => ({ id: 'v1', fleetPartnerId: 'f1', vehicleType: 'CAR', status: 'ACTIVE', isActive: true, ...o });
  const codes = (r) => r.failures.map((f) => f.code);

  test('matching, approved, credentialled driver is allowed', () => expect(checkDriverVehicle({ driver: driver(), vehicle: veh() }).ok).toBe(true));
  test.each([
    ['CAR driver / MOTORCYCLE vehicle', { vehicleType: 'CAR' }, { vehicleType: 'MOTORCYCLE' }],
    ['MOTORCYCLE driver / CAR vehicle', { vehicleType: 'MOTORCYCLE' }, { vehicleType: 'CAR' }],
    ['CAR driver / VAN vehicle', { vehicleType: 'CAR' }, { vehicleType: 'VAN' }],
    ['TRICYCLE driver / CAR vehicle', { vehicleType: 'TRICYCLE' }, { vehicleType: 'CAR' }],
  ])('incompatible: %s', (_n, p, v) => expect(codes(checkDriverVehicle({ driver: driver({}, p), vehicle: veh(v) }))).toContain('DRIVER_VEHICLE_INCOMPATIBLE'));
  test('BIKE and MOTORCYCLE are treated as the same two-wheeler category', () => {
    expect(checkDriverVehicle({ driver: driver({}, { vehicleType: 'BIKE' }), vehicle: veh({ vehicleType: 'MOTORCYCLE' }) }).ok).toBe(true);
  });
  test('unapproved / rejected / suspended / no-profile drivers are refused with stable codes', () => {
    expect(codes(checkDriverVehicle({ driver: driver({}, { isApproved: false }), vehicle: veh() }))).toContain('DRIVER_NOT_APPROVED');
    expect(codes(checkDriverVehicle({ driver: driver({}, { isRejected: true }), vehicle: veh() }))).toContain('DRIVER_REJECTED');
    expect(codes(checkDriverVehicle({ driver: driver({ isActive: false }), vehicle: veh() }))).toContain('DRIVER_SUSPENDED');
    expect(codes(checkDriverVehicle({ driver: { id: 'd', isActive: true, driverProfile: null }, vehicle: veh() }))).toContain('DRIVER_NO_PROFILE');
  });
  test('missing licence credentials are refused', () => {
    expect(codes(checkDriverVehicle({ driver: driver({}, { licenseImageUrl: null }), vehicle: veh() }))).toContain('DRIVER_CREDENTIAL_MISSING');
    expect(codes(checkDriverVehicle({ driver: driver({}, { licenseNumber: '' }), vehicle: veh() }))).toContain('DRIVER_CREDENTIAL_MISSING');
  });
  test('category-specific credentials are configurable without a code change', () => {
    const env = { NODE_ENV: 'test', FLEET_DRIVER_CREDENTIALS_MOTORCYCLE: 'riderCardUrl' }; // dev-like: licence enforcement is covered in m13 tests
    const d = driver({}, { vehicleType: 'MOTORCYCLE' });
    const r = checkDriverVehicle({ driver: d, vehicle: veh({ vehicleType: 'MOTORCYCLE' }) }, { env });
    expect(r.failures).toEqual([expect.objectContaining({ code: 'DRIVER_CREDENTIAL_MISSING', credential: 'riderCardUrl' })]);
    expect(checkDriverVehicle({ driver: driver({}, { vehicleType: 'MOTORCYCLE', riderCardUrl: 'u' }), vehicle: veh({ vehicleType: 'MOTORCYCLE' }) }, { env }).ok).toBe(true);
  });
  test('inactive vehicle, wrong fleet and unknown category are refused', () => {
    expect(codes(checkDriverVehicle({ driver: driver(), vehicle: veh({ status: 'SUSPENDED' }) }))).toContain('VEHICLE_NOT_ACTIVE');
    expect(codes(checkDriverVehicle({ driver: driver(), vehicle: veh(), fleetPartner: { id: 'other' } }))).toContain('VEHICLE_WRONG_FLEET');
    expect(codes(checkDriverVehicle({ driver: driver(), vehicle: veh({ vehicleType: 'HOVERCRAFT' }) }))).toContain('VEHICLE_CATEGORY_UNSUPPORTED');
  });
  test('the SERVER refuses at assignment (409 + code) and again at go-online (403 + code), not just the UI', async () => {
    const docs = [{ id: 'a', vehicleId: 'v1', documentType: 'insurance', isApproved: true, verifiedAt: new Date(), expiresAt: '2099-01-01' }, { id: 'b', vehicleId: 'v1', documentType: 'roadworthy', isApproved: true, verifiedAt: new Date(), expiresAt: '2099-01-01' }];
    const v = veh({ vehicleType: 'VAN', documents: docs, fleetPartnerId: FLEET.id });
    mockDb.fleetVehicle.findFirst.mockResolvedValue(v);
    mockDb.user.findUnique.mockResolvedValue({ id: 'd1', isActive: true, driverProfile: profile({ vehicleType: 'CAR' }) });
    mockDb.fleetDriverAssignment.findFirst.mockResolvedValue(null);
    await expect(svc.assignDriver({ fleetPartner: FLEET, vehicleId: 'v1', driverUserId: 'd1', actor: 'u' })).rejects.toMatchObject({ statusCode: 409, code: 'DRIVER_VEHICLE_INCOMPATIBLE' });
    expect(mockDb.fleetDriverAssignment.create).not.toHaveBeenCalled();
    mockDb.fleetDriverAssignment.findFirst.mockResolvedValue({ fleetPartnerId: 'f1', vehicleId: 'v1', driver: { isActive: true, driverProfile: profile({ vehicleType: 'CAR' }) }, fleetPartner: { id: FLEET.id, status: 'ACTIVE' }, vehicle: v });
    await expect(svc.assertDriverDispatchable('d1')).rejects.toMatchObject({ statusCode: 403, code: 'DRIVER_VEHICLE_INCOMPATIBLE' });
  });
});

// ── §4.2 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('settlement concurrency', () => {
  const trips = [{ fareAmount: 1000, platformFeeAmount: 150 }];
  const args = { fleetPartnerId: FLEET.id, periodStart: '2026-11-01', periodEnd: '2026-11-08', actor: 'u' };
  beforeEach(() => {
    jest.clearAllMocks(); mockDb.$transaction.mockImplementation(async (fn) => fn(mockDb)); mockDb.activityLog.create.mockResolvedValue({});
    mockDb.fleetPartner.findUnique.mockResolvedValue(FLEET); mockDb.fleetTrip.findMany.mockResolvedValue(trips);
    mockDb.fleetSettlement.findFirst.mockReset().mockResolvedValue(null);
    mockDb.fleetSettlement.create.mockImplementation(async ({ data }) => ({ id: 's1', status: 'PENDING', ...data }));
  });
  test('creation runs in ONE transaction and takes a per-fleet advisory lock first', async () => {
    await svc.createSettlement(args);
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    expect(mockDb.$executeRaw).toHaveBeenCalledTimes(1);
    expect(String(mockDb.$executeRaw.mock.calls[0][0].join(''))).toMatch(/pg_advisory_xact_lock/);
  });
  test('idempotent: replaying the same request returns the existing statement and creates nothing', async () => {
    mockDb.fleetSettlement.findFirst.mockResolvedValueOnce({ id: 'existing', status: 'APPROVED', reference: 'ref' });
    const r = await svc.createSettlement(args);
    expect(r).toMatchObject({ idempotent: true, settlement: { id: 'existing' } });
    expect(mockDb.fleetSettlement.create).not.toHaveBeenCalled();
  });
  test('a CANCELLED statement with the same reference does not block a re-issue (distinct reference)', async () => {
    mockDb.fleetSettlement.findFirst.mockResolvedValueOnce({ id: 'old', status: 'CANCELLED', reference: 'FS-X' }).mockResolvedValueOnce(null);
    const r = await svc.createSettlement(args);
    expect(r.idempotent).toBe(false); expect(mockDb.fleetSettlement.create.mock.calls[0][0].data.reference).toMatch(/-R[a-z0-9]+$/);
  });
  test('loser of a race (unique reference / exclusion constraint) gets a clean 409 SETTLEMENT_OVERLAP', async () => {
    for (const e of [Object.assign(new Error('u'), { code: 'P2002' }), Object.assign(new Error('x'), { code: '23P01' }), Object.assign(new Error('raw 23P01 conflicting key'), { code: 'P2010' })]) {
      mockDb.fleetSettlement.create.mockRejectedValueOnce(e);
      await expect(svc.createSettlement(args)).rejects.toMatchObject({ statusCode: 409, code: 'SETTLEMENT_OVERLAP' });
    }
  });
  test('overlap found inside the transaction → 409', async () => {
    mockDb.fleetSettlement.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'other' });
    await expect(svc.createSettlement(args)).rejects.toMatchObject({ statusCode: 409, code: 'SETTLEMENT_OVERLAP' });
  });
  test('two simultaneous transitions: the loser changes 0 rows and gets 409, never overwriting the newer state', async () => {
    mockDb.fleetSettlement.findUnique.mockResolvedValue({ id: 's', status: 'PENDING', fleetPartnerId: 'f' });
    mockDb.fleetSettlement.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const [a, b] = await Promise.allSettled([svc.transitionSettlement({ id: 's', to: 'RECONCILING', actor: 'a1' }), svc.transitionSettlement({ id: 's', to: 'CANCELLED', actor: 'a2' })]);
    expect(a.status).toBe('fulfilled');
    expect(b).toMatchObject({ status: 'rejected', reason: { statusCode: 409, code: 'SETTLEMENT_STATE_CHANGED' } });
    for (const c of mockDb.fleetSettlement.updateMany.mock.calls) expect(c[0].where).toEqual({ id: 's', status: 'PENDING' });
  });
  test('maker–checker is still enforced on the server and nothing is written when it refuses', async () => {
    mockDb.fleetSettlement.findUnique.mockResolvedValue({ id: 's', status: 'APPROVED', fleetPartnerId: 'f' });
    mockDb.activityLog.findFirst.mockResolvedValue({ userId: 'admin1' });
    await expect(svc.transitionSettlement({ id: 's', to: 'PAID', actor: 'admin1' })).rejects.toMatchObject({ statusCode: 403 });
    expect(mockDb.fleetSettlement.updateMany).not.toHaveBeenCalled();
  });
});
