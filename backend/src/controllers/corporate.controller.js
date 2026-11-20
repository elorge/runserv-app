// backend/src/controllers/corporate.controller.js
//
// Runserv Business API, mounted at /api/corporate.
//   Portal (web dashboard) — role-gated: ORG_ADMIN / HR / FINANCE / MANAGER; managers only ever see
//                            their own department(s) and direct reports.
//   Staff (mobile)         — find the organisation, request to be listed, usage, weekend requests,
//                            approval requests.
//   Drivers / partners     — earnings from organisation trips.
'use strict';

const crypto = require('crypto');
const { validationResult } = require('express-validator');
const { AppError } = require('../middleware/errorHandler');
const prisma = require('../lib/prisma');
const corp = require('../services/corporate.service');
const dir = require('../services/orgDirectory.service');
const wallet = require('../services/orgWallet.service');
const billing = require('../services/orgBilling.service');
const access = require('../services/orgAccess');
const payments = require('../services/payment.service');
const cal = require('../utils/orgCalendar');

const bad = (req, res) => {
  const e = validationResult(req);
  if (e.isEmpty()) return false;
  res.status(400).json({ success: false, message: e.array()[0].msg || 'Invalid input', errors: e.array() });
  return true;
};
const pageArgs = (q, def = 20) => {
  const limit = Math.min(Math.max(parseInt(q.limit) || def, 1), 200);
  const page = Math.max(parseInt(q.page) || 1, 1);
  return { limit, page, skip: (page - 1) * limit };
};
const pagination = (total, page, limit) => ({ total, page, pages: Math.ceil(total / limit) });
const fullName = (u) => `${u?.firstName ?? ''} ${u?.lastName ?? ''}`.trim();
const r2 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? cal.round2(v) : v]));

// ── Portal gate ──────────────────────────────────────────────────────────────
/** The signed-in user must have an active portal role in an organisation. */
exports.loadMember = async (req, res, next) => {
  const member = await access.getPortalMembership(req.user.id);
  if (!member) throw new AppError('This account has no organisation dashboard access.', 404);
  req.member = member; req.company = member.company;
  next();
};
/** Route guard: `exports.need('manageStaff')`. */
exports.need = (action) => (req, _res, next) => { access.assertCan(req.member, action); next(); };

// ── View models ──────────────────────────────────────────────────────────────
const TRIP_INCLUDE = {
  employee: { select: { id: true, staffNumber: true, supervisorId: true, department: { select: { name: true } }, user: { select: { firstName: true, lastName: true, phone: true } } } },
  ride: { select: { pickupAddress: true, dropoffAddress: true, driver: { select: { firstName: true, driverProfile: { select: { vehiclePlate: true } } } } } },
  delivery: { select: { pickupAddress: true, dropoffAddress: true, partner: { select: { firstName: true, deliveryProfile: { select: { vehiclePlate: true } } } } } },
  invoice: { select: { invoiceNumber: true, period: true, status: true } },
};

const tripDto = (t) => {
  const leg = t.ride ?? t.delivery ?? {};
  const person = t.ride?.driver ?? t.delivery?.partner ?? null;
  const plate = t.ride?.driver?.driverProfile?.vehiclePlate ?? t.delivery?.partner?.deliveryProfile?.vehiclePlate ?? null;
  const km = t.distanceKm ?? null;
  return {
    id: t.id, type: t.serviceType, status: t.status, date: t.tripAt,
    employee: { id: t.employee?.id, name: fullName(t.employee?.user), staffNumber: t.employee?.staffNumber, department: t.employee?.department?.name ?? null, phone: t.employee?.user?.phone },
    costCenter: t.costCenter, departmentId: t.departmentId,
    from: leg.pickupAddress ?? null, to: leg.dropoffAddress ?? null, distanceKm: km,
    fare: t.fare, currency: t.currency, costPerKm: km && km > 0 ? cal.round2(t.fare / km) : null,
    funding: { wallet: t.walletPaid, credit: t.creditAmount },
    purposeCategory: t.purposeCategory, purpose: t.purpose, weekendTrip: t.weekendTrip,
    driver: person ? { firstName: person.firstName, plate } : null,
    audit: { status: t.auditStatus, note: t.auditNote, at: t.auditedAt },
    invoice: t.invoice ? { number: t.invoice.invoiceNumber, period: t.invoice.period, status: t.invoice.status } : null,
  };
};

const buildTripWhere = (member, company, q) => {
  const tz = cal.safeTz(company.timezone);
  const where = { companyId: company.id, status: q.status || 'COMPLETED', ...access.tripScope(member) };
  if (q.status === 'ALL') delete where.status;
  if (q.employeeId) where.employeeId = q.employeeId;
  if (q.departmentId) where.departmentId = q.departmentId;
  if (q.costCenter) where.costCenter = { equals: q.costCenter, mode: 'insensitive' };
  if (q.type === 'RIDE' || q.type === 'DELIVERY') where.serviceType = q.type;
  if (q.auditStatus) where.auditStatus = q.auditStatus;
  if (q.weekend === 'true') where.weekendTrip = true;
  if (q.period && cal.isValidPeriod(q.period)) { const { start, end } = cal.periodBounds(q.period, tz); where.tripAt = { gte: start, lt: end }; }
  else if (q.from || q.to) { where.tripAt = {}; if (q.from) where.tripAt.gte = new Date(q.from); if (q.to) where.tripAt.lte = new Date(q.to); }
  return where;
};

const invoiceDto = (i) => ({
  id: i.id, number: i.invoiceNumber, period: i.period, status: i.status, tripCount: i.tripCount, distanceKm: i.totalDistanceKm,
  tripsAmount: i.tripsAmount, subscription: i.subscriptionAmount, total: i.subtotal, paid: i.amountPaid, outstanding: cal.round2(i.subtotal - i.amountPaid),
  currency: i.currency, issuedAt: i.issuedAt, dueDate: i.dueDate, paidAt: i.paidAt,
});

// ── Registration (application) ───────────────────────────────────────────────
exports.applyForOrganisation = async (req, res) => {
  if (bad(req, res)) return;
  const { name, rcNumber, email, phone, address, billingEmail } = req.body;
  const company = await corp.applyForOrganisation({ ownerUserId: req.user.id, name, rcNumber, email, phone, address, billingEmail });
  res.status(201).json({ success: true, message: 'Application received. Runserv will review it and get back to you.', data: { company: { id: company.id, name: company.name, status: company.status } } });
};

// ── Portal: profile, settings, branding ──────────────────────────────────────
exports.getPortalProfile = async (req, res) => {
  const c = req.company; const m = req.member;
  const canStaff = access.can(m, 'manageStaff');
  const [pendingRequests, pendingApprovals, pendingWeekend] = await Promise.all([
    canStaff ? prisma.companyEmployee.count({ where: { companyId: c.id, inviteStatus: 'PENDING', joinSource: 'STAFF_REQUEST', isActive: true } }) : 0,
    access.can(m, 'approveTrips') ? prisma.approvalRequest.count({ where: { companyId: c.id, status: 'PENDING', expiresAt: { gt: new Date() }, ...(canStaff ? {} : { employee: access.staffScope(m) }) } }) : 0,
    access.can(m, 'approveTrips') ? prisma.weekendRideRequest.count({ where: { companyId: c.id, status: 'PENDING', ...(canStaff ? {} : { employee: access.staffScope(m) }) } }) : 0,
  ]);
  const seeBilling = access.can(m, 'seeBilling');
  const company = {
    id: c.id, name: c.name, brandName: c.brandName, orgCode: c.orgCode, status: c.status, currency: c.currency, timezone: c.timezone,
    logoUrl: c.logoUrl, brandColor: c.brandColor, brandAccent: c.brandAccent, tagline: c.tagline, supportEmail: c.supportEmail,
    weekendPolicy: c.weekendPolicy, requireTripPurpose: c.requireTripPurpose, allowDeliveries: c.allowDeliveries,
    maxTripAmount: c.maxTripAmount, approvalThreshold: c.approvalThreshold,
    email: c.email, phone: c.phone, address: c.address, billingEmail: c.billingEmail,
    ...(seeBilling && { billingMode: c.billingMode, creditLimit: c.creditLimit, paymentTermsDays: c.paymentTermsDays, lowBalanceThreshold: c.lowBalanceThreshold, verificationStatus: c.verificationStatus }),
  };
  const permissions = Object.fromEntries(Object.keys(access.CAN).map((k) => [k, access.can(m, k)]));
  res.json({ success: true, data: { company, member: { id: m.id, role: m.role, name: fullName(req.user) }, permissions, pendingRequests, pendingApprovals, pendingWeekend } });
};

exports.updateSettings = async (req, res) => {
  if (bad(req, res)) return;
  const b = req.body;
  const num = (v) => (v === '' || v === null ? null : Number(v));
  const data = {
    ...(b.weekendPolicy && { weekendPolicy: b.weekendPolicy }),
    ...(b.requireTripPurpose !== undefined && { requireTripPurpose: b.requireTripPurpose }),
    ...(b.allowDeliveries !== undefined && { allowDeliveries: b.allowDeliveries }),
    ...('maxTripAmount' in b && { maxTripAmount: num(b.maxTripAmount) }),
    ...('approvalThreshold' in b && { approvalThreshold: num(b.approvalThreshold) }),
    ...(b.lowBalanceThreshold !== undefined && { lowBalanceThreshold: Number(b.lowBalanceThreshold) || 0 }),
    ...(b.phone && { phone: b.phone }), ...('address' in b && { address: b.address }), ...('billingEmail' in b && { billingEmail: b.billingEmail || null }),
  };
  const updated = await prisma.company.update({ where: { id: req.company.id }, data });
  res.json({ success: true, message: 'Settings saved', data: { company: updated } });
};

/** White label: how the portal (and the company's staff in the app) see the organisation. */
exports.updateBranding = async (req, res) => {
  if (bad(req, res)) return;
  const b = req.body;
  const data = {};
  for (const k of ['brandName', 'tagline', 'supportEmail', 'logoUrl']) if (k in b) data[k] = b[k] ? String(b[k]).trim() : null;
  for (const k of ['brandColor', 'brandAccent']) if (k in b) data[k] = b[k] ? String(b[k]).toUpperCase() : null;
  const updated = await prisma.company.update({ where: { id: req.company.id }, data });
  res.json({ success: true, message: 'Branding saved', data: { company: updated } });
};

// ── Portal: dashboard ────────────────────────────────────────────────────────
exports.getDashboard = async (req, res) => {
  const c = req.company; const m = req.member; const tz = cal.safeTz(c.timezone);
  const period = cal.isValidPeriod(req.query.period) ? req.query.period : cal.periodOf(new Date(), tz);
  const { start, end } = cal.periodBounds(period, tz);
  const scope = access.tripScope(m);

  const [trips, inProgress, depts, activeStaff] = await Promise.all([
    prisma.corporateTrip.findMany({
      where: { companyId: c.id, status: 'COMPLETED', tripAt: { gte: start, lt: end }, ...scope },
      select: { fare: true, distanceKm: true, serviceType: true, auditStatus: true, weekendTrip: true, tripAt: true, employeeId: true, departmentId: true, costCenter: true,
        employee: { select: { staffNumber: true, department: { select: { name: true } }, user: { select: { firstName: true, lastName: true } } } } },
    }),
    prisma.corporateTrip.count({ where: { companyId: c.id, status: 'REQUESTED', ...scope } }),
    prisma.department.findMany({ where: { companyId: c.id, isActive: true }, select: { id: true, name: true, costCenter: true, monthlyBudget: true } }),
    prisma.companyEmployee.count({ where: { companyId: c.id, inviteStatus: 'ACTIVE', isActive: true, ...access.staffScope(m) } }),
  ]);
  const dmap = new Map(depts.map((d) => [d.id, d]));
  const totals = { trips: trips.length, rides: 0, deliveries: 0, distanceKm: 0, spend: 0, weekendTrips: 0, flagged: 0, unreviewed: 0, verified: 0 };
  const byDept = new Map(); const emp = new Map(); const daily = new Map();
  for (const t of trips) {
    totals.spend += t.fare; totals.distanceKm += t.distanceKm ?? 0;
    if (t.serviceType === 'DELIVERY') totals.deliveries++; else totals.rides++;
    if (t.weekendTrip) totals.weekendTrips++;
    if (t.auditStatus === 'FLAGGED') totals.flagged++; else if (t.auditStatus === 'VERIFIED') totals.verified++; else totals.unreviewed++;
    const key = t.departmentId ?? 'none'; const d = dmap.get(t.departmentId);
    const dd = byDept.get(key) ?? { departmentId: t.departmentId, department: d?.name ?? 'Unassigned', costCenter: d?.costCenter ?? t.costCenter ?? '—', budget: d?.monthlyBudget ?? null, trips: 0, spend: 0, distanceKm: 0 };
    dd.trips++; dd.spend += t.fare; dd.distanceKm += t.distanceKm ?? 0; byDept.set(key, dd);
    const ee = emp.get(t.employeeId) ?? { employeeId: t.employeeId, name: fullName(t.employee?.user), staffNumber: t.employee?.staffNumber, department: t.employee?.department?.name ?? '—', trips: 0, spend: 0, distanceKm: 0 };
    ee.trips++; ee.spend += t.fare; ee.distanceKm += t.distanceKm ?? 0; emp.set(t.employeeId, ee);
    const day = cal.localDateString(t.tripAt, tz); const dy = daily.get(day) ?? { date: day, trips: 0, spend: 0 }; dy.trips++; dy.spend += t.fare; daily.set(day, dy);
  }
  const out = {
    period, currency: c.currency, timezone: tz, scope: access.can(m, 'seeCompanyCost') ? 'COMPANY' : 'TEAM',
    totals: r2({ ...totals, avgCostPerKm: totals.distanceKm > 0 ? totals.spend / totals.distanceKm : 0 }),
    inProgress, activeStaff,
    byDepartment: [...byDept.values()].map(r2).sort((a, b) => b.spend - a.spend),
    topStaff: [...emp.values()].map(r2).sort((a, b) => b.spend - a.spend).slice(0, 8),
    daily: [...daily.values()].map(r2).sort((a, b) => a.date.localeCompare(b.date)),
  };
  if (access.can(m, 'seeBilling')) {
    const f = await wallet.getFundingState(c);
    const invoices = await prisma.companyInvoice.findMany({ where: { companyId: c.id, status: { not: 'VOID' } }, orderBy: { periodStart: 'desc' }, take: 6 });
    out.funding = { mode: f.mode, walletBalance: f.balance, walletAvailable: f.walletAvailable, creditLimit: f.creditLimit, creditExposure: f.creditExposure, creditAvailable: f.creditAvailable };
    out.invoices = invoices.map(invoiceDto);
    out.outstandingTotal = cal.round2(invoices.filter((i) => ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'].includes(i.status)).reduce((s, i) => s + i.subtotal - i.amountPaid, 0));
  }
  res.json({ success: true, data: out });
};

// ── Portal: departments & directory ──────────────────────────────────────────
exports.listDepartments = async (req, res) => {
  const c = req.company; const m = req.member; const tz = cal.safeTz(c.timezone);
  const { start, end } = cal.periodBounds(cal.periodOf(new Date(), tz), tz);
  const all = access.can(m, 'seeCompanyCost') || access.can(m, 'manageStaff');
  const heads = (m.headOf ?? []).map((d) => d.id);
  const depts = await prisma.department.findMany({
    where: { companyId: c.id, ...(all ? {} : { id: { in: heads } }) }, orderBy: { name: 'asc' },
    include: { head: { select: { id: true, user: { select: { firstName: true, lastName: true } } } }, _count: { select: { members: true } } },
  });
  const usage = await prisma.corporateTrip.groupBy({ by: ['departmentId'], where: { companyId: c.id, status: { in: ['REQUESTED', 'COMPLETED'] }, tripAt: { gte: start, lt: end }, departmentId: { in: depts.map((d) => d.id) } }, _sum: { fare: true }, _count: { _all: true } });
  const um = new Map(usage.map((u) => [u.departmentId, u]));
  res.json({ success: true, data: { departments: depts.map((d) => ({
    id: d.id, name: d.name, costCenter: d.costCenter, monthlyBudget: d.monthlyBudget, maxTripAmount: d.maxTripAmount, approvalThreshold: d.approvalThreshold, isActive: d.isActive,
    head: d.head ? { id: d.head.id, name: fullName(d.head.user) } : null, staffCount: d._count.members,
    monthSpend: um.get(d.id)?._sum?.fare ?? 0, monthTrips: um.get(d.id)?._count?._all ?? 0,
  })) } });
};
exports.createDepartment = async (req, res) => { if (bad(req, res)) return; res.status(201).json({ success: true, data: { department: await dir.createDepartment(req.company.id, req.body) } }); };
exports.updateDepartment = async (req, res) => { if (bad(req, res)) return; res.json({ success: true, message: 'Department saved', data: { department: await dir.updateDepartment(req.company.id, req.params.id, req.body) } }); };

exports.listDirectory = async (req, res) => res.json({ success: true, data: await dir.listDirectory(req.company.id, req.query) });
exports.importDirectory = async (req, res) => {
  const r = await dir.importDirectory(req.company.id, req.body.rows);
  res.json({ success: true, message: `${r.created} added, ${r.updated} updated${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`, data: r });
};
exports.markDirectoryExit = async (req, res) => res.json({ success: true, message: 'Marked as left', data: await dir.markExited({ companyId: req.company.id, entryId: req.params.id, byId: req.user.id, reason: req.body?.reason }) });

// ── Portal: staff ────────────────────────────────────────────────────────────
exports.listEmployees = async (req, res) => {
  const c = req.company; const m = req.member; const tz = cal.safeTz(c.timezone);
  const { limit, page, skip } = pageArgs(req.query);
  const { status, search, requests, departmentId } = req.query;
  const where = { companyId: c.id, ...access.staffScope(m) };
  if (requests === 'true') { where.inviteStatus = 'PENDING'; where.joinSource = 'STAFF_REQUEST'; where.isActive = true; } else if (status) where.inviteStatus = status;
  if (departmentId) where.departmentId = departmentId;
  if (search) where.AND = [{ OR: [{ staffNumber: { contains: search, mode: 'insensitive' } }, { user: { firstName: { contains: search, mode: 'insensitive' } } }, { user: { lastName: { contains: search, mode: 'insensitive' } } }] }];
  const [rows, total] = await Promise.all([
    prisma.companyEmployee.findMany({
      where, orderBy: [{ requestedAt: 'desc' }, { createdAt: 'desc' }], skip, take: limit,
      include: { user: { select: { firstName: true, lastName: true, phone: true, email: true } }, department: { select: { id: true, name: true, costCenter: true } }, supervisor: { select: { id: true, user: { select: { firstName: true, lastName: true } } } } },
    }),
    prisma.companyEmployee.count({ where }),
  ]);
  const { start, end } = cal.periodBounds(cal.periodOf(new Date(), tz), tz);
  const usage = rows.length ? await prisma.corporateTrip.groupBy({ by: ['employeeId'], where: { employeeId: { in: rows.map((r) => r.id) }, status: { in: ['REQUESTED', 'COMPLETED'] }, tripAt: { gte: start, lt: end } }, _sum: { fare: true, distanceKm: true }, _count: { _all: true } }) : [];
  const um = new Map(usage.map((u) => [u.employeeId, u]));
  const entries = rows.length ? await prisma.staffDirectoryEntry.findMany({ where: { id: { in: rows.map((r) => r.directoryEntryId).filter(Boolean) } }, include: { department: { select: { name: true } } } }) : [];
  const em = new Map(entries.map((e) => [e.id, e]));
  res.json({ success: true, data: { employees: rows.map((e) => {
    const u = um.get(e.id); const de = e.directoryEntryId ? em.get(e.directoryEntryId) : null;
    return {
      id: e.id, role: e.role, staffNumber: e.staffNumber, claimedDepartment: e.claimedDepartment, jobTitle: e.jobTitle, inviteStatus: e.inviteStatus, isActive: e.isActive,
      monthlyLimit: e.monthlyLimit, requestedAt: e.requestedAt, joinedAt: e.joinedAt, exitedAt: e.exitedAt, exitReason: e.exitReason, reviewNote: e.reviewNote,
      user: e.user, department: e.department, supervisor: e.supervisor ? { id: e.supervisor.id, name: fullName(e.supervisor.user) } : null,
      directoryMatch: e.directoryMatch, directory: de ? { fullName: de.fullName, department: de.department?.name ?? null, departmentId: de.departmentId, jobTitle: de.jobTitle, status: de.status } : null,
      monthSpend: u?._sum?.fare ?? 0, monthTrips: u?._count?._all ?? 0, monthDistanceKm: cal.round2(u?._sum?.distanceKm ?? 0),
    };
  }), pagination: pagination(total, page, limit) } });
};

exports.reviewEmployee = async (req, res) => {
  if (bad(req, res)) return;
  const { approve, departmentId, supervisorId, monthlyLimit, note } = req.body;
  const updated = await corp.reviewJoinRequest({ companyId: req.company.id, employeeId: req.params.id, reviewerId: req.user.id, approve, departmentId, supervisorId, monthlyLimit, note });
  res.json({ success: true, message: approve ? 'Staff member listed' : 'Request declined', data: { employee: updated } });
};
exports.delistEmployee = async (req, res) => {
  const r = await corp.delistEmployee({ companyId: req.company.id, employeeId: req.params.id, byId: req.user.id, reason: req.body?.reason });
  res.json({ success: true, message: 'Delisted. They remain a normal Runserv customer.', data: r });
};
exports.setRole = async (req, res) => {
  if (bad(req, res)) return;
  res.json({ success: true, message: 'Role updated', data: { employee: await corp.setRole({ companyId: req.company.id, employeeId: req.params.id, role: req.body.role, byId: req.user.id }) } });
};
exports.updateEmployee = async (req, res) => {
  if (bad(req, res)) return;
  const emp = await prisma.companyEmployee.findUnique({ where: { id: req.params.id } });
  if (!emp || emp.companyId !== req.company.id) throw new AppError('Staff member not found', 404);
  const b = req.body; const data = {};
  if (b.monthlyLimit !== undefined) data.monthlyLimit = Number(b.monthlyLimit);
  if (b.jobTitle !== undefined) data.jobTitle = b.jobTitle;
  if (b.staffNumber) data.staffNumber = corp.normalizeStaffNumber(b.staffNumber);
  if (b.requireTripPurpose !== undefined) data.requireTripPurpose = b.requireTripPurpose;
  if (b.restrictToBusinessHours !== undefined) data.restrictToBusinessHours = b.restrictToBusinessHours;
  if (b.departmentId) { const d = await prisma.department.findUnique({ where: { id: b.departmentId } }); if (!d || d.companyId !== req.company.id) throw new AppError('Department not found', 400); data.departmentId = d.id; }
  if ('supervisorId' in b) {
    if (b.supervisorId) { const s = await prisma.companyEmployee.findUnique({ where: { id: b.supervisorId } }); if (!s || s.companyId !== req.company.id || s.id === emp.id) throw new AppError('Supervisor not found', 400); }
    data.supervisorId = b.supervisorId || null;
  }
  res.json({ success: true, message: 'Saved', data: { employee: await prisma.companyEmployee.update({ where: { id: emp.id }, data }) } });
};

// ── Portal: weekend requests & trip approvals ────────────────────────────────
const approverScope = (m) => (access.can(m, 'manageStaff') ? {} : { employee: access.staffScope(m) });

exports.listWeekendRequests = async (req, res) => {
  const { limit, page, skip } = pageArgs(req.query, 50);
  const where = { companyId: req.company.id, ...(req.query.status && { status: req.query.status }), ...approverScope(req.member) };
  const [rows, total] = await Promise.all([
    prisma.weekendRideRequest.findMany({ where, orderBy: [{ status: 'asc' }, { requestedDate: 'asc' }], skip, take: limit, include: { employee: { select: { staffNumber: true, department: { select: { name: true } }, user: { select: { firstName: true, lastName: true } } } } } }),
    prisma.weekendRideRequest.count({ where }),
  ]);
  res.json({ success: true, data: { requests: rows.map((r) => ({ id: r.id, date: r.requestedDate.toISOString().slice(0, 10), reason: r.reason, status: r.status, reviewNote: r.reviewNote, createdAt: r.createdAt,
    employee: { name: fullName(r.employee.user), staffNumber: r.employee.staffNumber, department: r.employee.department?.name ?? null } })), pagination: pagination(total, page, limit) } });
};
exports.reviewWeekendRequest = async (req, res) => {
  if (bad(req, res)) return;
  const u = await corp.reviewWeekendRequest({ decider: req.member, requestId: req.params.id, approve: req.body.approve, note: req.body.note });
  res.json({ success: true, message: req.body.approve ? 'Weekend ride approved' : 'Request declined', data: { request: u } });
};

exports.listApprovals = async (req, res) => {
  const { limit, page, skip } = pageArgs(req.query, 50);
  const where = { companyId: req.company.id, ...(req.query.status && { status: req.query.status }), ...approverScope(req.member) };
  const [rows, total] = await Promise.all([
    prisma.approvalRequest.findMany({ where, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], skip, take: limit, include: { employee: { select: { staffNumber: true, department: { select: { name: true, costCenter: true } }, user: { select: { firstName: true, lastName: true } } } } } }),
    prisma.approvalRequest.count({ where }),
  ]);
  const now = new Date();
  res.json({ success: true, data: { approvals: rows.map((a) => ({
    id: a.id, status: a.status === 'PENDING' && a.expiresAt <= now ? 'EXPIRED' : a.status, serviceType: a.serviceType, pickup: a.pickupAddress, dropoff: a.dropoffAddress,
    fare: a.estimatedFare, distanceKm: a.distanceKm, purpose: a.purpose, reason: a.reason, decisionNote: a.decisionNote, createdAt: a.createdAt, expiresAt: a.expiresAt,
    employee: { name: fullName(a.employee.user), staffNumber: a.employee.staffNumber, department: a.employee.department?.name ?? null, costCenter: a.employee.department?.costCenter ?? null },
  })), pagination: pagination(total, page, limit) } });
};
exports.decideApproval = async (req, res) => {
  if (bad(req, res)) return;
  const u = await corp.decideApproval({ decider: req.member, approvalId: req.params.id, approve: req.body.approve, note: req.body.note });
  res.json({ success: true, message: req.body.approve ? 'Trip approved' : 'Trip declined', data: { approval: u } });
};

// ── Portal: trips, audit ─────────────────────────────────────────────────────
exports.getTrips = async (req, res) => {
  const { limit, page, skip } = pageArgs(req.query, 25);
  const where = buildTripWhere(req.member, req.company, req.query);
  const [rows, total, agg] = await Promise.all([
    prisma.corporateTrip.findMany({ where, include: TRIP_INCLUDE, orderBy: { tripAt: 'desc' }, skip, take: limit }),
    prisma.corporateTrip.count({ where }),
    prisma.corporateTrip.aggregate({ where, _sum: { fare: true, distanceKm: true } }),
  ]);
  const spend = agg._sum.fare ?? 0; const km = agg._sum.distanceKm ?? 0;
  res.json({ success: true, data: { trips: rows.map(tripDto), summary: { trips: total, spend: cal.round2(spend), distanceKm: cal.round2(km), avgCostPerKm: km > 0 ? cal.round2(spend / km) : null, currency: req.company.currency }, pagination: pagination(total, page, limit) } });
};

exports.getEmployeeHistory = async (req, res) => {
  const c = req.company; const tz = cal.safeTz(c.timezone);
  const emp = await prisma.companyEmployee.findUnique({ where: { id: req.params.id }, include: { user: { select: { firstName: true, lastName: true, phone: true, email: true } }, department: { select: { name: true, costCenter: true } }, supervisor: { select: { user: { select: { firstName: true, lastName: true } } } } } });
  if (!emp || emp.companyId !== c.id) throw new AppError('Staff member not found', 404);
  const scoped = await prisma.companyEmployee.findUnique({ where: { id: emp.id }, select: { id: true, supervisorId: true, departmentId: true } });
  if (!access.canSeeEmployee(req.member, scoped)) throw new AppError('You can only view people in your own department or reporting to you.', 403);
  const period = cal.isValidPeriod(req.query.period) ? req.query.period : cal.periodOf(new Date(), tz);
  const { start, end } = cal.periodBounds(period, tz);
  const rows = await prisma.corporateTrip.findMany({ where: { companyId: c.id, employeeId: emp.id, status: 'COMPLETED', tripAt: { gte: start, lt: end } }, include: TRIP_INCLUDE, orderBy: { tripAt: 'asc' } });
  const trips = rows.map(tripDto);
  const spend = trips.reduce((s, t) => s + t.fare, 0); const km = trips.reduce((s, t) => s + (t.distanceKm ?? 0), 0);
  res.json({ success: true, data: {
    period, currency: c.currency,
    employee: { id: emp.id, name: fullName(emp.user), phone: emp.user.phone, email: emp.user.email, staffNumber: emp.staffNumber, department: emp.department?.name ?? null, costCenter: emp.department?.costCenter ?? null,
      supervisor: emp.supervisor ? fullName(emp.supervisor.user) : null, jobTitle: emp.jobTitle, monthlyLimit: emp.monthlyLimit, status: emp.inviteStatus },
    summary: { trips: trips.length, spend: cal.round2(spend), distanceKm: cal.round2(km), avgCostPerKm: km > 0 ? cal.round2(spend / km) : null, weekendTrips: trips.filter((t) => t.weekendTrip).length, flagged: trips.filter((t) => t.audit.status === 'FLAGGED').length, noPurpose: trips.filter((t) => !t.purpose).length },
    trips,
  } });
};

exports.auditTrip = async (req, res) => {
  if (bad(req, res)) return;
  const trip = await prisma.corporateTrip.findFirst({ where: { id: req.params.id, companyId: req.company.id, ...access.tripScope(req.member) } });
  if (!trip) throw new AppError('Trip not found', 404);
  const updated = await prisma.corporateTrip.update({ where: { id: trip.id }, data: { auditStatus: req.body.status, auditNote: req.body.note ? String(req.body.note).slice(0, 500) : null, auditedAt: new Date(), auditedById: req.user.id }, include: TRIP_INCLUDE });
  res.json({ success: true, message: 'Audit updated', data: { trip: tripDto(updated) } });
};

// ── Portal: billing, wallet ──────────────────────────────────────────────────
exports.getBillingOverview = async (req, res) => {
  const c = req.company; const tz = cal.safeTz(c.timezone);
  const period = cal.periodOf(new Date(), tz); const { start, end } = cal.periodBounds(period, tz);
  const [f, agg, invoices] = await Promise.all([
    wallet.getFundingState(c),
    prisma.corporateTrip.aggregate({ where: { companyId: c.id, status: 'COMPLETED', tripAt: { gte: start, lt: end } }, _sum: { fare: true, distanceKm: true, walletPaid: true, creditAmount: true }, _count: { _all: true } }),
    prisma.companyInvoice.findMany({ where: { companyId: c.id, status: { not: 'VOID' } }, orderBy: { periodStart: 'desc' }, take: 36 }),
  ]);
  res.json({ success: true, data: {
    period, currency: c.currency, billingMode: c.billingMode, verificationStatus: c.verificationStatus, paymentTermsDays: c.paymentTermsDays, subscriptionFee: c.subscriptionFee,
    funding: { walletBalance: f.balance, walletAvailable: f.walletAvailable, held: f.held, creditLimit: f.creditLimit, creditExposure: f.creditExposure, creditAvailable: f.creditAvailable },
    month: { trips: agg._count._all, total: agg._sum.fare ?? 0, fromWallet: agg._sum.walletPaid ?? 0, onCredit: agg._sum.creditAmount ?? 0, distanceKm: cal.round2(agg._sum.distanceKm ?? 0), willBeInvoicedOn: end },
    invoices: invoices.map(invoiceDto),
  } });
};
exports.getInvoiceById = async (req, res) => {
  const inv = await prisma.companyInvoice.findUnique({ where: { id: req.params.id }, include: { payments: { orderBy: { receivedAt: 'asc' } } } });
  if (!inv || inv.companyId !== req.company.id) throw new AppError('Invoice not found', 404);
  const trips = await prisma.corporateTrip.findMany({ where: { invoiceId: inv.id }, include: TRIP_INCLUDE, orderBy: { tripAt: 'asc' } });
  const dto = trips.map(tripDto);
  const byDept = new Map(); const byEmp = new Map();
  for (const t of dto) {
    const k = t.costCenter ?? '—'; const d = byDept.get(k) ?? { costCenter: k, trips: 0, total: 0 }; d.trips++; d.total += t.funding.credit; byDept.set(k, d);
    const e = byEmp.get(t.employee.id) ?? { ...t.employee, trips: 0, distanceKm: 0, total: 0 }; e.trips++; e.distanceKm += t.distanceKm ?? 0; e.total += t.funding.credit; byEmp.set(t.employee.id, e);
  }
  res.json({ success: true, data: {
    invoice: invoiceDto(inv), company: { name: req.company.brandName || req.company.name, address: req.company.address, orgCode: req.company.orgCode },
    payments: inv.payments.map((p) => ({ id: p.id, amount: p.amount, method: p.method, reference: p.reference, receivedAt: p.receivedAt })),
    byCostCenter: [...byDept.values()].map(r2), byEmployee: [...byEmp.values()].map(r2).sort((a, b) => b.total - a.total), trips: dto,
  } });
};
exports.getWalletTransactions = async (req, res) => {
  const { limit, page, skip } = pageArgs(req.query, 30);
  const where = { companyId: req.company.id };
  const [rows, total] = await Promise.all([prisma.orgWalletTx.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }), prisma.orgWalletTx.count({ where })]);
  res.json({ success: true, data: { transactions: rows, balance: req.company.walletBalance, pagination: pagination(total, page, limit) } });
};

/** Start an online top-up (Paystack). The company is credited when the payment is verified. */
exports.initiateTopUp = async (req, res) => {
  if (bad(req, res)) return;
  if (!wallet.usesWallet(req.company.billingMode)) throw new AppError('Your organisation is billed on credit, so it has no prepaid wallet.', 400);
  const amount = Number(req.body.amount);
  const reference = `ORGTOP-${req.company.id.slice(0, 8)}-${crypto.randomBytes(6).toString('hex')}`;
  const init = await payments.paystackInitialize({
    email: req.company.billingEmail || req.company.email, amount, reference, currency: req.company.currency,
    callbackUrl: req.body.callbackUrl, metadata: { type: 'ORG_WALLET_TOPUP', companyId: req.company.id },
  });
  res.json({ success: true, data: { authorizationUrl: init.authorization_url, reference: init.reference || reference } });
};
exports.verifyTopUp = async (req, res) => {
  const reference = String(req.body.reference || '');
  if (!reference.startsWith('ORGTOP-')) throw new AppError('Unknown payment reference', 400);
  const tx = await payments.paystackVerify(reference);
  if (tx.metadata?.companyId !== req.company.id) throw new AppError('This payment belongs to another organisation', 403);
  const line = await wallet.topUp({ companyId: req.company.id, amount: tx.amount / 100, reference, description: 'Wallet top-up (card/bank via Paystack)', createdById: req.user.id });
  res.json({ success: true, message: 'Wallet topped up', data: { transaction: line } });
};

// ── Staff (mobile) ───────────────────────────────────────────────────────────
exports.lookup = async (req, res) => res.json({ success: true, data: { organisation: await corp.lookupOrganisation(req.params.code) } });
exports.getMyAccount = async (req, res) => res.json({ success: true, data: await corp.getMyOrganisation(req.user.id) });
exports.requestToJoin = async (req, res) => {
  if (bad(req, res)) return;
  const { orgCode, staffNumber, department, jobTitle } = req.body;
  const r = await corp.requestToJoin({ userId: req.user.id, orgCode, staffNumber, department, jobTitle });
  res.status(201).json({ success: true, message: `Request sent to ${r.organisation.name}. HR will check it against their staff records.`, data: { employee: { id: r.employee.id, inviteStatus: r.employee.inviteStatus }, organisation: r.organisation } });
};
exports.cancelJoinRequest = async (req, res) => res.json({ success: true, message: 'Request cancelled', data: await corp.cancelJoinRequest(req.user.id) });
exports.leave = async (req, res) => res.json({ success: true, message: 'You have left the organisation', data: await corp.leaveOrganisation(req.user.id) });

exports.getMyTrips = async (req, res) => {
  const m = await prisma.companyEmployee.findFirst({ where: { userId: req.user.id, inviteStatus: 'ACTIVE', isActive: true }, include: { company: true } });
  if (!m) throw new AppError('You are not listed under an organisation', 404);
  const tz = cal.safeTz(m.company.timezone);
  const period = cal.isValidPeriod(req.query.period) ? req.query.period : cal.periodOf(new Date(), tz);
  const { start, end } = cal.periodBounds(period, tz);
  const rows = await prisma.corporateTrip.findMany({ where: { employeeId: m.id, status: 'COMPLETED', tripAt: { gte: start, lt: end } }, include: TRIP_INCLUDE, orderBy: { tripAt: 'desc' }, take: 200 });
  const trips = rows.map(tripDto);
  res.json({ success: true, data: { period, currency: m.company.currency, trips, totals: { trips: trips.length, spend: cal.round2(trips.reduce((s, t) => s + t.fare, 0)), distanceKm: cal.round2(trips.reduce((s, t) => s + (t.distanceKm ?? 0), 0)) } } });
};
exports.createWeekendRequest = async (req, res) => { if (bad(req, res)) return; res.status(201).json({ success: true, message: 'Request sent', data: { request: await corp.createWeekendRequest({ userId: req.user.id, date: req.body.date, reason: req.body.reason }) } }); };
exports.cancelWeekendRequest = async (req, res) => res.json({ success: true, message: 'Request cancelled', data: { request: await corp.cancelWeekendRequest({ userId: req.user.id, requestId: req.params.id }) } });
exports.requestApproval = async (req, res) => {
  if (bad(req, res)) return;
  const a = await corp.requestApproval({ userId: req.user.id, ...req.body });
  res.status(201).json({ success: true, message: 'Sent to your manager for approval', data: { approval: { id: a.id, status: a.status, expiresAt: a.expiresAt } } });
};
exports.getMyApproval = async (req, res) => {
  const m = await corp.getActiveMembership(req.user.id);
  const a = m && await prisma.approvalRequest.findUnique({ where: { id: req.params.id } });
  if (!a || a.employeeId !== m.id) throw new AppError('Approval not found', 404);
  res.json({ success: true, data: { approval: { id: a.id, status: a.status === 'PENDING' && a.expiresAt <= new Date() ? 'EXPIRED' : a.status, fare: a.estimatedFare, decisionNote: a.decisionNote, expiresAt: a.expiresAt } } });
};

// ── Drivers / partners ───────────────────────────────────────────────────────
exports.getEarningsSummary = async (req, res) => res.json({ success: true, data: await billing.getEarnerSummary(req.user.id) });
exports.getEarningsTrips = async (req, res) => { const { page, limit, companyId, period } = req.query; res.json({ success: true, data: await billing.getEarnerTrips({ userId: req.user.id, companyId, period, page, limit }) }); };

module.exports = exports;


// ── Paying Runserv by bank transfer ──────────────────────────────────────────
// Every active Runserv account (Wema, Fidelity, FirstBank…) the company can pay into, plus its wallet reference and a reference per
// open invoice. Credits quoting these references are matched automatically (services/bankReceipts.service.js).
exports.getPayInstructions = async (req, res) => {
  const data = await require('../services/bankReceipts.service').companyPaymentInstructions({ companyId: req.company.id });
  res.json({ success: true, data });
};
exports.getBankReceipts = async (req, res) => {
  const receipts = await require('../services/bankReceipts.service').companyReceipts({ companyId: req.company.id });
  res.json({ success: true, data: { receipts } });
};
