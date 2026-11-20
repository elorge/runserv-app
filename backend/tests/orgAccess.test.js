'use strict';
jest.mock('../src/lib/prisma', () => ({}));
const a = require('../src/services/orgAccess');

const m = (role, extra = {}) => ({ id: 'me', role, headOf: [], ...extra });

describe('who can do what in the portal', () => {
  test('permissions per role', () => {
    expect(a.can(m('ORG_ADMIN'), 'manageSettings')).toBe(true);
    expect(a.can(m('HR'), 'manageStaff')).toBe(true);
    expect(a.can(m('HR'), 'manageSettings')).toBe(false);
    expect(a.can(m('HR'), 'seeBilling')).toBe(false);
    expect(a.can(m('FINANCE'), 'seeBilling')).toBe(true);
    expect(a.can(m('FINANCE'), 'manageStaff')).toBe(false);
    expect(a.can(m('MANAGER'), 'approveTrips')).toBe(true);
    expect(a.can(m('MANAGER'), 'seeBilling')).toBe(false);
    expect(a.can(m('MANAGER'), 'manageStaff')).toBe(false);
    expect(a.can(m('STAFF'), 'audit')).toBe(false);
  });
  test('assertCan throws 403', () => {
    expect(() => a.assertCan(m('MANAGER'), 'manageSettings')).toThrow(/permission/);
    expect(() => a.assertCan(m('ORG_ADMIN'), 'manageSettings')).not.toThrow();
  });
});

describe('managers only see their own people', () => {
  test('company-wide roles see everything', () => {
    for (const r of ['ORG_ADMIN', 'HR', 'FINANCE']) { expect(a.tripScope(m(r))).toEqual({}); expect(a.staffScope(m(r))).toEqual({}); }
  });
  test('a manager sees trips of departments they head, of direct reports, and their own', () => {
    const scope = a.tripScope(m('MANAGER', { headOf: [{ id: 'dSales' }, { id: 'dOps' }] }));
    expect(scope.OR).toEqual(expect.arrayContaining([{ employee: { supervisorId: 'me' } }, { departmentId: { in: ['dSales', 'dOps'] } }, { employeeId: 'me' }]));
  });
  test('a manager who heads no department still sees their direct reports', () => {
    expect(a.tripScope(m('MANAGER')).OR).toEqual([{ employee: { supervisorId: 'me' } }, { employeeId: 'me' }]);
  });
  test('canSeeEmployee', () => {
    const mgr = m('MANAGER', { headOf: [{ id: 'dSales' }] });
    expect(a.canSeeEmployee(mgr, { id: 'x', departmentId: 'dSales', supervisorId: null })).toBe(true);
    expect(a.canSeeEmployee(mgr, { id: 'x', departmentId: 'dOps', supervisorId: 'me' })).toBe(true);
    expect(a.canSeeEmployee(mgr, { id: 'x', departmentId: 'dOps', supervisorId: 'someoneElse' })).toBe(false);
    expect(a.canSeeEmployee(m('HR'), { id: 'x', departmentId: 'dOps' })).toBe(true);
  });
});
