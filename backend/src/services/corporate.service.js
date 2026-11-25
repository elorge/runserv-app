// backend/src/services/corporate.service.js
//
// Runserv Business — organisation rules.
//
//   • Runserv creates/approves an organisation → it gets an org code and a branded portal.
//   • Staff are ordinary Runserv customers. In the app they ask to be listed with their STAFF ID.
//   • HR checks the request against the company's staff directory and approves, assigning the
//     department (→ cost centre) and supervisor. HR delists people who leave; they stay customers.
//   • Approved staff can book "on the company": the booking checks policy (weekday/weekend,
//     purpose, trip cap, allowance, department budget, funding) and may need a manager's approval.
//   • Every org trip is recorded (CorporateTrip) with department/cost centre for audit and billing.
//
// Wallet & credit: orgWallet.service.js. Invoices & driver payouts: orgBilling.service.js.
'use strict';

const crypto = require('crypto');
const prisma = require('../lib/prisma');
const notificationService = require('./notification.service');
const wallet = require('./orgWallet.service');
const { logger } = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');
const { formatMoney } = require('../utils/currency');
const cal = require('../utils/orgCalendar');

const { OrgError } = wallet;

const CORPORATE_COMMISSION = 0.18;
const OVERDUE_BLOCK_AFTER_DAYS = 7;
const APPROVAL_WINDOW_HOURS = 24;       // a request must be decided within this
const APPROVAL_USE_HOURS = 12;          // an approved pass can be used for this long
const ORG_CODE_PREFIX = 'RS-';
const ORG_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const TRIP_PURPOSES = ['CLIENT_VISIT', 'MARKETING_CALL', 'SITE_VISIT', 'OFFICE_ERRAND', 'AIRPORT', 'MEETING', 'OTHER'];
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const notifySafe = (p) => Promise.resolve(notificationService.notify(p)).catch((e) => logger.warn(`[Org] notify failed: ${e.message}`));
const userLabel = (u) => `${u?.firstName ?? ''} ${u?.lastName ?? ''}`.trim() || 'A staff member';
const dateOnly = (d) => new Date(`${d}T00:00:00.000Z`);
const effectiveRate = (c) => c?.commissionRate ?? CORPORATE_COMMISSION;
const requirePurpose = (company, emp) => Boolean(company?.requireTripPurpose || emp?.requireTripPurpose);

// ── Org code & staff-number normalisation ────────────────────────────────────

const randomCode = () => {
  let b = ''; for (let i = 0; i < 6; i++) b += ORG_CODE_ALPHABET[crypto.randomInt(ORG_CODE_ALPHABET.length)];
  return ORG_CODE_PREFIX + b;
};
const generateOrgCode = async () => {
  for (let i = 0; i < 12; i++) {
    const code = randomCode();
    if (!(await prisma.company.findUnique({ where: { orgCode: code }, select: { id: true } }))) return code;
  }
  throw new AppError('Could not generate a unique organisation code. Please try again.', 500);
};
const normalizeOrgCode = (raw) => {
  const s = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return '';
  return ORG_CODE_PREFIX + (s.length === 6 ? s : (s.startsWith('RS') ? s.slice(2) : s));
};
/** Staff IDs compare case-insensitively and ignore surrounding spaces: " emp-042 " → "EMP-042". */
const normalizeStaffNumber = (raw) => String(raw ?? '').trim().replace(/\s+/g, '').toUpperCase();

const nameTokens = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z\s'-]/g, ' ').split(/\s+/).filter(Boolean);
/** "Ada Obi" matches "Ada Chinwe Obi" (and the other way round) but not "Ada Okafor". */
const namesMatch = (a, b) => {
  const x = nameTokens(a); const y = nameTokens(b);
  if (!x.length || !y.length) return false;
  const [small, big] = x.length <= y.length ? [x, y] : [y, x];
  return small.every((t) => big.includes(t));
};

// ── Companies ────────────────────────────────────────────────────────────────

/** The company's owner (and every ORG_ADMIN) is a member with the ORG_ADMIN role. */
const ensureOwnerMembership = async (company) => {
  const where = { companyId_userId: { companyId: company.id, userId: company.ownerUserId } };
  const existing = await prisma.companyEmployee.findUnique({ where });
  const data = { role: 'ORG_ADMIN', inviteStatus: 'ACTIVE', isActive: true, monthlyLimit: 0, joinedAt: existing?.joinedAt ?? new Date(), reviewedAt: new Date() };
  if (existing) return prisma.companyEmployee.update({ where: { id: existing.id }, data });
  return prisma.companyEmployee.create({
    data: { companyId: company.id, userId: company.ownerUserId, staffNumber: 'ADMIN', jobTitle: 'Organisation administrator', joinSource: 'INVITE', ...data },
  });
};

/** A user may only be in one organisation at a time (listed, or waiting to be). */
const assertNoOtherMembership = async (userId, companyId) => {
  const other = await prisma.companyEmployee.findFirst({
    where: { userId, companyId: { not: companyId }, isActive: true, inviteStatus: { in: ['ACTIVE', 'PENDING'] } },
    include: { company: { select: { name: true } } },
  });
  if (other) {
    throw new OrgError(other.inviteStatus === 'ACTIVE'
      ? `You are already listed under ${other.company.name}. Ask their HR to delist you first.`
      : `You already have a pending request with ${other.company.name}. Cancel it first.`, 'ORG_ALREADY_MEMBER');
  }
};

/** A company applies (e.g. via the app). Runserv reviews and activates it. */
const applyForOrganisation = async ({ ownerUserId, name, rcNumber, email, phone, address, billingEmail }) => {
  await assertNoOtherMembership(ownerUserId, '__none__');
  const orgCode = await generateOrgCode();
  const company = await prisma.company.create({
    data: { name, rcNumber, email, phone, address, billingEmail: billingEmail || null, ownerUserId, orgCode, status: 'PENDING', verificationStatus: 'UNDER_REVIEW' },
  });
  await ensureOwnerMembership(company);
  await notifySafe({ userId: ownerUserId, title: '🏢 Application received', message: `Runserv is reviewing ${name}. You will be told as soon as it is approved.`, type: 'corporate_registered', data: { companyId: company.id } });
  return company;
};

/** What a person may see about an organisation before asking to join (active companies only). */
const lookupOrganisation = async (rawCode) => {
  const orgCode = normalizeOrgCode(rawCode);
  if (!orgCode) throw new OrgError('Enter your organisation code.', 'ORG_CODE_REQUIRED');
  const c = await prisma.company.findUnique({ where: { orgCode }, select: { id: true, name: true, logoUrl: true, brandName: true, brandColor: true, orgCode: true, status: true } });
  if (!c || c.status !== 'ACTIVE') throw new OrgError('No active organisation found for that code. Check the code with your company.', 'ORG_NOT_FOUND', 404);
  return { id: c.id, name: c.brandName || c.name, logoUrl: c.logoUrl, brandColor: c.brandColor, orgCode: c.orgCode };
};

// ── Join requests (staff → HR) ───────────────────────────────────────────────

/**
 * Staff ask to be listed under an organisation with their staff ID. The request is checked against
 * the company's staff directory so HR can see at a glance whether it matches their records.
 */
const requestToJoin = async ({ userId, orgCode, staffNumber, department, jobTitle }) => {
  const staffNo = normalizeStaffNumber(staffNumber);
  const dept = String(department ?? '').trim();
  if (!staffNo) throw new OrgError('Enter your staff ID.', 'ORG_STAFF_NUMBER_REQUIRED');
  if (staffNo.length > 40) throw new OrgError('Staff ID is too long.', 'ORG_STAFF_NUMBER_INVALID');
  if (dept.length > 80) throw new OrgError('Department name is too long.', 'ORG_DEPARTMENT_INVALID');

  const org = await lookupOrganisation(orgCode);
  await assertNoOtherMembership(userId, org.id);

  const existing = await prisma.companyEmployee.findUnique({ where: { companyId_userId: { companyId: org.id, userId } } });
  if (existing && existing.isActive && existing.inviteStatus === 'ACTIVE') throw new OrgError(`You are already listed under ${org.name}.`, 'ORG_ALREADY_MEMBER');

  const dup = await prisma.companyEmployee.findFirst({
    where: { companyId: org.id, userId: { not: userId }, isActive: true, inviteStatus: { in: ['ACTIVE', 'PENDING'] }, staffNumber: staffNo },
    select: { id: true },
  });
  if (dup) throw new OrgError('That staff ID is already registered with this organisation. Check it, or contact your HR.', 'ORG_STAFF_NUMBER_TAKEN');

  const [user, entry] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } }),
    prisma.staffDirectoryEntry.findUnique({ where: { companyId_staffNumber: { companyId: org.id, staffNumber: staffNo } } }),
  ]);
  const directoryMatch = !entry ? 'NOT_FOUND'
    : entry.status === 'EXITED' ? 'EXITED'
      : namesMatch(`${user.firstName} ${user.lastName}`, entry.fullName) ? 'EXACT' : 'NAME_MISMATCH';

  const data = {
    staffNumber: staffNo, claimedDepartment: dept || null, jobTitle: jobTitle ? String(jobTitle).trim() : (entry?.jobTitle ?? null),
    directoryEntryId: entry?.id ?? null, directoryMatch,
    role: 'STAFF', inviteStatus: 'PENDING', isActive: true, joinSource: 'STAFF_REQUEST', requestedAt: new Date(),
    reviewedAt: null, reviewedById: null, reviewNote: null, joinedAt: null, exitedAt: null, exitReason: null, delistedById: null,
    departmentId: null, supervisorId: null,
  };
  const employee = existing
    ? await prisma.companyEmployee.update({ where: { id: existing.id }, data })
    : await prisma.companyEmployee.create({ data: { companyId: org.id, userId, ...data } });

  const hr = await prisma.companyEmployee.findMany({ where: { companyId: org.id, isActive: true, inviteStatus: 'ACTIVE', role: { in: ['HR', 'ORG_ADMIN'] } }, select: { userId: true } });
  const matchTxt = { EXACT: 'matches your staff directory', NAME_MISMATCH: 'name differs from the directory', NOT_FOUND: 'not found in your staff directory', EXITED: 'is marked as having left in your directory' }[directoryMatch];
  for (const h of hr) {
    await notifySafe({ userId: h.userId, title: '👤 New staff request', message: `${userLabel(user)} (staff ID ${staffNo}) asked to be listed under ${org.name} — ${matchTxt}.`, type: 'org_join_request', data: { employeeId: employee.id, companyId: org.id } });
  }
  return { employee, organisation: org, directoryMatch };
};

const cancelJoinRequest = async (userId) => {
  const p = await prisma.companyEmployee.findFirst({ where: { userId, inviteStatus: 'PENDING', joinSource: 'STAFF_REQUEST', isActive: true } });
  if (!p) throw new OrgError('You have no pending request to cancel.', 'ORG_NO_PENDING_REQUEST', 404);
  await prisma.companyEmployee.update({ where: { id: p.id }, data: { inviteStatus: 'REJECTED', isActive: false, reviewNote: 'Cancelled by the staff member', reviewedAt: new Date() } });
  return { cancelled: true };
};

const closeOpenItems = async (employeeId) => {
  await prisma.approvalRequest.updateMany({ where: { employeeId, status: { in: ['PENDING', 'APPROVED'] } }, data: { status: 'CANCELLED' } });
  await prisma.weekendRideRequest.updateMany({ where: { employeeId, status: { in: ['PENDING', 'APPROVED'] } }, data: { status: 'CANCELLED' } });
};

const leaveOrganisation = async (userId) => {
  const m = await prisma.companyEmployee.findFirst({ where: { userId, inviteStatus: 'ACTIVE', isActive: true } });
  if (!m) throw new OrgError('You are not listed under any organisation.', 'ORG_NOT_MEMBER', 404);
  if (m.role !== 'STAFF') throw new OrgError('You have a role in your organisation’s portal. Ask your organisation admin to change it first.', 'ORG_ROLE_HELD');
  if (await prisma.corporateTrip.count({ where: { employeeId: m.id, status: 'REQUESTED' } }) > 0) throw new OrgError('Finish or cancel your current company trip first.', 'ORG_TRIP_IN_PROGRESS');
  await prisma.companyEmployee.update({ where: { id: m.id }, data: { inviteStatus: 'REJECTED', isActive: false, reviewNote: 'Left the organisation', reviewedAt: new Date(), exitedAt: new Date(), exitReason: 'LEFT_BY_STAFF' } });
  await closeOpenItems(m.id);
  return { left: true };
};

// ── HR: approve / decline, delist, roles ─────────────────────────────────────

const loadEmployee = async (companyId, employeeId, include) => {
  const emp = await prisma.companyEmployee.findUnique({ where: { id: employeeId }, include });
  if (!emp || emp.companyId !== companyId) throw new OrgError('Staff member not found.', 'ORG_REQUEST_NOT_FOUND', 404);
  return emp;
};

const loadDepartment = async (companyId, departmentId) => {
  const d = await prisma.department.findUnique({ where: { id: departmentId } });
  if (!d || d.companyId !== companyId || !d.isActive) throw new OrgError('Choose a department from your list.', 'ORG_DEPARTMENT_INVALID');
  return d;
};

/**
 * HR decision on a join request. Approving requires a department (→ cost centre). The supervisor
 * defaults to the department head, or to the supervisor named in the staff directory.
 */
const reviewJoinRequest = async ({ companyId, employeeId, reviewerId, approve, departmentId, supervisorId, monthlyLimit, note }) => {
  const emp = await loadEmployee(companyId, employeeId, { company: { select: { id: true, name: true } } });
  if (emp.inviteStatus !== 'PENDING') throw new OrgError('This request has already been handled.', 'ORG_REQUEST_HANDLED');

  const data = { inviteStatus: approve ? 'ACTIVE' : 'REJECTED', isActive: approve, reviewedAt: new Date(), reviewedById: reviewerId, reviewNote: note ? String(note).slice(0, 300) : null, joinedAt: approve ? new Date() : null };

  if (approve) {
    await assertNoOtherMembership(emp.userId, companyId);
    const entry = emp.directoryEntryId ? await prisma.staffDirectoryEntry.findUnique({ where: { id: emp.directoryEntryId } }) : null;
    const deptId = departmentId || entry?.departmentId;
    if (!deptId) throw new OrgError('Choose the department this person belongs to.', 'ORG_DEPARTMENT_REQUIRED');
    const dept = await loadDepartment(companyId, deptId);
    data.departmentId = dept.id;

    let sup = supervisorId || dept.headEmployeeId || null;
    if (!supervisorId && entry?.supervisorStaffNumber) {
      const s = await prisma.companyEmployee.findFirst({ where: { companyId, staffNumber: normalizeStaffNumber(entry.supervisorStaffNumber), isActive: true, inviteStatus: 'ACTIVE' }, select: { id: true } });
      if (s) sup = s.id;
    }
    if (sup === emp.id) sup = null;
    if (sup) {
      const s = await prisma.companyEmployee.findUnique({ where: { id: sup }, select: { companyId: true, isActive: true } });
      if (!s || s.companyId !== companyId || !s.isActive) throw new OrgError('Choose a supervisor from your staff list.', 'ORG_SUPERVISOR_INVALID');
    }
    data.supervisorId = sup;
    if (monthlyLimit !== undefined && monthlyLimit !== null) data.monthlyLimit = Number(monthlyLimit);
    if (entry?.jobTitle && !emp.jobTitle) data.jobTitle = entry.jobTitle;
  }
  const updated = await prisma.companyEmployee.update({ where: { id: employeeId }, data });
  await notifySafe({
    userId: emp.userId,
    title: approve ? '✅ You’re listed' : '❌ Request declined',
    message: approve ? `${emp.company.name} approved your request. Choose “Company” as the payer when you book a ride or delivery.`
      : `${emp.company.name} declined your request.${data.reviewNote ? ` Note: ${data.reviewNote}` : ''}`,
    type: approve ? 'org_join_approved' : 'org_join_rejected', data: { companyId, employeeId },
  });
  return updated;
};

/** HR removes someone who has left. They stay a Runserv customer; their trip history stays. */
const delistEmployee = async ({ companyId, employeeId, byId, reason }) => {
  const emp = await loadEmployee(companyId, employeeId, { company: { select: { name: true } } });
  if (emp.inviteStatus !== 'ACTIVE' || !emp.isActive) throw new OrgError('This person is not currently listed.', 'ORG_NOT_MEMBER');
  if (emp.userId === byId) throw new OrgError('You cannot delist yourself.', 'ORG_SELF_DELIST');
  if (emp.role === 'ORG_ADMIN') {
    const admins = await prisma.companyEmployee.count({ where: { companyId, role: 'ORG_ADMIN', isActive: true, inviteStatus: 'ACTIVE' } });
    if (admins <= 1) throw new OrgError('You cannot delist the only organisation admin.', 'ORG_LAST_ADMIN');
  }
  const why = String(reason || 'RESIGNED').slice(0, 120);
  const now = new Date();
  await prisma.companyEmployee.update({ where: { id: emp.id }, data: { inviteStatus: 'DELISTED', isActive: false, exitedAt: now, exitReason: why, delistedById: byId } });
  // Un-supervise their reports and un-head their departments so nothing points at a person who left.
  await prisma.companyEmployee.updateMany({ where: { supervisorId: emp.id }, data: { supervisorId: null } });
  await prisma.department.updateMany({ where: { headEmployeeId: emp.id }, data: { headEmployeeId: null } });
  if (emp.directoryEntryId) {
    try { await prisma.staffDirectoryEntry.update({ where: { id: emp.directoryEntryId }, data: { status: 'EXITED', exitedAt: now } }); } catch (e) { logger.warn(`[Org] could not mark directory entry exited: ${e.message}`); }
  }
  await closeOpenItems(emp.id);
  await notifySafe({ userId: emp.userId, title: 'Company rides ended', message: `You are no longer listed under ${emp.company.name}, so company-paid rides are switched off. Your Runserv account is unchanged — you can keep riding and paying yourself.`, type: 'org_delisted', data: { companyId } });
  return { delisted: true };
};

const setRole = async ({ companyId, employeeId, role, byId }) => {
  if (!['ORG_ADMIN', 'HR', 'MANAGER', 'FINANCE', 'STAFF'].includes(role)) throw new OrgError('Unknown role.', 'ORG_ROLE_INVALID');
  const emp = await loadEmployee(companyId, employeeId);
  if (emp.inviteStatus !== 'ACTIVE' || !emp.isActive) throw new OrgError('Only listed staff can be given a role.', 'ORG_NOT_MEMBER');
  if (emp.role === 'ORG_ADMIN' && role !== 'ORG_ADMIN') {
    const admins = await prisma.companyEmployee.count({ where: { companyId, role: 'ORG_ADMIN', isActive: true, inviteStatus: 'ACTIVE' } });
    if (admins <= 1) throw new OrgError('There must be at least one organisation admin.', 'ORG_LAST_ADMIN');
  }
  const updated = await prisma.companyEmployee.update({ where: { id: emp.id }, data: { role } });
  if (role !== 'STAFF') await notifySafe({ userId: emp.userId, title: 'You now have portal access', message: `You were given the ${role.replace('_', ' ').toLowerCase()} role. Sign in to your organisation’s dashboard with your Runserv email.`, type: 'org_role_changed', data: { companyId, role } });
  return updated;
};

// ── Spend / usage ────────────────────────────────────────────────────────────

const monthRange = (now, tz) => { const period = cal.periodOf(now, tz); return { period, ...cal.periodBounds(period, tz) }; };
const COUNTED = ['REQUESTED', 'COMPLETED'];

const spendFor = async (where, now, tz) => {
  const { start, end } = monthRange(now, cal.safeTz(tz));
  const agg = await prisma.corporateTrip.aggregate({ where: { ...where, status: { in: COUNTED }, tripAt: { gte: start, lt: end } }, _sum: { fare: true, distanceKm: true }, _count: { _all: true } });
  return { spend: agg._sum?.fare ?? 0, distanceKm: agg._sum?.distanceKm ?? 0, trips: agg._count?._all ?? 0 };
};
const getEmployeeMonthUsage   = (emp, tz, now = new Date()) => spendFor({ employeeId: emp.id }, now, tz);
const getDepartmentMonthUsage = (deptId, tz, now = new Date()) => spendFor({ departmentId: deptId }, now, tz);
const getCompanyMonthUsage    = (company, now = new Date()) => spendFor({ companyId: company.id }, now, company.timezone);

const findBlockingInvoice = (companyId, now = new Date()) =>
  prisma.companyInvoice.findFirst({
    where: { companyId, status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] }, dueDate: { lt: new Date(now.getTime() - OVERDUE_BLOCK_AFTER_DAYS * DAY_MS) } },
    orderBy: { dueDate: 'asc' }, select: { id: true, invoiceNumber: true },
  });

const getActiveMembership = (userId) =>
  prisma.companyEmployee.findFirst({ where: { userId, isActive: true, inviteStatus: 'ACTIVE' }, include: { company: true, department: true } });

// ── Approvals ────────────────────────────────────────────────────────────────

/** The approval threshold that applies to this person (department overrides company). null = never. */
const approvalThresholdFor = (company, dept) => dept?.approvalThreshold ?? company.approvalThreshold ?? null;
const tripCapFor = (company, dept) => dept?.maxTripAmount ?? company.maxTripAmount ?? null;
const needsApproval = (company, dept, member, fare) => {
  const t = approvalThresholdFor(company, dept);
  return t != null && fare > t && member.role !== 'ORG_ADMIN';
};

/** Who should decide: the person's supervisor (if they can approve), else the department head, else HR/admin. */
const resolveApprovers = async (member) => {
  const portal = ['MANAGER', 'ORG_ADMIN', 'HR'];
  const out = [];
  if (member.supervisorId) { const s = await prisma.companyEmployee.findUnique({ where: { id: member.supervisorId }, select: { id: true, userId: true, role: true, isActive: true } }); if (s?.isActive && portal.includes(s.role)) out.push(s); }
  if (!out.length && member.departmentId) {
    const d = await prisma.department.findUnique({ where: { id: member.departmentId }, include: { head: { select: { id: true, userId: true, role: true, isActive: true } } } });
    if (d?.head?.isActive && d.head.id !== member.id) out.push(d.head);
  }
  if (!out.length) out.push(...await prisma.companyEmployee.findMany({ where: { companyId: member.companyId, isActive: true, inviteStatus: 'ACTIVE', role: { in: ['ORG_ADMIN', 'HR'] }, id: { not: member.id } }, select: { id: true, userId: true, role: true }, take: 5 }));
  return out;
};

const requestApproval = async ({ userId, serviceType = 'RIDE', pickupAddress, dropoffAddress, estimatedFare, distanceKm, purpose, purposeCategory, now = new Date() }) => {
  const member = await getActiveMembership(userId);
  if (!member) throw new OrgError('You are not listed under an organisation.', 'ORG_NOT_MEMBER', 403);
  const fare = Number(estimatedFare) || 0;
  if (!needsApproval(member.company, member.department, member, fare)) throw new OrgError('This trip does not need approval.', 'ORG_APPROVAL_NOT_NEEDED');
  const open = await prisma.approvalRequest.findFirst({ where: { employeeId: member.id, status: 'PENDING', expiresAt: { gt: now } } });
  if (open) return open;

  const approvers = await resolveApprovers(member);
  const req = await prisma.approvalRequest.create({
    data: {
      companyId: member.companyId, employeeId: member.id, departmentId: member.departmentId, approverEmployeeId: approvers[0]?.id ?? null,
      serviceType, pickupAddress: String(pickupAddress || '').slice(0, 300), dropoffAddress: String(dropoffAddress || '').slice(0, 300),
      estimatedFare: fare, distanceKm: distanceKm ?? null, purpose: purpose ? String(purpose).slice(0, 300) : null,
      purposeCategory: TRIP_PURPOSES.includes(String(purposeCategory ?? '').toUpperCase()) ? String(purposeCategory).toUpperCase() : null,
      reason: 'OVER_THRESHOLD', expiresAt: new Date(now.getTime() + APPROVAL_WINDOW_HOURS * HOUR_MS),
    },
  });
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } });
  for (const a of approvers) await notifySafe({ userId: a.userId, title: '🕒 Trip needs your approval', message: `${userLabel(u)} wants a ${serviceType.toLowerCase()} costing ${formatMoney(fare, member.company.currency)}: ${req.pickupAddress} → ${req.dropoffAddress}.`, type: 'org_approval_request', data: { approvalId: req.id, companyId: member.companyId } });
  return req;
};

const canDecide = (decider, req, emp) => {
  if (['ORG_ADMIN', 'HR'].includes(decider.role)) return true;
  if (decider.role !== 'MANAGER') return false;
  return req.approverEmployeeId === decider.id || emp.supervisorId === decider.id || (decider.headOf ?? []).some((d) => d.id === emp.departmentId);
};

const decideApproval = async ({ decider, approvalId, approve, note, now = new Date() }) => {
  const req = await prisma.approvalRequest.findUnique({ where: { id: approvalId }, include: { employee: { select: { userId: true, supervisorId: true, departmentId: true } } } });
  if (!req || req.companyId !== decider.companyId) throw new OrgError('Approval request not found.', 'ORG_REQUEST_NOT_FOUND', 404);
  if (req.status !== 'PENDING') throw new OrgError('This request has already been handled.', 'ORG_REQUEST_HANDLED');
  if (req.expiresAt <= now) throw new OrgError('This request has expired.', 'ORG_REQUEST_EXPIRED');
  if (!canDecide(decider, req, req.employee)) throw new AppError('You cannot decide this request.', 403);
  if (decider.id === req.employeeId) throw new OrgError('You cannot approve your own trip.', 'ORG_SELF_APPROVAL');

  const updated = await prisma.approvalRequest.update({
    where: { id: approvalId },
    data: { status: approve ? 'APPROVED' : 'REJECTED', decidedById: decider.id, decidedAt: now, decisionNote: note ? String(note).slice(0, 300) : null,
      ...(approve && { expiresAt: new Date(now.getTime() + APPROVAL_USE_HOURS * HOUR_MS) }) },
  });
  await notifySafe({
    userId: req.employee.userId,
    title: approve ? '✅ Trip approved' : '❌ Trip not approved',
    message: approve ? `Your trip to ${req.dropoffAddress} was approved. Book it within ${APPROVAL_USE_HOURS} hours.` : `Your trip to ${req.dropoffAddress} was not approved.${note ? ` Note: ${String(note).slice(0, 120)}` : ''}`,
    type: 'org_approval_decision', data: { approvalId, approved: approve },
  });
  return updated;
};

/** Check an approval pass is valid for this booking. Throws otherwise. */
const validateApprovalPass = async ({ approvalId, member, fare, serviceType, now }) => {
  const a = await prisma.approvalRequest.findUnique({ where: { id: approvalId } });
  if (!a || a.employeeId !== member.id) throw new OrgError('That approval does not belong to you.', 'ORG_APPROVAL_INVALID', 403);
  if (a.status !== 'APPROVED') throw new OrgError(a.status === 'USED' ? 'That approval has already been used.' : 'That trip has not been approved.', 'ORG_APPROVAL_INVALID');
  if (a.expiresAt <= now) throw new OrgError('That approval has expired. Please request a new one.', 'ORG_APPROVAL_EXPIRED');
  if (a.serviceType !== serviceType) throw new OrgError('That approval is for a different kind of trip.', 'ORG_APPROVAL_INVALID');
  if (fare > a.estimatedFare * 1.1 + 1) throw new OrgError('The fare is now higher than the amount your manager approved. Please request approval again.', 'ORG_APPROVAL_INVALID');
  return a;
};

// ── Booking eligibility ──────────────────────────────────────────────────────

/**
 * Everything that must be true before a trip can go on the company's account. Throws OrgError
 * (with a code the app reacts to) on the first failed rule; called before anything is created.
 */
const evaluateBooking = async ({ userId, estimatedFare, serviceType = 'RIDE', purpose, purposeCategory, approvalId, now = new Date() }) => {
  const employee = await getActiveMembership(userId);
  if (!employee) throw new OrgError('You are not listed under an organisation. Send a join request from your profile, or choose to pay yourself.', 'ORG_NOT_MEMBER', 403);
  const { company, department } = employee;
  if (company.status !== 'ACTIVE') throw new OrgError(`${company.name}'s account is not active right now. Please pay yourself or contact your company admin.`, 'ORG_SUSPENDED', 403);
  const tz = cal.safeTz(company.timezone);
  const fare = Number(estimatedFare) || 0;

  if (serviceType === 'DELIVERY' && !company.allowDeliveries) throw new OrgError('Your organisation has not enabled company-paid deliveries.', 'ORG_DELIVERY_DISABLED', 403);
  if (await findBlockingInvoice(company.id, now)) throw new OrgError('Your organisation has an overdue Runserv invoice, so company rides are paused. Please pay yourself or ask your finance team to settle it.', 'ORG_OVERDUE', 403);

  // Day policy
  const localDate = cal.localDateString(now, tz);
  const weekday = cal.weekdayOfLocalDate(localDate);
  const approval = (weekday === 0 || weekday === 6)
    ? await prisma.weekendRideRequest.findFirst({ where: { companyId: company.id, employeeId: employee.id, status: 'APPROVED', requestedDate: dateOnly(localDate) }, select: { id: true } })
    : null;
  const day = cal.evaluateDayPolicy({ policy: company.weekendPolicy, weekday, hasApproval: Boolean(approval) });
  if (!day.allowed) throw new OrgError(day.reason, day.code, 403);
  if (employee.restrictToBusinessHours && !cal.isWithinBusinessHours(now, tz)) throw new OrgError('Company rides for your account are limited to 7:00 am – 8:00 pm.', 'ORG_OUTSIDE_HOURS', 403);

  // Purpose
  const cleanPurpose = purpose ? String(purpose).trim().slice(0, 300) : '';
  if (requirePurpose(company, employee) && cleanPurpose.length < 3) throw new OrgError('Tell your company why you are taking this trip (e.g. "Client visit — Zenith Bank, VI").', 'ORG_PURPOSE_REQUIRED');
  const category = TRIP_PURPOSES.includes(String(purposeCategory ?? '').toUpperCase()) ? String(purposeCategory).toUpperCase() : null;

  // Hard per-trip cap
  const cap = tripCapFor(company, department);
  if (cap != null && fare > cap) throw new OrgError(`Company trips are capped at ${formatMoney(cap, company.currency)} each. This one is ${formatMoney(fare, company.currency)} — you can pay for it yourself.`, 'ORG_TRIP_CAP', 403);

  // Personal allowance
  if (employee.monthlyLimit > 0) {
    const mine = await getEmployeeMonthUsage(employee, tz, now);
    if (mine.spend + fare > employee.monthlyLimit) {
      throw new OrgError(`This trip would go over your monthly company allowance (${formatMoney(employee.monthlyLimit, company.currency)}; ${formatMoney(Math.max(0, employee.monthlyLimit - mine.spend), company.currency)} left). You can pay for it yourself.`, 'ORG_STAFF_LIMIT', 403);
    }
  }
  // Department budget
  if (department?.monthlyBudget != null) {
    const d = await getDepartmentMonthUsage(department.id, tz, now);
    if (d.spend + fare > department.monthlyBudget) throw new OrgError(`The ${department.name} department has used its monthly transport budget. Please pay yourself or speak to your manager.`, 'ORG_DEPT_BUDGET', 403);
  }

  // Manager approval
  let usedApproval = null;
  if (needsApproval(company, department, employee, fare)) {
    if (!approvalId) {
      const e = new OrgError(`Trips over ${formatMoney(approvalThresholdFor(company, department), company.currency)} need your manager's approval first.`, 'ORG_APPROVAL_REQUIRED', 403);
      e.details = { threshold: approvalThresholdFor(company, department), fare };
      throw e;
    }
    usedApproval = await validateApprovalPass({ approvalId, member: employee, fare, serviceType, now });
  }

  // Money: wallet / credit
  await wallet.assertCanFund(company, fare);

  return {
    employee, company, department, tz, localDate,
    weekendTrip: day.weekend, weekendRequestId: approval?.id ?? null,
    purpose: cleanPurpose || null, purposeCategory: category,
    approvalId: usedApproval?.id ?? null,
  };
};

// ── Trip records ─────────────────────────────────────────────────────────────

const orgBookingFields = (ev) => ({ payerType: 'ORGANIZATION', companyId: ev.company.id, isCorporate: true });

const createTripRecord = async (tx, { evaluation: ev, rideId = null, deliveryId = null, serviceType, fare, distanceKm, currency }) => {
  const split = cal.splitFare(fare, effectiveRate(ev.company));
  if (ev.approvalId) await tx.approvalRequest.update({ where: { id: ev.approvalId }, data: { status: 'USED' } });
  return tx.corporateTrip.create({
    data: {
      rideId, deliveryId, serviceType, companyId: ev.company.id, employeeId: ev.employee.id,
      departmentId: ev.department?.id ?? null, costCenter: ev.department?.costCenter ?? null, supervisorEmployeeId: ev.employee.supervisorId ?? null,
      status: 'REQUESTED', purpose: ev.purpose, purposeCategory: ev.purposeCategory,
      fare, currency: currency || ev.company.currency, distanceKm: distanceKm ?? null,
      commissionAmount: split.platformFee, driverEarnings: split.driverEarnings,
      weekendTrip: ev.weekendTrip, weekendRequestId: ev.weekendRequestId, approvalRequestId: ev.approvalId, tripAt: new Date(),
    },
  });
};

const splitForCompany = async (companyId, fare) => {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, commissionRate: true, currency: true } });
  const rate = effectiveRate(company);
  return { company, rate, ...cal.splitFare(fare, rate) };
};

/**
 * Trip completed: lock in the final fare, fund it (wallet and/or credit) and pay the driver their
 * share of whatever the wallet covered right away. The rest is paid when the invoice is paid.
 */
const finalizeTrip = async ({ rideId = null, deliveryId = null, fare, distanceKm, earnerUserId, completedAt = new Date() }) => {
  const trip = await prisma.corporateTrip.findFirst({ where: rideId ? { rideId } : { deliveryId }, include: { company: true } });
  if (!trip || trip.status === 'COMPLETED') return trip;
  const split = cal.splitFare(fare, effectiveRate(trip.company));
  const plan = wallet.planFunding(trip.company, fare);

  const updated = await prisma.corporateTrip.update({
    where: { id: trip.id },
    data: {
      status: 'COMPLETED', fare, distanceKm: distanceKm ?? trip.distanceKm,
      commissionAmount: split.platformFee, driverEarnings: split.driverEarnings, earnerUserId,
      walletPaid: plan.walletPaid, creditAmount: plan.creditAmount, completedAt, tripAt: completedAt,
    },
  });

  if (plan.walletPaid > 0) {
    await wallet.chargeTrip({ companyId: trip.companyId, tripId: trip.id, amount: plan.walletPaid, description: `${trip.serviceType === 'DELIVERY' ? 'Delivery' : 'Ride'} ${completedAt.toISOString().slice(0, 10)}` });
    const driverNow = cal.round2(split.driverEarnings * (plan.walletPaid / fare));
    if (driverNow > 0 && earnerUserId) await payDriverNow({ userId: earnerUserId, tripId: trip.id, amount: driverNow, company: trip.company });
  }
  const full = plan.creditAmount === 0;
  if (full) {
    const model = rideId ? { rideId } : { deliveryId };
    await prisma.payment.updateMany({ where: { ...model, method: 'CORPORATE' }, data: { status: 'COMPLETED' } });
    await prisma.corporateTrip.update({ where: { id: trip.id }, data: { payoutStatus: 'PAID' } });
  }
  return updated;
};

/** Credit a driver's wallet for the wallet-funded part of a trip (idempotent per trip). */
const payDriverNow = async ({ userId, tripId, amount, company }) => {
  const { ensureWallet } = require('../utils/walletHelpers');
  const w = await ensureWallet(userId);
  const reference = `ORGTRIP-${tripId}`;
  try {
    await prisma.$transaction([
      ...require('./walletOps').creditOps(prisma, { walletId: w.id, currency: w.currency || company.currency, amount, refType: 'ORG_TRIP_PAYOUT', refId: reference, memo: `${company.name} trip`, idempotencyKey: `ORG_TRIP_PAYOUT:${reference}` }),
      prisma.walletTransaction.create({ data: { walletId: w.id, type: 'CREDIT', amount, status: 'COMPLETED', reference, description: `${company.name} trip — paid from company wallet` } }),
      prisma.corporateTrip.update({ where: { id: tripId }, data: { driverPaidAmount: amount } }),
    ]);
    await notifySafe({ userId, title: '💰 Company trip paid', message: `${formatMoney(amount, company.currency)} from ${company.name} was added to your wallet.`, type: 'org_payout_paid', data: { tripId } });
  } catch (e) { if (e?.code !== 'P2002') logger.error(`[Org] driver instant pay failed for trip ${tripId}: ${e.message}`); }
};

const cancelTrip = ({ rideId = null, deliveryId = null }) =>
  prisma.corporateTrip.updateMany({ where: { ...(rideId ? { rideId } : { deliveryId }), status: 'REQUESTED' }, data: { status: 'CANCELLED' } });

// ── Weekend requests ─────────────────────────────────────────────────────────

const createWeekendRequest = async ({ userId, date, reason, now = new Date() }) => {
  const employee = await getActiveMembership(userId);
  if (!employee) throw new OrgError('You are not listed under an organisation.', 'ORG_NOT_MEMBER', 403);
  const { company } = employee; const tz = cal.safeTz(company.timezone);
  const why = String(reason ?? '').trim();
  if (why.length < 5) throw new OrgError('Tell your company why you need to ride that day.', 'ORG_REASON_REQUIRED');
  const check = cal.canRequestWeekendDate({ policy: company.weekendPolicy, localDate: date, todayLocal: cal.localDateString(now, tz) });
  if (!check.ok) throw new OrgError(check.reason, 'ORG_WEEKEND_REQUEST_INVALID');
  if (await prisma.weekendRideRequest.findFirst({ where: { employeeId: employee.id, requestedDate: dateOnly(date), status: { in: ['PENDING', 'APPROVED'] } } })) throw new OrgError('You already have a request for that day.', 'ORG_WEEKEND_REQUEST_EXISTS');

  const request = await prisma.weekendRideRequest.create({ data: { companyId: company.id, employeeId: employee.id, requestedDate: dateOnly(date), reason: why } });
  const [u, approvers] = await Promise.all([prisma.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } }), resolveApprovers(employee)]);
  for (const a of approvers) await notifySafe({ userId: a.userId, title: '📅 Weekend ride request', message: `${userLabel(u)} asked to use company rides on ${cal.WEEKDAY_NAMES[check.weekday]} ${date}: "${why.slice(0, 120)}"`, type: 'org_weekend_request', data: { requestId: request.id, companyId: company.id } });
  return request;
};

const cancelWeekendRequest = async ({ userId, requestId }) => {
  const r = await prisma.weekendRideRequest.findUnique({ where: { id: requestId }, include: { employee: { select: { userId: true } } } });
  if (!r || r.employee.userId !== userId) throw new OrgError('Request not found.', 'ORG_REQUEST_NOT_FOUND', 404);
  if (!['PENDING', 'APPROVED'].includes(r.status)) throw new OrgError('This request can no longer be cancelled.', 'ORG_REQUEST_HANDLED');
  return prisma.weekendRideRequest.update({ where: { id: requestId }, data: { status: 'CANCELLED' } });
};

const reviewWeekendRequest = async ({ decider, requestId, approve, note }) => {
  const r = await prisma.weekendRideRequest.findUnique({ where: { id: requestId }, include: { company: { select: { name: true } }, employee: { select: { userId: true, supervisorId: true, departmentId: true } } } });
  if (!r || r.companyId !== decider.companyId) throw new OrgError('Request not found.', 'ORG_REQUEST_NOT_FOUND', 404);
  if (r.status !== 'PENDING') throw new OrgError('This request has already been handled.', 'ORG_REQUEST_HANDLED');
  if (!canDecide(decider, { approverEmployeeId: null }, r.employee)) throw new AppError('You cannot decide this request.', 403);
  const updated = await prisma.weekendRideRequest.update({ where: { id: requestId }, data: { status: approve ? 'APPROVED' : 'REJECTED', reviewedById: decider.id, reviewedAt: new Date(), reviewNote: note ? String(note).slice(0, 300) : null } });
  const dateStr = r.requestedDate.toISOString().slice(0, 10);
  await notifySafe({ userId: r.employee.userId, title: approve ? '✅ Weekend ride approved' : '❌ Weekend ride declined', message: approve ? `${r.company.name} approved company rides for you on ${dateStr}.` : `${r.company.name} declined your weekend request for ${dateStr}.${note ? ` Note: ${String(note).slice(0, 120)}` : ''}`, type: 'org_weekend_decision', data: { requestId, approved: approve } });
  return updated;
};

// ── What the staff app shows ─────────────────────────────────────────────────

const getMyOrganisation = async (userId, now = new Date()) => {
  const m = await prisma.companyEmployee.findFirst({
    where: { userId }, orderBy: { updatedAt: 'desc' },
    include: { company: true, department: true, supervisor: { select: { user: { select: { firstName: true, lastName: true } } } } },
  });
  if (!m) return { status: 'NONE' };
  const { company } = m;
  const org = { id: company.id, name: company.brandName || company.name, orgCode: company.orgCode, logoUrl: company.logoUrl, brandColor: company.brandColor };
  const base = { organisation: org, staffNumber: m.staffNumber, jobTitle: m.jobTitle, requestedAt: m.requestedAt, reviewNote: m.reviewNote, joinSource: m.joinSource, employeeId: m.id, claimedDepartment: m.claimedDepartment };

  if (m.inviteStatus === 'PENDING') return { status: 'PENDING', ...base };
  if (m.inviteStatus === 'DELISTED') return { status: 'DELISTED', ...base, exitedAt: m.exitedAt };
  if (m.inviteStatus === 'REJECTED' || !m.isActive) return { status: 'REJECTED', ...base };

  const tz = cal.safeTz(company.timezone);
  const [usage, blocking, weekendRequests, approvals] = await Promise.all([
    getEmployeeMonthUsage(m, tz, now), findBlockingInvoice(company.id, now),
    prisma.weekendRideRequest.findMany({ where: { employeeId: m.id, requestedDate: { gte: dateOnly(cal.localDateString(now, tz)) }, status: { in: ['PENDING', 'APPROVED'] } }, orderBy: { requestedDate: 'asc' }, take: 10 }),
    prisma.approvalRequest.findMany({ where: { employeeId: m.id, status: { in: ['PENDING', 'APPROVED'] }, expiresAt: { gt: now } }, orderBy: { createdAt: 'desc' }, take: 5 }),
  ]);
  const today = cal.localDateString(now, tz); const weekday = cal.weekdayOfLocalDate(today);
  const dayNow = cal.evaluateDayPolicy({ policy: company.weekendPolicy, weekday, hasApproval: weekendRequests.some((r) => r.status === 'APPROVED' && r.requestedDate.toISOString().slice(0, 10) === today) });

  let blockedCode = null; let blockedReason = null;
  if (company.status !== 'ACTIVE') { blockedCode = 'ORG_SUSPENDED'; blockedReason = `${company.name}'s account is not active right now.`; }
  else if (blocking) { blockedCode = 'ORG_OVERDUE'; blockedReason = 'Your organisation has an overdue invoice, so company rides are paused.'; }
  else if (!dayNow.allowed) { blockedCode = dayNow.code; blockedReason = dayNow.reason; }

  const limit = m.monthlyLimit > 0 ? m.monthlyLimit : null;
  const sup = m.supervisor?.user;
  return {
    status: 'ACTIVE', ...base,
    role: m.role, hasPortal: m.role !== 'STAFF', isCompanyRep: m.role === 'ORG_ADMIN',
    department: m.department?.name ?? null, costCenter: m.department?.costCenter ?? null,
    supervisor: sup ? `${sup.firstName} ${sup.lastName}` : null,
    currency: company.currency, period: cal.periodOf(now, tz),
    usage: { trips: usage.trips, distanceKm: cal.round2(usage.distanceKm), spend: usage.spend },
    monthlyLimit: limit, remaining: limit === null ? null : Math.max(0, limit - usage.spend),
    approvalThreshold: approvalThresholdFor(company, m.department),
    requireTripPurpose: requirePurpose(company, m), allowDeliveries: company.allowDeliveries, weekendPolicy: company.weekendPolicy,
    weekendRequests: weekendRequests.map((r) => ({ id: r.id, date: r.requestedDate.toISOString().slice(0, 10), status: r.status, reason: r.reason })),
    approvals: approvals.map((a) => ({ id: a.id, status: a.status, dropoff: a.dropoffAddress, fare: a.estimatedFare, expiresAt: a.expiresAt })),
    canBookNow: !blockedCode, blockedCode, blockedReason, purposeOptions: TRIP_PURPOSES,
  };
};

module.exports = {
  CORPORATE_COMMISSION, TRIP_PURPOSES, OrgError,
  generateOrgCode, normalizeOrgCode, normalizeStaffNumber, namesMatch,
  ensureOwnerMembership, applyForOrganisation, lookupOrganisation, assertNoOtherMembership,
  requestToJoin, cancelJoinRequest, leaveOrganisation, reviewJoinRequest, delistEmployee, setRole,
  getActiveMembership, getEmployeeMonthUsage, getDepartmentMonthUsage, getCompanyMonthUsage, findBlockingInvoice,
  approvalThresholdFor, tripCapFor, needsApproval, resolveApprovers, requestApproval, decideApproval, canDecide,
  evaluateBooking, orgBookingFields, createTripRecord, splitForCompany, finalizeTrip, cancelTrip,
  createWeekendRequest, cancelWeekendRequest, reviewWeekendRequest, getMyOrganisation,
};
