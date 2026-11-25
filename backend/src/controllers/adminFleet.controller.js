// backend/src/controllers/adminFleet.controller.js — Runserv staff side of fleets (/api/admin/fleet)
'use strict';

const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { logActivity } = require('../utils/auditLog');
const fleet = require('../services/fleet.service');
const reconcile = require('../services/fleetTripReconcile.service');
const { vehicleCompliance } = require('../services/fleetCompliance');

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const take = (req) => Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);

exports.stats = async (req, res) => {
  const [partners, pending, vehicles, pendingVehicles, openSettlements] = await Promise.all([
    prisma.fleetPartner.count({ where: { status: 'ACTIVE' } }), prisma.fleetPartner.count({ where: { status: { in: ['PENDING', 'UNDER_REVIEW'] } } }),
    prisma.fleetVehicle.count({ where: { status: 'ACTIVE' } }), prisma.fleetVehicle.count({ where: { status: 'PENDING' } }),
    prisma.fleetSettlement.count({ where: { status: { in: ['PENDING', 'RECONCILING', 'APPROVED', 'DISPUTED'] } } }),
  ]);
  return ok(res, { activeFleets: partners, pendingFleets: pending, activeVehicles: vehicles, pendingVehicles, openSettlements });
};

exports.list = async (req, res) => {
  const where = { ...(req.query.status && { status: req.query.status }), ...(req.query.q && { OR: [{ legalName: { contains: req.query.q, mode: 'insensitive' } }, { tradingName: { contains: req.query.q, mode: 'insensitive' } }] }) };
  const [rows, total] = await Promise.all([prisma.fleetPartner.findMany({ where, take: take(req), skip: (Math.max(parseInt(req.query.page, 10) || 1, 1) - 1) * take(req), orderBy: { createdAt: 'desc' }, include: { _count: { select: { vehicles: true, assignments: true } } } }), prisma.fleetPartner.count({ where })]);
  return ok(res, { total, fleets: rows });
};

exports.get = async (req, res) => {
  const f = await prisma.fleetPartner.findUnique({ where: { id: req.params.id }, include: { members: { include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } } }, documents: { orderBy: { createdAt: 'desc' }, take: 100 }, vehicles: { orderBy: { createdAt: 'desc' }, take: 200, include: { documents: true } } } });
  if (!f) throw new AppError('Fleet partner not found.', 404);
  return ok(res, { fleet: f, vehicles: f.vehicles.map((v) => ({ ...v, compliance: vehicleCompliance(v) })) });
};

/** Cross-fleet vehicle register for Runserv staff (blueprint §7 "Vehicles"). Each row carries its compliance verdict. */
exports.listVehicles = async (req, res) => {
  const where = {
    ...(req.query.status && { status: req.query.status }),
    ...(req.query.vehicleType && { vehicleType: req.query.vehicleType }),
    ...(req.query.fleetPartnerId && { fleetPartnerId: req.query.fleetPartnerId }),
    ...(req.query.q && { OR: [{ registrationNumber: { contains: req.query.q, mode: 'insensitive' } }, { make: { contains: req.query.q, mode: 'insensitive' } }, { model: { contains: req.query.q, mode: 'insensitive' } }] }),
  };
  const limit = take(req); const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const [rows, total] = await Promise.all([
    prisma.fleetVehicle.findMany({ where, take: limit, skip: (page - 1) * limit, orderBy: { createdAt: 'desc' }, include: { documents: true, fleetPartner: { select: { id: true, legalName: true, tradingName: true, status: true } } } }),
    prisma.fleetVehicle.count({ where }),
  ]);
  let vehicles = rows.map((v) => ({ ...v, compliance: vehicleCompliance(v) }));
  // Applied after the page is read (compliance is computed, not stored): narrows this page only.
  if (req.query.compliance === 'blocked') vehicles = vehicles.filter((v) => v.compliance.blockers.length > 0);
  return ok(res, { total, page, pages: Math.max(Math.ceil(total / limit), 1), vehicles });
};

exports.setStatus = async (req, res) => {
  const f = await prisma.fleetPartner.findUnique({ where: { id: req.params.id } });
  if (!f) throw new AppError('Fleet partner not found.', 404);
  const to = req.body.status;
  if (to === 'ACTIVE' && f.verificationStatus !== 'VERIFIED') throw new AppError('Verify the fleet organisation before activating it.', 400);
  const row = await prisma.fleetPartner.update({ where: { id: f.id }, data: { status: to } });
  // Suspending a fleet ends its drivers' ability to take jobs (the dispatch gate reads fleet status).
  await logActivity({ userId: req.user.id, action: `fleet_status_${to.toLowerCase()}`, entityType: 'FleetPartner', entityId: f.id, details: { from: f.status, to, reason: req.body.reason }, req });
  return ok(res, { fleetPartner: row });
};

exports.setVerification = async (req, res) => {
  const f = await prisma.fleetPartner.findUnique({ where: { id: req.params.id } });
  if (!f) throw new AppError('Fleet partner not found.', 404);
  const s = req.body.status;
  const row = await prisma.fleetPartner.update({ where: { id: f.id }, data: { verificationStatus: s, verificationNotes: req.body.notes ?? null, verifiedById: s === 'VERIFIED' ? req.user.id : null, verifiedAt: s === 'VERIFIED' ? new Date() : null } });
  await logActivity({ userId: req.user.id, action: 'fleet_verification_set', entityType: 'FleetPartner', entityId: f.id, details: { from: f.verificationStatus, to: s }, req });
  return ok(res, { fleetPartner: row });
};

exports.setCommercialTerms = async (req, res) => {
  const f = await prisma.fleetPartner.findUnique({ where: { id: req.params.id } });
  if (!f) throw new AppError('Fleet partner not found.', 404);
  const data = {};
  if (req.body.commissionRate !== undefined) data.commissionRate = req.body.commissionRate;
  if (req.body.settlementTermsDays !== undefined) data.settlementTermsDays = req.body.settlementTermsDays;
  const row = await prisma.fleetPartner.update({ where: { id: f.id }, data });
  await logActivity({ userId: req.user.id, action: 'fleet_terms_changed', entityType: 'FleetPartner', entityId: f.id, details: { before: { commissionRate: f.commissionRate, settlementTermsDays: f.settlementTermsDays }, after: data, note: req.body.note }, req });
  return ok(res, { fleetPartner: row });
};

exports.setVehicleStatus = async (req, res) => {
  const v = await prisma.fleetVehicle.findUnique({ where: { id: req.params.id }, include: { fleetPartner: true, documents: true } });
  if (!v) throw new AppError('Vehicle not found.', 404);
  const to = req.body.status;
  if (to === 'ACTIVE') {
    const c = vehicleCompliance(v, { strict: true });   // approved document records, not typed expiry dates
    if (c.blockers.length) throw new AppError(`Cannot activate: ${c.blockers.join('; ')}.`, 400);
  }
  const row = await prisma.fleetVehicle.update({ where: { id: v.id }, data: { status: to } });
  await logActivity({ userId: req.user.id, action: `fleet_vehicle_${to.toLowerCase()}`, entityType: 'FleetVehicle', entityId: v.id, details: { from: v.status, to, reason: req.body.reason, fleetPartnerId: v.fleetPartnerId }, req });
  return ok(res, { vehicle: row });
};

exports.reviewDocument = async (req, res) => {
  const d = await prisma.fleetPartnerDocument.findUnique({ where: { id: req.params.id } });
  if (!d) throw new AppError('Document not found.', 404);
  const approve = req.body.approved === true;
  if (!approve && !req.body.note) throw new AppError('A rejection note is required.', 400);
  // Insurance / roadworthiness / permit proof is only as good as its expiry date: refuse to approve one without it.
  if (approve && ['insurance', 'roadworthy', 'permit'].includes(String(d.documentType || '').trim().toLowerCase()) && !d.expiresAt) {
    throw new AppError('This document has no expiry date. Ask the fleet to re-upload it with one before approving.', 400);
  }
  const row = await prisma.fleetPartnerDocument.update({ where: { id: d.id }, data: { isApproved: approve, verifiedAt: approve ? new Date() : null, verifiedById: req.user.id, rejectionNote: approve ? null : req.body.note } });
  await logActivity({ userId: req.user.id, action: approve ? 'fleet_document_approved' : 'fleet_document_rejected', entityType: 'FleetPartnerDocument', entityId: d.id, details: { fleetPartnerId: d.fleetPartnerId, documentType: d.documentType }, req });
  return ok(res, { document: row });
};

exports.listSettlements = async (req, res) => {
  const where = { ...(req.query.status && { status: req.query.status }), ...(req.query.fleetPartnerId && { fleetPartnerId: req.query.fleetPartnerId }) };
  return ok(res, { settlements: await prisma.fleetSettlement.findMany({ where, orderBy: { createdAt: 'desc' }, take: take(req), include: { fleetPartner: { select: { id: true, legalName: true } } } }) });
};

exports.createSettlement = async (req, res) => {
  const r = await fleet.createSettlement({ fleetPartnerId: req.body.fleetPartnerId, periodStart: req.body.periodStart, periodEnd: req.body.periodEnd, adjustments: req.body.adjustments ?? 0, actor: req.user.id, req });
  return ok(res, r, 201);
};

exports.transitionSettlement = async (req, res) => {
  const row = await fleet.transitionSettlement({ id: req.params.id, to: req.body.status, actor: req.user.id, req, evidence: req.body.status === 'PAID' ? { paymentReference: req.body.paymentReference, paymentMethod: req.body.paymentMethod, paidAmount: req.body.paidAmount, paymentProofRef: req.body.paymentProofRef, paymentNote: req.body.paymentNote } : null });
  return ok(res, { settlement: row });
};

// Reconciliation: completed trips by fleet drivers vs FleetTrip rows (missing / amount mismatch). Read-only.
exports.outboxStats = async (req, res) => ok(res, await require('../services/outbox.service').stats());
exports.reconcileTrips = async (req, res) => ok(res, await reconcile.findMissingFleetTrips({ since: req.query.since, until: req.query.until, limit: req.query.limit, cursor: req.query.cursor }));
// Audited, idempotent repair of MISSING trips only (amount mismatches are reported, never auto-changed).
exports.repairTrips = async (req, res) => ok(res, await reconcile.repairMissingFleetTrips({ since: req.body.since, until: req.body.until, actor: req.user.id, req }));
