'use strict';
const mockDb = {};
const fn = () => jest.fn();
jest.mock('../src/lib/prisma', () => {
  mockDb.department = { findMany: fn(), create: fn(), findUnique: fn(), update: fn() };
  mockDb.staffDirectoryEntry = { findUnique: fn(), create: fn(), update: fn() };
  mockDb.companyEmployee = { findUnique: fn(), updateMany: fn() };
  return mockDb;
});
jest.mock('../src/services/notification.service', () => ({ notify: jest.fn() }));
const dir = require('../src/services/orgDirectory.service');
const { validateBillingMode } = (() => { jest.mock('../src/utils/auditLog', () => ({ logActivity: jest.fn() })); jest.mock('../src/utils/walletHelpers', () => ({ ensureWallet: jest.fn() })); return require('../src/controllers/adminOrg.controller'); })();

beforeEach(() => {
  jest.resetAllMocks();
  mockDb.department.findMany.mockResolvedValue([{ id: 'dSales', name: 'Sales', costCenter: 'SALES' }]);
  mockDb.department.create.mockImplementation(async ({ data }) => ({ id: `d-${data.name}`, ...data }));
  mockDb.staffDirectoryEntry.findUnique.mockResolvedValue(null);
  mockDb.staffDirectoryEntry.create.mockImplementation(async ({ data }) => data);
});

describe('directory import', () => {
  test('creates people, creates missing departments (cost centre = name), normalises staff IDs, links supervisors by ID', async () => {
    const r = await dir.importDirectory('c1', [
      { staffNumber: ' emp-001 ', fullName: 'Ada Obi', department: 'sales', jobTitle: 'Officer', supervisorStaffNumber: 'emp-000' },
      { staffNumber: 'EMP-002', fullName: 'Emeka Nwosu', department: 'Legal', email: 'E@Acme.com' },
    ]);
    expect(r).toMatchObject({ created: 2, updated: 0, departmentsCreated: 1, skipped: [] });
    const calls = mockDb.staffDirectoryEntry.create.mock.calls.map((c) => c[0].data);
    expect(calls[0]).toMatchObject({ staffNumber: 'EMP-001', departmentId: 'dSales', supervisorStaffNumber: 'EMP-000' });
    expect(calls[1]).toMatchObject({ staffNumber: 'EMP-002', departmentId: 'd-Legal', email: 'e@acme.com' });
    expect(mockDb.department.create.mock.calls[0][0].data).toMatchObject({ name: 'Legal', costCenter: 'LEGAL' });
  });
  test('re-importing updates existing people instead of duplicating them', async () => {
    mockDb.staffDirectoryEntry.findUnique.mockResolvedValue({ id: 'de1' });
    const r = await dir.importDirectory('c1', [{ staffNumber: 'EMP-001', fullName: 'Ada Obi' }]);
    expect(r).toMatchObject({ created: 0, updated: 1 });
    expect(mockDb.staffDirectoryEntry.update).toHaveBeenCalledWith({ where: { id: 'de1' }, data: expect.objectContaining({ status: 'ACTIVE' }) });
  });
  test('bad rows are skipped with their spreadsheet row number', async () => {
    const r = await dir.importDirectory('c1', [{ staffNumber: '', fullName: 'No ID' }, { staffNumber: 'A1', fullName: 'Ok' }, { staffNumber: 'a1', fullName: 'Dup' }]);
    expect(r.created).toBe(1);
    expect(r.skipped).toEqual([{ row: 2, reason: expect.stringMatching(/required/) }, { row: 4, reason: expect.stringMatching(/Duplicate/) }]);
  });
  test('empty and oversized files', async () => {
    await expect(dir.importDirectory('c1', [])).rejects.toMatchObject({ code: 'ORG_IMPORT_EMPTY' });
    await expect(dir.importDirectory('c1', new Array(5001).fill({ staffNumber: 'x', fullName: 'y' }))).rejects.toMatchObject({ code: 'ORG_IMPORT_TOO_BIG' });
  });
});

describe('departments', () => {
  test('a department head becomes MANAGER and supervisor of unsupervised members', async () => {
    mockDb.department.findUnique.mockResolvedValue({ id: 'dSales', companyId: 'c1', name: 'Sales', costCenter: 'SALES' });
    mockDb.companyEmployee.findUnique.mockResolvedValue({ companyId: 'c1', isActive: true, inviteStatus: 'ACTIVE' });
    mockDb.department.update.mockImplementation(async ({ data }) => data);
    await dir.updateDepartment('c1', 'dSales', { headEmployeeId: 'mgr1', monthlyBudget: 500000 });
    expect(mockDb.department.update.mock.calls[0][0].data).toMatchObject({ headEmployeeId: 'mgr1', monthlyBudget: 500000 });
    expect(mockDb.companyEmployee.updateMany).toHaveBeenCalledWith({ where: { departmentId: 'dSales', supervisorId: null, id: { not: 'mgr1' } }, data: { supervisorId: 'mgr1' } });
    expect(mockDb.companyEmployee.updateMany).toHaveBeenCalledWith({ where: { id: 'mgr1', role: 'STAFF' }, data: { role: 'MANAGER' } });
  });
  test('a head from another company is refused; duplicate names are refused', async () => {
    mockDb.companyEmployee.findUnique.mockResolvedValue({ companyId: 'OTHER', isActive: true, inviteStatus: 'ACTIVE' });
    await expect(dir.createDepartment('c1', { name: 'Ops', headEmployeeId: 'x' })).rejects.toMatchObject({ code: 'ORG_SUPERVISOR_INVALID' });
    mockDb.department.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    await expect(dir.createDepartment('c1', { name: 'Sales' })).rejects.toMatchObject({ code: 'ORG_DEPARTMENT_EXISTS' });
  });
});

describe('credit needs verification, a limit and signed terms (Runserv side)', () => {
  const c = { billingMode: 'PREPAID', verificationStatus: 'UNVERIFIED', creditLimit: 0, creditTermsSignedAt: null };
  test('prepaid is always fine', () => expect(validateBillingMode(c, { billingMode: 'PREPAID' })).toBeNull());
  test('postpaid/hybrid are refused until every condition holds', () => {
    expect(validateBillingMode(c, { billingMode: 'POSTPAID' })).toMatch(/Verify the company/);
    const v = { ...c, verificationStatus: 'VERIFIED' };
    expect(validateBillingMode(v, { billingMode: 'HYBRID' })).toMatch(/credit limit/);
    expect(validateBillingMode(v, { billingMode: 'HYBRID', creditLimit: 500000 })).toMatch(/signed/);
    expect(validateBillingMode(v, { billingMode: 'HYBRID', creditLimit: 500000, creditTermsSignedAt: new Date() })).toBeNull();
  });
});
