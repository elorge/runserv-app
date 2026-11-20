// backend/src/services/orgAccess.js
//
// Who may do what in an organisation's web portal, and how much of its data they see.
//   ORG_ADMIN  everything, including billing, roles and branding
//   HR         staff directory, join requests, delisting, departments, weekend approvals
//   FINANCE    costs, invoices, wallet — read only on people
//   MANAGER    department head / supervisor: costs and trips of their own department(s)
//              and direct reports; approves their trips
//   STAFF      mobile app only; no portal access
'use strict';

const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');

const PORTAL_ROLES = ['ORG_ADMIN', 'HR', 'FINANCE', 'MANAGER'];

const CAN = {
  manageSettings: ['ORG_ADMIN'],
  manageRoles:    ['ORG_ADMIN'],
  manageStaff:    ['ORG_ADMIN', 'HR'],       // join requests, delist, directory, departments
  seeCompanyCost: ['ORG_ADMIN', 'HR', 'FINANCE'],
  seeBilling:     ['ORG_ADMIN', 'FINANCE'],
  audit:          ['ORG_ADMIN', 'HR', 'FINANCE', 'MANAGER'],
  approveTrips:   ['ORG_ADMIN', 'HR', 'MANAGER'],
};

/** The signed-in user's portal membership (active, non-STAFF role) with its company. */
const getPortalMembership = (userId, companyId) =>
  prisma.companyEmployee.findFirst({
    where: { userId, isActive: true, inviteStatus: 'ACTIVE', role: { in: PORTAL_ROLES }, ...(companyId && { companyId }) },
    include: { company: true, headOf: { select: { id: true } } },
    orderBy: { createdAt: 'asc' },
  });

const can = (member, action) => CAN[action].includes(member.role);
const assertCan = (member, action) => {
  if (!can(member, action)) throw new AppError('You do not have permission to do that in this organisation.', 403);
};

/**
 * Prisma `where` fragment limiting CorporateTrip rows to what this member may see.
 * Company-wide roles see everything; a manager sees their department(s) and their direct reports.
 */
const tripScope = (member) => {
  if (can(member, 'seeCompanyCost')) return {};
  const deptIds = (member.headOf ?? []).map((d) => d.id);
  const or = [{ employee: { supervisorId: member.id } }];
  if (deptIds.length) or.push({ departmentId: { in: deptIds } });
  or.push({ employeeId: member.id });
  return { OR: or };
};

/** Same idea for the staff list. */
const staffScope = (member) => {
  if (can(member, 'manageStaff') || can(member, 'seeCompanyCost')) return {};
  const deptIds = (member.headOf ?? []).map((d) => d.id);
  const or = [{ supervisorId: member.id }, { id: member.id }];
  if (deptIds.length) or.push({ departmentId: { in: deptIds } });
  return { OR: or };
};

/** May this member see/act on this specific employee? (used for manager scoping) */
const canSeeEmployee = (member, emp) => {
  if (can(member, 'manageStaff') || can(member, 'seeCompanyCost')) return true;
  if (emp.id === member.id || emp.supervisorId === member.id) return true;
  return (member.headOf ?? []).some((d) => d.id === emp.departmentId);
};

module.exports = { PORTAL_ROLES, CAN, getPortalMembership, can, assertCan, tripScope, staffScope, canSeeEmployee };
