'use strict';
// Rules of the organisation product: staff IDs, directory matching, HR approval/delisting,
// approvals, booking eligibility and funding at trip completion.

const mockDb = {};
const fn = () => jest.fn();
jest.mock('../src/lib/prisma', () => {
  mockDb.company = { findUnique: fn(), findMany: fn(), update: fn() };
  mockDb.companyEmployee = { findFirst: fn(), findUnique: fn(), findMany: fn(), create: fn(), update: fn(), updateMany: fn(), count: fn() };
  mockDb.user = { findUnique: fn() };
  mockDb.department = { findUnique: fn(), updateMany: fn() };
  mockDb.staffDirectoryEntry = { findUnique: fn(), update: fn() };
  mockDb.weekendRideRequest = { findFirst: fn(), findUnique: fn(), create: fn(), update: fn(), updateMany: fn() };
  mockDb.approvalRequest = { findFirst: fn(), findUnique: fn(), create: fn(), update: fn(), updateMany: fn() };
  mockDb.corporateTrip = { aggregate: fn(), count: fn(), create: fn(), findFirst: fn(), update: fn(), updateMany: fn() };
  mockDb.companyInvoice = { findFirst: fn(), findMany: fn() };
  mockDb.payment = { updateMany: fn() };
  mockDb.wallet = { update: fn() };
  mockDb.walletTransaction = { create: fn() };
  mockDb.orgWalletTx = { create: fn(), findUnique: fn() };
  mockDb.$transaction = jest.fn(async (arg) => (typeof arg === 'function' ? arg(mockDb) : Promise.all(arg)));
  return mockDb;
});
jest.mock('../src/services/notification.service', () => ({ notify: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/utils/walletHelpers', () => ({ ensureWallet: jest.fn(async (id) => ({ id: `w-${id}` })) }));

const svc = require('../src/services/corporate.service');
const notifications = require('../src/services/notification.service');

const MON = new Date('2026-11-16T09:00:00Z');   // Monday 10:00 Lagos
const SAT = new Date('2026-11-21T09:00:00Z');
const co = (o = {}) => ({ id: 'c1', name: 'Acme Ltd', status: 'ACTIVE', timezone: 'Africa/Lagos', weekendPolicy: 'APPROVAL_REQUIRED', requireTripPurpose: true, allowDeliveries: true,
  commissionRate: 0.18, currency: 'NGN', billingMode: 'PREPAID', walletBalance: 100000, creditLimit: 0, verificationStatus: 'UNVERIFIED', creditTermsSignedAt: null,
  maxTripAmount: null, approvalThreshold: null, ...o });
const dept = (o = {}) => ({ id: 'd1', name: 'Sales', costCenter: 'CC-SALES', monthlyBudget: null, maxTripAmount: null, approvalThreshold: null, headEmployeeId: 'mgr1', ...o });
const member = (o = {}, c = co(), d = dept()) => ({ id: 'e1', userId: 'u1', companyId: 'c1', role: 'STAFF', monthlyLimit: 30000, restrictToBusinessHours: false, requireTripPurpose: false,
  inviteStatus: 'ACTIVE', isActive: true, supervisorId: 'mgr1', departmentId: 'd1', company: c, department: d, ...o });
const spend = (n) => mockDb.corporateTrip.aggregate.mockResolvedValue({ _sum: { fare: n, distanceKm: 0, creditAmount: 0 }, _count: { _all: 0 } });
const ok = (o = {}) => ({ userId: 'u1', estimatedFare: 2000, purpose: 'Client visit — Zenith Bank', now: MON, ...o });

beforeEach(() => {
  jest.resetAllMocks();
  mockDb.$transaction.mockImplementation(async (arg) => (typeof arg === 'function' ? arg(mockDb) : Promise.all(arg)));
  notifications.notify.mockResolvedValue({});
  require('../src/utils/walletHelpers').ensureWallet.mockImplementation(async (id) => ({ id: `w-${id}` }));
  mockDb.companyInvoice.findFirst.mockResolvedValue(null); mockDb.companyInvoice.findMany.mockResolvedValue([]);
  mockDb.weekendRideRequest.findFirst.mockResolvedValue(null); mockDb.department.findUnique.mockResolvedValue(null);
  spend(0);
});

describe('staff IDs and names', () => {
  test('staff IDs ignore case and spaces', () => {
    expect(svc.normalizeStaffNumber(' emp - 042 ')).toBe('EMP-042');
    expect(svc.normalizeStaffNumber('FB/00123')).toBe('FB/00123');
  });
  test('names match with middle names and accents, not with a different surname', () => {
    expect(svc.namesMatch('Ada Obi', 'Ada Chinwe Obi')).toBe(true);
    expect(svc.namesMatch('Chinwe Ada Obi', 'ada obi')).toBe(true);
    expect(svc.namesMatch('José Álvarez', 'Jose Alvarez')).toBe(true);
    expect(svc.namesMatch('Ada Obi', 'Ada Okafor')).toBe(false);
    expect(svc.namesMatch('', 'Ada Obi')).toBe(false);
  });
  test('org code normalisation', () => {
    for (const raw of ['rs-4k9q2x', 'RS4K9Q2X', '4k9q2x']) expect(svc.normalizeOrgCode(raw)).toBe('RS-4K9Q2X');
    expect(svc.normalizeOrgCode('RS-RSAB12')).toBe('RS-RSAB12');
  });
});

describe('requestToJoin — checked against the staff directory', () => {
  const entry = (o = {}) => ({ id: 'de1', status: 'ACTIVE', fullName: 'Ada Chinwe Obi', departmentId: 'd1', jobTitle: 'Account Officer', ...o });
  beforeEach(() => {
    mockDb.company.findUnique.mockResolvedValue({ id: 'c1', name: 'Acme Ltd', status: 'ACTIVE', orgCode: 'RS-4K9Q2X', logoUrl: null });
    mockDb.user.findUnique.mockResolvedValue({ firstName: 'Ada', lastName: 'Obi' });
    mockDb.companyEmployee.findFirst.mockResolvedValue(null);
    mockDb.companyEmployee.findUnique.mockResolvedValue(null);
    mockDb.companyEmployee.findMany.mockResolvedValue([{ userId: 'hr1' }, { userId: 'admin1' }]);
    mockDb.companyEmployee.create.mockImplementation(async ({ data }) => ({ id: 'e9', ...data }));
    mockDb.staffDirectoryEntry.findUnique.mockResolvedValue(entry());
  });

  test('matching ID + name → EXACT; request stored PENDING with normalised ID; HR and admin are told', async () => {
    const r = await svc.requestToJoin({ userId: 'u1', orgCode: 'rs 4k9q2x', staffNumber: ' emp-042 ', department: 'Sales' });
    expect(r.directoryMatch).toBe('EXACT');
    expect(mockDb.companyEmployee.create.mock.calls[0][0].data).toMatchObject({ staffNumber: 'EMP-042', inviteStatus: 'PENDING', role: 'STAFF', directoryEntryId: 'de1', directoryMatch: 'EXACT', claimedDepartment: 'Sales' });
    expect(notifications.notify).toHaveBeenCalledTimes(2);
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'hr1', type: 'org_join_request' }));
  });
  test('right ID but a different name → NAME_MISMATCH (HR will look closely)', async () => {
    mockDb.staffDirectoryEntry.findUnique.mockResolvedValue(entry({ fullName: 'Emeka Nwosu' }));
    expect((await svc.requestToJoin({ userId: 'u1', orgCode: 'RS-4K9Q2X', staffNumber: 'EMP-042' })).directoryMatch).toBe('NAME_MISMATCH');
  });
  test('ID not in the directory → NOT_FOUND; ID of someone who left → EXITED', async () => {
    mockDb.staffDirectoryEntry.findUnique.mockResolvedValue(null);
    expect((await svc.requestToJoin({ userId: 'u1', orgCode: 'RS-4K9Q2X', staffNumber: 'X1' })).directoryMatch).toBe('NOT_FOUND');
    mockDb.staffDirectoryEntry.findUnique.mockResolvedValue(entry({ status: 'EXITED' }));
    expect((await svc.requestToJoin({ userId: 'u1', orgCode: 'RS-4K9Q2X', staffNumber: 'X2' })).directoryMatch).toBe('EXITED');
  });
  test('department is optional now (HR assigns it); staff ID is mandatory', async () => {
    await expect(svc.requestToJoin({ userId: 'u1', orgCode: 'RS-4K9Q2X', staffNumber: 'EMP-1' })).resolves.toBeTruthy();
    await expect(svc.requestToJoin({ userId: 'u1', orgCode: 'RS-4K9Q2X', staffNumber: '  ' })).rejects.toMatchObject({ code: 'ORG_STAFF_NUMBER_REQUIRED' });
  });
  test('inactive/unknown org code is refused', async () => {
    mockDb.company.findUnique.mockResolvedValue({ id: 'c1', status: 'PENDING', orgCode: 'RS-4K9Q2X' });
    await expect(svc.requestToJoin({ userId: 'u1', orgCode: 'RS-4K9Q2X', staffNumber: '1' })).rejects.toMatchObject({ code: 'ORG_NOT_FOUND' });
  });
  test('a staff ID already used by someone else is refused; so is a second organisation', async () => {
    mockDb.companyEmployee.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'other' });
    await expect(svc.requestToJoin({ userId: 'u1', orgCode: 'RS-4K9Q2X', staffNumber: 'EMP-1' })).rejects.toMatchObject({ code: 'ORG_STAFF_NUMBER_TAKEN' });
    mockDb.companyEmployee.findFirst.mockResolvedValueOnce({ inviteStatus: 'ACTIVE', company: { name: 'Beta plc' } });
    await expect(svc.requestToJoin({ userId: 'u1', orgCode: 'RS-4K9Q2X', staffNumber: 'EMP-1' })).rejects.toMatchObject({ code: 'ORG_ALREADY_MEMBER' });
  });
  test('a delisted person can apply again (same row goes back to PENDING, exit data cleared)', async () => {
    mockDb.companyEmployee.findUnique.mockResolvedValue({ id: 'e5', isActive: false, inviteStatus: 'DELISTED' });
    mockDb.companyEmployee.update.mockImplementation(async ({ data }) => ({ id: 'e5', ...data }));
    const r = await svc.requestToJoin({ userId: 'u1', orgCode: 'RS-4K9Q2X', staffNumber: 'EMP-9' });
    expect(r.employee).toMatchObject({ id: 'e5', inviteStatus: 'PENDING', exitedAt: null, departmentId: null });
  });
});

describe('HR review', () => {
  const pending = { id: 'e1', companyId: 'c1', userId: 'u1', inviteStatus: 'PENDING', directoryEntryId: 'de1', company: { id: 'c1', name: 'Acme Ltd' } };
  beforeEach(() => {
    mockDb.companyEmployee.findUnique.mockImplementation(async ({ where }) => (where.id === 'e1' ? pending : { companyId: 'c1', isActive: true }));
    mockDb.companyEmployee.findFirst.mockResolvedValue(null);
    mockDb.companyEmployee.update.mockImplementation(async ({ data }) => data);
    mockDb.staffDirectoryEntry.findUnique.mockResolvedValue({ id: 'de1', departmentId: 'd1', supervisorStaffNumber: null, jobTitle: 'Account Officer' });
    mockDb.department.findUnique.mockResolvedValue({ id: 'd1', companyId: 'c1', isActive: true, headEmployeeId: 'mgr1' });
  });
  test('approve: department from the directory, supervisor defaults to the department head, limit set, person told', async () => {
    const r = await svc.reviewJoinRequest({ companyId: 'c1', employeeId: 'e1', reviewerId: 'hr1', approve: true, monthlyLimit: 45000 });
    expect(r).toMatchObject({ inviteStatus: 'ACTIVE', isActive: true, departmentId: 'd1', supervisorId: 'mgr1', monthlyLimit: 45000, reviewedById: 'hr1', jobTitle: 'Account Officer' });
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', type: 'org_join_approved' }));
  });
  test('the supervisor named in the directory wins over the department head', async () => {
    mockDb.staffDirectoryEntry.findUnique.mockResolvedValue({ id: 'de1', departmentId: 'd1', supervisorStaffNumber: 'emp-007' });
    mockDb.companyEmployee.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'sup7' });
    expect((await svc.reviewJoinRequest({ companyId: 'c1', employeeId: 'e1', reviewerId: 'hr1', approve: true })).supervisorId).toBe('sup7');
  });
  test('approval needs a department (cost centre)', async () => {
    mockDb.staffDirectoryEntry.findUnique.mockResolvedValue(null);
    await expect(svc.reviewJoinRequest({ companyId: 'c1', employeeId: 'e1', reviewerId: 'hr1', approve: true })).rejects.toMatchObject({ code: 'ORG_DEPARTMENT_REQUIRED' });
  });
  test('decline records the reason; already-handled and other-company requests are refused', async () => {
    expect(await svc.reviewJoinRequest({ companyId: 'c1', employeeId: 'e1', reviewerId: 'hr1', approve: false, note: 'Not on payroll' })).toMatchObject({ inviteStatus: 'REJECTED', isActive: false, reviewNote: 'Not on payroll' });
    await expect(svc.reviewJoinRequest({ companyId: 'OTHER', employeeId: 'e1', reviewerId: 'x', approve: true })).rejects.toMatchObject({ code: 'ORG_REQUEST_NOT_FOUND' });
    mockDb.companyEmployee.findUnique.mockImplementation(async () => ({ ...pending, inviteStatus: 'ACTIVE' }));
    await expect(svc.reviewJoinRequest({ companyId: 'c1', employeeId: 'e1', reviewerId: 'hr1', approve: false })).rejects.toMatchObject({ code: 'ORG_REQUEST_HANDLED' });
  });
});

describe('delisting leavers', () => {
  const active = { id: 'e1', companyId: 'c1', userId: 'u1', role: 'STAFF', inviteStatus: 'ACTIVE', isActive: true, directoryEntryId: 'de1', company: { name: 'Acme Ltd' } };
  beforeEach(() => { mockDb.companyEmployee.findUnique.mockResolvedValue(active); mockDb.companyEmployee.update.mockResolvedValue({}); });

  test('HR delists: status DELISTED, reports un-supervised, departments un-headed, directory EXITED, open requests cancelled, person told', async () => {
    await svc.delistEmployee({ companyId: 'c1', employeeId: 'e1', byId: 'hrUser', reason: 'RESIGNED' });
    expect(mockDb.companyEmployee.update).toHaveBeenCalledWith({ where: { id: 'e1' }, data: expect.objectContaining({ inviteStatus: 'DELISTED', isActive: false, exitReason: 'RESIGNED', delistedById: 'hrUser' }) });
    expect(mockDb.companyEmployee.updateMany).toHaveBeenCalledWith({ where: { supervisorId: 'e1' }, data: { supervisorId: null } });
    expect(mockDb.department.updateMany).toHaveBeenCalledWith({ where: { headEmployeeId: 'e1' }, data: { headEmployeeId: null } });
    expect(mockDb.staffDirectoryEntry.update).toHaveBeenCalledWith({ where: { id: 'de1' }, data: expect.objectContaining({ status: 'EXITED' }) });
    expect(mockDb.approvalRequest.updateMany).toHaveBeenCalled(); expect(mockDb.weekendRideRequest.updateMany).toHaveBeenCalled();
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', type: 'org_delisted' }));
  });
  test('you cannot delist yourself or the only admin', async () => {
    await expect(svc.delistEmployee({ companyId: 'c1', employeeId: 'e1', byId: 'u1' })).rejects.toMatchObject({ code: 'ORG_SELF_DELIST' });
    mockDb.companyEmployee.findUnique.mockResolvedValue({ ...active, role: 'ORG_ADMIN' }); mockDb.companyEmployee.count.mockResolvedValue(1);
    await expect(svc.delistEmployee({ companyId: 'c1', employeeId: 'e1', byId: 'other' })).rejects.toMatchObject({ code: 'ORG_LAST_ADMIN' });
  });
  test('someone not currently listed cannot be delisted', async () => {
    mockDb.companyEmployee.findUnique.mockResolvedValue({ ...active, inviteStatus: 'DELISTED', isActive: false });
    await expect(svc.delistEmployee({ companyId: 'c1', employeeId: 'e1', byId: 'x' })).rejects.toMatchObject({ code: 'ORG_NOT_MEMBER' });
  });
  test('roles: the last ORG_ADMIN cannot be demoted', async () => {
    mockDb.companyEmployee.findUnique.mockResolvedValue({ ...active, role: 'ORG_ADMIN' }); mockDb.companyEmployee.count.mockResolvedValue(1);
    await expect(svc.setRole({ companyId: 'c1', employeeId: 'e1', role: 'HR', byId: 'x' })).rejects.toMatchObject({ code: 'ORG_LAST_ADMIN' });
  });
});

describe('evaluateBooking', () => {
  const as = (m) => mockDb.companyEmployee.findFirst.mockResolvedValue(m);

  test('listed staff, weekday, purpose, funded wallet → allowed; trip is tagged with department and cost centre', async () => {
    as(member());
    const r = await svc.evaluateBooking(ok());
    expect(r).toMatchObject({ weekendTrip: false, approvalId: null });
    expect(r.department).toMatchObject({ id: 'd1', costCenter: 'CC-SALES' });
  });
  test('not listed / suspended company', async () => {
    as(null); await expect(svc.evaluateBooking(ok())).rejects.toMatchObject({ code: 'ORG_NOT_MEMBER' });
    as(member({}, co({ status: 'SUSPENDED' }))); await expect(svc.evaluateBooking(ok())).rejects.toMatchObject({ code: 'ORG_SUSPENDED' });
  });
  test('a delisted person has no membership, so they simply cannot book on the company', async () => {
    as(null); await expect(svc.evaluateBooking(ok())).rejects.toMatchObject({ code: 'ORG_NOT_MEMBER' });
    expect(mockDb.companyEmployee.findFirst.mock.calls[0][0].where).toMatchObject({ isActive: true, inviteStatus: 'ACTIVE' });
  });
  test('weekend policy still applies', async () => {
    as(member());
    await expect(svc.evaluateBooking(ok({ now: SAT }))).rejects.toMatchObject({ code: 'ORG_WEEKEND_APPROVAL_REQUIRED' });
    mockDb.weekendRideRequest.findFirst.mockResolvedValue({ id: 'w1' });
    expect(await svc.evaluateBooking(ok({ now: SAT }))).toMatchObject({ weekendTrip: true, weekendRequestId: 'w1' });
  });
  test('purpose required', async () => {
    as(member()); await expect(svc.evaluateBooking(ok({ purpose: '' }))).rejects.toMatchObject({ code: 'ORG_PURPOSE_REQUIRED' });
  });
  test('hard per-trip cap: the department overrides the company', async () => {
    as(member({}, co({ maxTripAmount: 1500 })));
    await expect(svc.evaluateBooking(ok({ estimatedFare: 2000 }))).rejects.toMatchObject({ code: 'ORG_TRIP_CAP' });
    as(member({}, co({ maxTripAmount: 1500 }), dept({ maxTripAmount: 5000 })));
    await expect(svc.evaluateBooking(ok({ estimatedFare: 2000 }))).resolves.toBeTruthy();
  });
  test('personal allowance', async () => {
    as(member({ monthlyLimit: 10000 })); spend(9000);
    await expect(svc.evaluateBooking(ok({ estimatedFare: 2000 }))).rejects.toMatchObject({ code: 'ORG_STAFF_LIMIT' });
  });
  test('department budget', async () => {
    as(member({ monthlyLimit: 0 }, co(), dept({ monthlyBudget: 50000 }))); spend(49000);
    await expect(svc.evaluateBooking(ok({ estimatedFare: 2000, userId: 'u1' }))).rejects.toMatchObject({ code: 'ORG_DEPT_BUDGET' });
  });
  test('overdue invoice pauses company rides', async () => {
    as(member()); mockDb.companyInvoice.findFirst.mockResolvedValue({ id: 'i1' });
    await expect(svc.evaluateBooking(ok())).rejects.toMatchObject({ code: 'ORG_OVERDUE' });
  });

  describe('manager approval', () => {
    const withThreshold = (o = {}) => member(o, co({ approvalThreshold: 1500 }));
    const pass = (o = {}) => ({ id: 'a1', employeeId: 'e1', status: 'APPROVED', serviceType: 'RIDE', estimatedFare: 2000, expiresAt: new Date('2026-11-16T20:00:00Z'), ...o });

    test('over the threshold → ORG_APPROVAL_REQUIRED (with details so the app can ask)', async () => {
      as(withThreshold());
      await expect(svc.evaluateBooking(ok())).rejects.toMatchObject({ code: 'ORG_APPROVAL_REQUIRED', details: { threshold: 1500, fare: 2000 } });
    });
    test('under the threshold, or an org admin → no approval', async () => {
      as(withThreshold()); await expect(svc.evaluateBooking(ok({ estimatedFare: 1000 }))).resolves.toBeTruthy();
      as(withThreshold({ role: 'ORG_ADMIN' })); await expect(svc.evaluateBooking(ok())).resolves.toBeTruthy();
    });
    test('an approved pass lets the booking through and is recorded', async () => {
      as(withThreshold()); mockDb.approvalRequest.findUnique.mockResolvedValue(pass());
      expect((await svc.evaluateBooking(ok({ approvalId: 'a1' }))).approvalId).toBe('a1');
    });
    test('passes that are used, expired, someone else\'s, for another service or too low are refused', async () => {
      as(withThreshold());
      for (const bad of [pass({ status: 'USED' }), pass({ status: 'PENDING' }), pass({ expiresAt: new Date('2026-11-16T08:00:00Z') }), pass({ employeeId: 'other' }), pass({ serviceType: 'DELIVERY' }), pass({ estimatedFare: 1000 })]) {
        mockDb.approvalRequest.findUnique.mockResolvedValue(bad);
        await expect(svc.evaluateBooking(ok({ approvalId: 'a1' }))).rejects.toMatchObject({ code: expect.stringMatching(/^ORG_APPROVAL_/) });
      }
    });
    test('requesting approval goes to the supervisor when they hold a manager role', async () => {
      as(withThreshold({ supervisor: null }));
      mockDb.companyEmployee.findUnique.mockResolvedValue({ id: 'mgr1', userId: 'mgrUser', role: 'MANAGER', isActive: true });
      mockDb.user.findUnique.mockResolvedValue({ firstName: 'Ada', lastName: 'Obi' });
      mockDb.approvalRequest.create.mockImplementation(async ({ data }) => ({ id: 'a9', ...data }));
      const r = await svc.requestApproval({ userId: 'u1', pickupAddress: 'A', dropoffAddress: 'B', estimatedFare: 2000, now: MON });
      expect(r).toMatchObject({ approverEmployeeId: 'mgr1', reason: 'OVER_THRESHOLD' });
      expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'mgrUser', type: 'org_approval_request' }));
    });
    test('requesting approval for a trip that needs none is refused', async () => {
      as(withThreshold());
      await expect(svc.requestApproval({ userId: 'u1', pickupAddress: 'A', dropoffAddress: 'B', estimatedFare: 500, now: MON })).rejects.toMatchObject({ code: 'ORG_APPROVAL_NOT_NEEDED' });
    });
    test('deciding: a manager may decide for their own department, not for others; never for themselves', async () => {
      const req = { id: 'a1', companyId: 'c1', employeeId: 'e1', status: 'PENDING', expiresAt: new Date('2026-11-17T09:00:00Z'), approverEmployeeId: 'mgr1', dropoffAddress: 'B', employee: { userId: 'u1', supervisorId: 'mgr1', departmentId: 'd1' } };
      mockDb.approvalRequest.findUnique.mockResolvedValue(req); mockDb.approvalRequest.update.mockImplementation(async ({ data }) => data);
      const mgr = { id: 'mgr1', companyId: 'c1', role: 'MANAGER', headOf: [{ id: 'd1' }] };
      expect(await svc.decideApproval({ decider: mgr, approvalId: 'a1', approve: true, now: MON })).toMatchObject({ status: 'APPROVED', decidedById: 'mgr1' });
      await expect(svc.decideApproval({ decider: { id: 'mgr2', companyId: 'c1', role: 'MANAGER', headOf: [{ id: 'd9' }] }, approvalId: 'a1', approve: true, now: MON })).rejects.toMatchObject({ statusCode: 403 });
      await expect(svc.decideApproval({ decider: { id: 'e1', companyId: 'c1', role: 'HR', headOf: [] }, approvalId: 'a1', approve: true, now: MON })).rejects.toMatchObject({ code: 'ORG_SELF_APPROVAL' });
    });
  });

  describe('funding is part of eligibility', () => {
    test('prepaid: the wallet must cover the fare (minus what other open trips hold)', async () => {
      as(member({}, co({ walletBalance: 5000 })));
      mockDb.corporateTrip.aggregate.mockResolvedValue({ _sum: { fare: 4000, creditAmount: 0 }, _count: { _all: 0 } });   // 4000 held by open trips
      await expect(svc.evaluateBooking(ok({ estimatedFare: 2000 }))).rejects.toMatchObject({ code: 'ORG_INSUFFICIENT_FUNDS' });
    });
    test('postpaid needs verification + signed terms + credit room', async () => {
      as(member({}, co({ billingMode: 'POSTPAID', walletBalance: 0 })));
      await expect(svc.evaluateBooking(ok())).rejects.toMatchObject({ code: 'ORG_CREDIT_NOT_APPROVED' });
      as(member({}, co({ billingMode: 'POSTPAID', walletBalance: 0, verificationStatus: 'VERIFIED', creditTermsSignedAt: new Date(), creditLimit: 1000 })));
      await expect(svc.evaluateBooking(ok({ estimatedFare: 2000 }))).rejects.toMatchObject({ code: 'ORG_CREDIT_LIMIT' });
      as(member({}, co({ billingMode: 'POSTPAID', walletBalance: 0, verificationStatus: 'VERIFIED', creditTermsSignedAt: new Date(), creditLimit: 500000 })));
      await expect(svc.evaluateBooking(ok({ estimatedFare: 2000 }))).resolves.toBeTruthy();
    });
    test('hybrid: wallet first, credit covers the rest', async () => {
      const c = co({ billingMode: 'HYBRID', walletBalance: 1000, verificationStatus: 'VERIFIED', creditTermsSignedAt: new Date(), creditLimit: 500000 });
      as(member({}, c)); await expect(svc.evaluateBooking(ok({ estimatedFare: 2000 }))).resolves.toBeTruthy();
      const noCredit = co({ billingMode: 'HYBRID', walletBalance: 1000, creditLimit: 0 });
      as(member({}, noCredit)); await expect(svc.evaluateBooking(ok({ estimatedFare: 2000 }))).rejects.toMatchObject({ code: 'ORG_CREDIT_LIMIT' });
    });
  });
});

describe('trip records and completion', () => {
  test('createTripRecord snapshots department, cost centre and supervisor, and spends the approval pass', async () => {
    const tx = { corporateTrip: { create: jest.fn().mockResolvedValue({ id: 't1' }) }, approvalRequest: { update: jest.fn() } };
    await svc.createTripRecord(tx, { evaluation: { company: co({ commissionRate: 0.2 }), employee: { id: 'e1', supervisorId: 'mgr1' }, department: dept(), purpose: 'Client', purposeCategory: 'CLIENT_VISIT', weekendTrip: false, weekendRequestId: null, approvalId: 'a1' }, rideId: 'r1', serviceType: 'RIDE', fare: 3000, distanceKm: 12.4 });
    expect(tx.corporateTrip.create.mock.calls[0][0].data).toMatchObject({ rideId: 'r1', status: 'REQUESTED', departmentId: 'd1', costCenter: 'CC-SALES', supervisorEmployeeId: 'mgr1', commissionAmount: 600, driverEarnings: 2400, approvalRequestId: 'a1' });
    expect(tx.approvalRequest.update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: { status: 'USED' } });
  });

  const completes = async (company, fare = 2000) => {
    mockDb.corporateTrip.findFirst.mockResolvedValue({ id: 't1', companyId: 'c1', serviceType: 'RIDE', status: 'REQUESTED', distanceKm: 10, company });
    mockDb.corporateTrip.update.mockImplementation(async ({ data }) => data);
    mockDb.company.update.mockResolvedValue({ walletBalance: 50000 });
    mockDb.orgWalletTx.create.mockImplementation(async ({ data }) => data);
    return svc.finalizeTrip({ rideId: 'r1', fare, distanceKm: 11, earnerUserId: 'd1', completedAt: new Date('2026-11-17T10:00:00Z') });
  };

  test('PREPAID: paid from the wallet, driver credited immediately, payment marked collected', async () => {
    const r = await completes(co({ billingMode: 'PREPAID', walletBalance: 50000 }));
    expect(r).toMatchObject({ status: 'COMPLETED', walletPaid: 2000, creditAmount: 0, commissionAmount: 360, driverEarnings: 1640 });
    expect(mockDb.company.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { walletBalance: { increment: -2000 } }, select: { walletBalance: true, currency: true } });
    expect(mockDb.orgWalletTx.create.mock.calls[0][0].data).toMatchObject({ type: 'TRIP_CHARGE', amount: -2000, reference: 'TRIP-t1' });
    expect(mockDb.walletTransaction.create.mock.calls[0][0].data).toMatchObject({ walletId: 'w-d1', amount: 1640, reference: 'ORGTRIP-t1' });
    expect(mockDb.payment.updateMany).toHaveBeenCalledWith({ where: { rideId: 'r1', method: 'CORPORATE' }, data: { status: 'COMPLETED' } });
    expect(mockDb.corporateTrip.update).toHaveBeenLastCalledWith({ where: { id: 't1' }, data: { payoutStatus: 'PAID' } });
  });
  test('POSTPAID: everything goes on credit; nothing is paid out yet', async () => {
    const r = await completes(co({ billingMode: 'POSTPAID', walletBalance: 0 }));
    expect(r).toMatchObject({ walletPaid: 0, creditAmount: 2000 });
    expect(mockDb.company.update).not.toHaveBeenCalled(); expect(mockDb.walletTransaction.create).not.toHaveBeenCalled(); expect(mockDb.payment.updateMany).not.toHaveBeenCalled();
  });
  test('HYBRID: wallet part now (driver paid pro rata), the rest on credit', async () => {
    const r = await completes(co({ billingMode: 'HYBRID', walletBalance: 500 }));
    expect(r).toMatchObject({ walletPaid: 500, creditAmount: 1500 });
    expect(mockDb.walletTransaction.create.mock.calls[0][0].data.amount).toBe(410);      // 1640 × 500/2000
    expect(mockDb.payment.updateMany).not.toHaveBeenCalled();                            // still owed on the invoice
  });
  test('completing twice does nothing the second time', async () => {
    mockDb.corporateTrip.findFirst.mockResolvedValue({ id: 't1', status: 'COMPLETED', company: co() });
    await svc.finalizeTrip({ rideId: 'r1', fare: 2000, earnerUserId: 'd1' });
    expect(mockDb.corporateTrip.update).not.toHaveBeenCalled();
  });
  test('non-company ride is a no-op; cancel only touches open trips', async () => {
    mockDb.corporateTrip.findFirst.mockResolvedValue(null);
    expect(await svc.finalizeTrip({ rideId: 'r2', fare: 1, earnerUserId: 'd1' })).toBeNull();
    mockDb.corporateTrip.updateMany.mockResolvedValue({ count: 1 });
    await svc.cancelTrip({ rideId: 'r1' });
    expect(mockDb.corporateTrip.updateMany).toHaveBeenCalledWith({ where: { rideId: 'r1', status: 'REQUESTED' }, data: { status: 'CANCELLED' } });
  });
});
