// backend/src/controllers/fleet.controller.js — Fleet Partner Portal API (mounted at /api/fleet)
'use strict';

const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { logActivity } = require('../utils/auditLog');
const { CAN, can, assertCan, assertFleetActive } = require('../services/fleetAccess');
const fleet = require('../services/fleet.service');
const { vehicleCompliance } = require('../services/fleetCompliance');

const page = (req) => {
  const take = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
  const skip = (Math.max(parseInt(req.query.page, 10) || 1, 1) - 1) * take;
  return { take, skip };
};
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

// ── Application ───────────────────────────────────────────────────────────────
// Any signed-in customer may apply. Applying creates a PENDING fleet and makes them its OWNER;
// it does NOT change their user role or give them driver permissions.
exports.apply = async (req, res) => {
  const existing = await prisma.fleetPartnerUser.findFirst({ where: { userId: req.user.id, isActive: true } });
  if (existing) throw new AppError('You already belong to a fleet partner account.', 409);
  const { legalName, tradingName, rcNumber, taxId, email, phone, address } = req.body;
  const fp = await prisma.$transaction(async (tx) => {
    const created = await tx.fleetPartner.create({
      data: { legalName, tradingName, rcNumber: rcNumber || null, taxId, email, phone, address, ownerUserId: req.user.id, countryCode: req.user.countryCode || 'NG', status: 'PENDING' },
    });
    await tx.fleetPartnerUser.create({ data: { fleetPartnerId: created.id, userId: req.user.id, role: 'OWNER', acceptedAt: new Date() } });
    return created;
  });
  await logActivity({ userId: req.user.id, action: 'fleet_applied', entityType: 'FleetPartner', entityId: fp.id, req });
  return ok(res, { fleetPartner: fp }, 201);
};

exports.profile = async (req, res) => {
  const { member, fleetPartner } = req.fleet;
  const f = { ...fleetPartner };
  if (!can(member, 'seeFinance')) { delete f.payoutAccountNumber; delete f.payoutBankCode; delete f.payoutAccountName; delete f.commissionRate; }
  // The UI mirrors these; the server still enforces every one of them on each request.
  const permissions = Object.fromEntries(Object.keys(CAN).map((k) => [k, can(member, k)]));
  return ok(res, { role: member.role, permissions, fleetPartner: f });
};

exports.updateProfile = async (req, res) => {
  assertCan(req.fleet.member, 'manageSettings');
  const data = {};
  for (const k of ['tradingName', 'email', 'phone', 'address', 'supportEmail', 'payoutAccountName', 'payoutBankCode', 'payoutAccountNumber']) if (req.body[k] !== undefined) data[k] = req.body[k];
  // Where money is paid is the classic fraud target (account takeover → redirect the payout). Changes to it are logged with the
  // old and new account masked, so staff can see the change before they mark any settlement paid.
  const payoutKeys = ['payoutAccountName', 'payoutBankCode', 'payoutAccountNumber'];
  const touchesPayout = payoutKeys.some((k) => data[k] !== undefined);
  const before = touchesPayout ? await prisma.fleetPartner.findUnique({ where: { id: req.fleet.fleetPartnerId }, select: { payoutAccountNumber: true, payoutBankCode: true } }) : null;
  const row = await prisma.fleetPartner.update({ where: { id: req.fleet.fleetPartnerId }, data });
  await logActivity({ userId: req.user.id, action: 'fleet_profile_updated', entityType: 'FleetPartner', entityId: row.id, details: { fields: Object.keys(data) }, req });
  if (touchesPayout) {
    const mask = (n) => (n ? `••••${String(n).slice(-4)}` : null);
    await logActivity({ userId: req.user.id, action: 'fleet_payout_account_changed', entityType: 'FleetPartner', entityId: row.id, details: { from: { account: mask(before?.payoutAccountNumber), bank: before?.payoutBankCode ?? null }, to: { account: mask(row.payoutAccountNumber), bank: row.payoutBankCode ?? null } }, req });
  }
  return ok(res, { fleetPartner: row });
};

// ── Overview ─────────────────────────────────────────────────────────────────
exports.overview = async (req, res) => {
  const { fleetPartnerId, member } = req.fleet;
  const since = new Date(Date.now() - 30 * 86400000);
  const [vehicles, activeAssignments, inProgress, completed, vehicleRows] = await Promise.all([
    prisma.fleetVehicle.count({ where: { fleetPartnerId, status: 'ACTIVE' } }),
    prisma.fleetDriverAssignment.count({ where: { fleetPartnerId, status: 'ACTIVE' } }),
    prisma.fleetTrip.count({ where: { fleetPartnerId, status: { in: ['ACCEPTED', 'IN_PROGRESS'] } } }),
    prisma.fleetTrip.findMany({ where: { fleetPartnerId, status: 'COMPLETED', completedAt: { gte: since } }, select: { fareAmount: true, fleetNetAmount: true } }),
    prisma.fleetVehicle.findMany({ where: { fleetPartnerId, isActive: true }, include: { documents: true } }),
  ]);
  const alerts = vehicleRows.map((v) => ({ vehicleId: v.id, registrationNumber: v.registrationNumber, ...vehicleCompliance(v) })).filter((a) => a.blockers.length || a.warnings.length);
  const out = { activeVehicles: vehicles, activeDrivers: activeAssignments, tripsInProgress: inProgress, tripsCompleted30d: completed.length, alerts };
  if (can(member, 'seeFinance')) {
    out.gross30d = completed.reduce((s, t) => s + Number(t.fareAmount), 0);
    out.net30d = completed.reduce((s, t) => s + Number(t.fleetNetAmount), 0);
  }
  return ok(res, out);
};

// ── Team ─────────────────────────────────────────────────────────────────────
exports.listUsers = async (req, res) => {
  assertCan(req.fleet.member, 'manageUsers');
  const rows = await prisma.fleetPartnerUser.findMany({ where: { fleetPartnerId: req.fleet.fleetPartnerId }, include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } }, orderBy: { createdAt: 'asc' } });
  return ok(res, { users: rows });
};

exports.addUser = async (req, res) => {
  assertCan(req.fleet.member, 'manageUsers');
  if (req.body.role === 'OWNER') throw new AppError('There is one owner per fleet.', 400);
  const user = await prisma.user.findUnique({ where: { email: String(req.body.email).toLowerCase() }, select: { id: true, isActive: true } });
  if (!user || !user.isActive) throw new AppError('No Runserv account with that email. Ask them to sign up first.', 404);
  const elsewhere = await prisma.fleetPartnerUser.findFirst({ where: { userId: user.id, isActive: true, NOT: { fleetPartnerId: req.fleet.fleetPartnerId } } });
  if (elsewhere) throw new AppError('This person already belongs to another fleet account.', 409);
  const row = await prisma.fleetPartnerUser.upsert({
    where: { fleetPartnerId_userId: { fleetPartnerId: req.fleet.fleetPartnerId, userId: user.id } },
    update: { role: req.body.role, isActive: true },
    create: { fleetPartnerId: req.fleet.fleetPartnerId, userId: user.id, role: req.body.role, acceptedAt: new Date() },
  });
  await logActivity({ userId: req.user.id, action: 'fleet_user_added', entityType: 'FleetPartnerUser', entityId: row.id, details: { role: row.role, fleetPartnerId: req.fleet.fleetPartnerId }, req });
  return ok(res, { user: row }, 201);
};

exports.updateUser = async (req, res) => {
  assertCan(req.fleet.member, 'manageUsers');
  const target = await prisma.fleetPartnerUser.findFirst({ where: { id: req.params.id, fleetPartnerId: req.fleet.fleetPartnerId } });
  if (!target) throw new AppError('Team member not found.', 404);
  if (target.role === 'OWNER') throw new AppError('The owner cannot be changed here.', 403);
  if (req.body.role === 'OWNER') throw new AppError('There is one owner per fleet.', 400);
  const row = await prisma.fleetPartnerUser.update({ where: { id: target.id }, data: { ...(req.body.role && { role: req.body.role }), ...(req.body.isActive !== undefined && { isActive: req.body.isActive }) } });
  await logActivity({ userId: req.user.id, action: 'fleet_user_updated', entityType: 'FleetPartnerUser', entityId: row.id, details: req.body, req });
  return ok(res, { user: row });
};

// ── Vehicles ─────────────────────────────────────────────────────────────────
const VEHICLE_FIELDS = ['vehicleType', 'subType', 'make', 'model', 'modelYear', 'colour', 'registrationNumber', 'seatingCapacity', 'payloadCapacityKg', 'insuranceExpiresAt', 'roadworthyExpiresAt', 'permitExpiresAt'];
const pickVehicle = (b) => { const d = {}; for (const k of VEHICLE_FIELDS) if (b[k] !== undefined) d[k] = b[k]; if (d.registrationNumber) d.registrationNumber = String(d.registrationNumber).replace(/\s+/g, '').toUpperCase(); return d; };

exports.listVehicles = async (req, res) => {
  const where = { fleetPartnerId: req.fleet.fleetPartnerId, ...(req.query.status && { status: req.query.status }) };
  const [rows, total] = await Promise.all([
    prisma.fleetVehicle.findMany({ where, ...page(req), orderBy: { createdAt: 'desc' }, include: { documents: true, assignments: { where: { status: 'ACTIVE' }, select: { id: true, driverUserId: true } } } }),
    prisma.fleetVehicle.count({ where }),
  ]);
  return ok(res, { total, vehicles: rows.map((v) => ({ ...v, compliance: vehicleCompliance(v) })) });
};

exports.getVehicle = async (req, res) => {
  const v = await prisma.fleetVehicle.findFirst({ where: { id: req.params.id, fleetPartnerId: req.fleet.fleetPartnerId }, include: { documents: true, assignments: { orderBy: { createdAt: 'desc' }, take: 20 } } });
  if (!v) throw new AppError('Vehicle not found.', 404);
  return ok(res, { vehicle: v, compliance: vehicleCompliance(v) });
};

exports.createVehicle = async (req, res) => {
  assertCan(req.fleet.member, 'manageVehicles');
  const v = await prisma.fleetVehicle.create({ data: { ...pickVehicle(req.body), fleetPartnerId: req.fleet.fleetPartnerId, status: 'PENDING' } });
  await logActivity({ userId: req.user.id, action: 'fleet_vehicle_created', entityType: 'FleetVehicle', entityId: v.id, details: { fleetPartnerId: req.fleet.fleetPartnerId, type: v.vehicleType }, req });
  return ok(res, { vehicle: v }, 201);
};

exports.updateVehicle = async (req, res) => {
  assertCan(req.fleet.member, 'manageVehicles');
  const v = await prisma.fleetVehicle.findFirst({ where: { id: req.params.id, fleetPartnerId: req.fleet.fleetPartnerId } });
  if (!v) throw new AppError('Vehicle not found.', 404);
  const data = pickVehicle(req.body);
  // Changing identity or a compliance date sends an approved vehicle back for Runserv review.
  const sensitive = ['vehicleType', 'registrationNumber', 'insuranceExpiresAt', 'roadworthyExpiresAt', 'permitExpiresAt'];
  const needsReview = v.status === 'ACTIVE' && sensitive.some((k) => data[k] !== undefined && String(data[k]) !== String(v[k] instanceof Date ? v[k].toISOString().slice(0, 10) : v[k]));
  const row = await prisma.fleetVehicle.update({ where: { id: v.id }, data: { ...data, ...(needsReview && { status: 'PENDING' }) } });
  await logActivity({ userId: req.user.id, action: 'fleet_vehicle_updated', entityType: 'FleetVehicle', entityId: v.id, details: { fields: Object.keys(data), sentForReview: needsReview }, req });
  return ok(res, { vehicle: row, sentForReview: needsReview });
};

// ── Documents (metadata + private file reference; verification is Runserv's) ─
exports.listDocuments = async (req, res) => {
  const rows = await prisma.fleetPartnerDocument.findMany({ where: { fleetPartnerId: req.fleet.fleetPartnerId, ...(req.query.vehicleId && { vehicleId: req.query.vehicleId }) }, orderBy: { createdAt: 'desc' }, take: 200 });
  return ok(res, { documents: rows });
};

exports.addDocument = async (req, res) => {
  assertCan(req.fleet.member, 'manageDocuments');
  const { vehicleId, documentType, fileUrl, documentNumber, issuedAt, expiresAt } = req.body;
  if (vehicleId) {
    const v = await prisma.fleetVehicle.findFirst({ where: { id: vehicleId, fleetPartnerId: req.fleet.fleetPartnerId }, select: { id: true } });
    if (!v) throw new AppError('Vehicle not found in your fleet.', 404);
  }
  const d = await prisma.fleetPartnerDocument.create({ data: { fleetPartnerId: req.fleet.fleetPartnerId, vehicleId: vehicleId || null, documentType, fileUrl, documentNumber, issuedAt, expiresAt } });
  await logActivity({ userId: req.user.id, action: 'fleet_document_uploaded', entityType: 'FleetPartnerDocument', entityId: d.id, details: { documentType, vehicleId }, req });
  return ok(res, { document: d }, 201);
};

// ── Drivers & assignments ────────────────────────────────────────────────────
exports.listDrivers = async (req, res) => {
  const identity = can(req.fleet.member, 'seeDriverIdentity');
  const rows = await prisma.fleetDriverAssignment.findMany({
    where: { fleetPartnerId: req.fleet.fleetPartnerId, ...(req.query.status && { status: req.query.status }) }, orderBy: { createdAt: 'desc' }, ...page(req),
    include: { vehicle: { select: { id: true, registrationNumber: true, vehicleType: true, make: true, model: true } }, driver: { select: { id: true, firstName: true, lastName: true, ...(identity && { phone: true, email: true }) } } },
  });
  return ok(res, { assignments: rows });
};

exports.assign = async (req, res) => {
  assertCan(req.fleet.member, 'assignDrivers');
  let { driverUserId } = req.body;
  if (!driverUserId && req.body.driverEmail) {
    const u = await prisma.user.findUnique({ where: { email: String(req.body.driverEmail).toLowerCase() }, select: { id: true } });
    if (!u) throw new AppError('No Runserv account with that email.', 404);
    driverUserId = u.id;
  }
  if (!driverUserId) throw new AppError('driverUserId or driverEmail is required.', 400);
  const row = await fleet.assignDriver({ fleetPartner: req.fleet.fleetPartner, vehicleId: req.body.vehicleId, driverUserId, actor: req.user.id, req });
  return ok(res, { assignment: row }, 201);
};

exports.endAssignment = async (req, res) => {
  assertCan(req.fleet.member, 'assignDrivers');
  const row = await fleet.endAssignment({ fleetPartnerId: req.fleet.fleetPartnerId, assignmentId: req.params.id, actor: req.user.id, req });
  return ok(res, { assignment: row });
};

// ── Trips ────────────────────────────────────────────────────────────────────
exports.listTrips = async (req, res) => {
  assertCan(req.fleet.member, 'seeTrips');
  // Fares, platform fees and net amounts are finance data: Owner, Admin and Finance only
  // (Operations, Fleet Manager and Viewer see the operational facts of a trip, not the money).
  const money = can(req.fleet.member, 'seeFinance');
  const status = req.query.exceptions === 'true' ? { in: ['CANCELLED', 'DISPUTED'] } : req.query.status;
  const where = { fleetPartnerId: req.fleet.fleetPartnerId, ...(status && { status }) };
  const [rows, total] = await Promise.all([
    prisma.fleetTrip.findMany({
      where, ...page(req), orderBy: { createdAt: 'desc' },
      include: {
        driver: { select: { id: true, firstName: true, lastName: true } },
        vehicle: { select: { id: true, registrationNumber: true, make: true, model: true } },
      },
    }),
    prisma.fleetTrip.count({ where }),
  ]);
  return ok(res, { total, trips: rows.map((t) => (money ? t : { ...t, fareAmount: undefined, platformFeeAmount: undefined, fleetNetAmount: undefined })) });
};

// ── Finance ──────────────────────────────────────────────────────────────────
exports.listSettlements = async (req, res) => {
  assertCan(req.fleet.member, 'seeFinance');
  const rows = await prisma.fleetSettlement.findMany({ where: { fleetPartnerId: req.fleet.fleetPartnerId }, orderBy: { periodStart: 'desc' }, take: 100 });
  return ok(res, { settlements: rows });
};

exports.getSettlement = async (req, res) => {
  assertCan(req.fleet.member, 'seeFinance');
  const s = await prisma.fleetSettlement.findFirst({ where: { id: req.params.id, fleetPartnerId: req.fleet.fleetPartnerId } });
  if (!s) throw new AppError('Settlement not found.', 404);
  const trips = await prisma.fleetTrip.findMany({ where: { fleetPartnerId: s.fleetPartnerId, status: 'COMPLETED', completedAt: { gte: s.periodStart, lt: s.periodEnd } }, orderBy: { completedAt: 'asc' } });
  return ok(res, { settlement: s, trips });
};

exports.dispute = async (req, res) => {
  assertCan(req.fleet.member, 'seeFinance');
  const s = await prisma.fleetSettlement.findFirst({ where: { id: req.params.id, fleetPartnerId: req.fleet.fleetPartnerId } });
  if (!s) throw new AppError('Settlement not found.', 404);
  const row = await fleet.transitionSettlement({ id: s.id, to: 'DISPUTED', actor: req.user.id, req });
  await logActivity({ userId: req.user.id, action: 'fleet_settlement_dispute_note', entityType: 'FleetSettlement', entityId: s.id, details: { note: String(req.body.note || '').slice(0, 1000) }, req });
  return ok(res, { settlement: row });
};

// ── Document file upload ─────────────────────────────────────────────────────
// The file itself is stored by the shared upload middleware (see routes); this returns its link so the
// portal can then register it with POST /documents. Verification stays with Runserv.
exports.uploadDocumentFile = async (req, res) => {
  if (!req.privateFile) throw new AppError('No file uploaded', 400);
  await logActivity({ userId: req.user.id, action: 'fleet_document_file_uploaded', entityType: 'FleetPartner', entityId: req.fleet.fleetPartnerId, details: { publicId: req.privateFile.publicId }, req });
  return ok(res, { url: req.privateFile.ref, publicId: req.privateFile.publicId, private: true }, 201);
};

// ── Team invitations and shifts ──────────────────────────────────────────────
const team = require('../services/fleetTeam.service');
exports.invite = async (req, res) => {
  assertCan(req.fleet.member, 'manageUsers');
  return ok(res, await team.invite({ fleetPartnerId: req.fleet.fleetPartnerId, fleetName: req.fleet.fleetPartner.tradingName || req.fleet.fleetPartner.legalName, email: req.body.email, role: req.body.role, actor: req.user.id, req }), 201);
};
exports.listInvitations = async (req, res) => { assertCan(req.fleet.member, 'manageUsers'); return ok(res, { invitations: await team.list(req.fleet.fleetPartnerId) }); };
exports.revokeInvitation = async (req, res) => { assertCan(req.fleet.member, 'manageUsers'); return ok(res, await team.revoke({ id: req.params.id, fleetPartnerId: req.fleet.fleetPartnerId, actor: req.user.id, req })); };
exports.acceptInvitation = async (req, res) => ok(res, { member: await team.accept({ token: req.body.token, user: req.user, req }) });
exports.listShifts = async (req, res) => { assertCan(req.fleet.member, 'seeTrips'); return ok(res, { shifts: await team.listShifts({ fleetPartnerId: req.fleet.fleetPartnerId, from: req.query.from, to: req.query.to, vehicleId: req.query.vehicleId, driverUserId: req.query.driverUserId, includeCancelled: req.query.includeCancelled === 'true' }) }); };
exports.createShift = async (req, res) => { assertCan(req.fleet.member, 'assignDrivers'); assertFleetActive(req.fleet); return ok(res, { shift: await team.createShift({ fleetPartnerId: req.fleet.fleetPartnerId, ...req.body, actor: req.user.id, req }) }, 201); };
exports.cancelShift = async (req, res) => { assertCan(req.fleet.member, 'assignDrivers'); return ok(res, await team.cancelShift({ id: req.params.id, fleetPartnerId: req.fleet.fleetPartnerId, actor: req.user.id, req })); };
