// backend/src/services/fleet.service.js
'use strict';

const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { logActivity } = require('../utils/auditLog');
const { toMinor, fromMinor, splitFareMinor } = require('../utils/money');
const { dispatchEligibility, dispatchReasons, vehicleCompliance } = require('./fleetCompliance');
const { checkDriverVehicle } = require('./driverVehicleCompat');
const { licenceEnforced, checkLicence } = require('./driverLicence.service');
const { isCategoryEnabled } = require('../utils/vehicleCategories');

// Dispatch decisions are ALWAYS made from approved document records (strict), never from manually typed expiry dates.
const STRICT = { strict: true };
const coded = (message, status, code, details) => { const e = new AppError(message, status); e.code = code; if (details) e.details = details; return e; };
const DRIVER_INCLUDE = { driverProfile: true };

// ── Driver ↔ vehicle assignment ───────────────────────────────────────────────

/** The caller must have an approved Runserv driver profile: a fleet cannot bypass Runserv approval. */
const assertDriverApproved = async (driverUserId) => {
  const user = await prisma.user.findUnique({
    where: { id: driverUserId },
    select: { id: true, role: true, isActive: true, firstName: true, lastName: true, driverProfile: true },
  });
  if (!user || !user.isActive) throw new AppError('Driver not found.', 404);
  const p = user.driverProfile;
  if (!p) throw new AppError('This person has not applied as a Runserv driver. They must complete driver onboarding first.', 400);
  if (p.isRejected) throw new AppError('This driver was rejected by Runserv and cannot be linked to a fleet.', 403);
  if (!p.isApproved) throw new AppError('This driver is not yet approved by Runserv. Fleet linking does not replace driver verification.', 403);
  return user;
};

/**
 * Assign a driver to a fleet vehicle. Refuses: inactive fleet, vehicle of another fleet, vehicle that
 * is not dispatchable (suspended / expired documents), and any conflicting ACTIVE assignment for the
 * vehicle or the driver. The partial unique indexes in prisma/sql/fleet_bank_partial_indexes.sql are
 * the final guard against races; their P2002 is mapped to the same 409.
 */
const assignDriver = async ({ fleetPartner, vehicleId, driverUserId, actor, req }) => {
  if (fleetPartner.status !== 'ACTIVE') throw new AppError('Your fleet account is not active yet.', 403);
  const vehicle = await prisma.fleetVehicle.findFirst({ where: { id: vehicleId, fleetPartnerId: fleetPartner.id }, include: { documents: true } });
  if (!vehicle) throw new AppError('Vehicle not found in your fleet.', 404);
  const elig = dispatchEligibility({ fleetPartner, vehicle }, STRICT);
  if (!elig.ok) throw coded(`This vehicle cannot be assigned: ${elig.reasons.join('; ')}.`, 409, 'VEHICLE_NOT_DISPATCHABLE', elig.reasons);
  const driver = await assertDriverApproved(driverUserId);
  const compat = checkDriverVehicle({ driver, vehicle, fleetPartner });
  if (!compat.ok) throw coded(`This driver cannot be assigned to this vehicle: ${compat.failures.map((f) => f.message).join(' ')}`, 409, compat.failures[0].code, compat.failures);

  const clash = await prisma.fleetDriverAssignment.findFirst({
    where: { status: 'ACTIVE', OR: [{ vehicleId }, { driverUserId }] },
    select: { vehicleId: true, driverUserId: true, fleetPartnerId: true },
  });
  if (clash) {
    const what = clash.vehicleId === vehicleId ? 'This vehicle already has an active driver.' : 'This driver already has an active vehicle assignment.';
    throw new AppError(what, 409);
  }
  let row;
  try {
    row = await prisma.fleetDriverAssignment.create({ data: { fleetPartnerId: fleetPartner.id, vehicleId, driverUserId, status: 'ACTIVE' } });
  } catch (e) {
    if (e.code === 'P2002') throw new AppError('This driver or vehicle already has an active assignment.', 409);
    throw e;
  }
  await logActivity({ userId: actor, action: 'fleet_driver_assigned', entityType: 'FleetDriverAssignment', entityId: row.id, details: { fleetPartnerId: fleetPartner.id, vehicleId, driverUserId }, req });
  return row;
};

const endAssignment = async ({ fleetPartnerId, assignmentId, actor, req, status = 'ENDED' }) => {
  const a = await prisma.fleetDriverAssignment.findFirst({ where: { id: assignmentId, fleetPartnerId } });
  if (!a) throw new AppError('Assignment not found.', 404);
  if (a.status !== 'ACTIVE') throw new AppError('This assignment is already closed.', 400);
  const active = await prisma.fleetTrip.findFirst({ where: { driverUserId: a.driverUserId, vehicleId: a.vehicleId, status: { in: ['ACCEPTED', 'IN_PROGRESS'] } }, select: { id: true } });
  if (active) throw new AppError('The driver has a trip in progress. End the assignment after it completes.', 409);
  const row = await prisma.fleetDriverAssignment.update({ where: { id: assignmentId }, data: { status, endsAt: new Date() } });
  await logActivity({ userId: actor, action: 'fleet_driver_unassigned', entityType: 'FleetDriverAssignment', entityId: assignmentId, details: { fleetPartnerId, status }, req });
  return row;
};

// ── Dispatch gate (called when a driver goes online / accepts work) ──────────

/**
 * Non-fleet drivers pass untouched. A fleet-assigned driver may only work while the fleet is ACTIVE,
 * the vehicle is ACTIVE and its mandatory documents are valid (blueprint §4.5, §13).
 */
const assertDriverDispatchable = async (driverUserId, opts = {}) => {
  const a = await prisma.fleetDriverAssignment.findFirst({
    where: { driverUserId, status: 'ACTIVE' },
    include: { vehicle: { include: { documents: true } }, fleetPartner: true, driver: { include: DRIVER_INCLUDE } },
  });
  // M13: licence + category rules apply to EVERY driver, fleet or not. Couriers (no DriverProfile) are outside this rule.
  const category = a?.vehicle?.vehicleType;
  if (licenceEnforced() || process.env.ENABLED_VEHICLE_CATEGORIES) {
    const profile = a?.driver?.driverProfile ?? await prisma.driverProfile.findUnique({ where: { userId: driverUserId } });
    if (profile) {
      const cat = category || profile.vehicleType;
      if (!isCategoryEnabled(cat)) throw coded(`You cannot take new jobs: ${String(cat).toLowerCase()} service is not available yet.`, 403, 'VEHICLE_CATEGORY_DISABLED');
      if (licenceEnforced()) {
        const l = checkLicence({ profile, category: cat });
        if (!l.ok) throw coded(`You cannot take new jobs: ${l.failures.map((f) => f.message).join(' ')}`, 403, l.failures[0].code, l.failures);
      }
    }
  }
  if (!a) return { fleet: false };
  const elig = dispatchEligibility({ fleetPartner: a.fleetPartner, vehicle: a.vehicle }, { ...STRICT, ...opts });
  if (!elig.ok) throw coded(`You cannot take new jobs: ${elig.reasons.join('; ')}. Contact your fleet manager.`, 403, 'FLEET_NOT_DISPATCHABLE', elig.reasons);
  // Re-check driver <-> vehicle compatibility NOW. An old assignment alone is not trusted.
  const compat = checkDriverVehicle({ driver: a.driver, vehicle: a.vehicle, fleetPartner: a.fleetPartner });
  if (!compat.ok) throw coded(`You cannot take new jobs: ${compat.failures.map((f) => f.message).join(' ')} Contact your fleet manager.`, 403, compat.failures[0].code, compat.failures);
  return { fleet: true, fleetPartnerId: a.fleetPartnerId, vehicleId: a.vehicleId };
};

/**
 * Why can (or can't) this driver / courier take jobs right now? Powers the "why am I not receiving jobs"
 * screen. Read-only, scoped to the caller's own record, and exposes only what the driver may know:
 * fleet name and status, vehicle registration, document names and dates (never fares or other drivers).
 * `profile` is the driver's or courier's own approval record ({ isApproved, isRejected }) or null.
 */
const getDispatchStatus = async (driverUserId, { profile = null, opts } = {}) => {
  const reasons = [];
  if (!profile) reasons.push({ code: 'NO_PROFILE', fixedBy: 'DRIVER', message: 'Finish your onboarding to start receiving jobs.' });
  else if (profile.isRejected) reasons.push({ code: 'PROFILE_REJECTED', fixedBy: 'RUNSERV', message: 'Your application was not approved. Please contact support.' });
  else if (!profile.isApproved) reasons.push({ code: 'PROFILE_PENDING', fixedBy: 'RUNSERV', message: 'Your profile is still under review. You will be notified once approved.' });

  const a = await prisma.fleetDriverAssignment.findFirst({
    where: { driverUserId, status: 'ACTIVE' },
    include: { vehicle: { include: { documents: true } }, fleetPartner: true, driver: { include: DRIVER_INCLUDE } },
  });
  if (licenceEnforced()) {
    const dp = a?.driver?.driverProfile ?? await prisma.driverProfile.findUnique({ where: { userId: driverUserId } });
    if (dp) for (const f of checkLicence({ profile: dp, category: a?.vehicle?.vehicleType }).failures) reasons.push({ code: f.code, fixedBy: 'DRIVER', message: f.message });
  }
  if (!a) return { canTakeJobs: reasons.length === 0, isFleetDriver: false, fleet: null, vehicle: null, reasons, warnings: [] };

  const d = dispatchReasons({ fleetPartner: a.fleetPartner, vehicle: a.vehicle }, { ...STRICT, ...opts });
  reasons.push(...d.reasons);
  for (const f of checkDriverVehicle({ driver: a.driver, vehicle: a.vehicle, fleetPartner: a.fleetPartner }).failures) {
    if (!reasons.some((r) => r.code === f.code)) reasons.push({ code: f.code, fixedBy: 'FLEET', message: f.message });
  }
  return {
    canTakeJobs: reasons.length === 0,
    isFleetDriver: true,
    fleet: { name: a.fleetPartner.tradingName ?? a.fleetPartner.legalName ?? null, status: a.fleetPartner.status },
    vehicle: { registration: a.vehicle.registrationNumber ?? null, status: a.vehicle.status },
    reasons,
    warnings: d.warnings,
  };
};

// ── Trip recording (hook called after a ride/delivery is completed) ───────────

/**
 * If the earner is an active fleet driver, record a FleetTrip with the fleet's platform fee.
 * Idempotent per ride/delivery. Never throws into the caller's completion flow.
 */
const recordFleetTrip = async ({ serviceType, rideId = null, deliveryId = null, driverUserId, fare, currency = 'NGN', completedAt = new Date(), asOf = null }) => {
  const sourceKey = rideId ? { rideId } : { deliveryId };
  if (!rideId && !deliveryId) return null;
  const existing = await prisma.fleetTrip.findFirst({ where: sourceKey, select: { id: true } });
  if (existing) return existing;
  // Normal completion: the driver's ACTIVE assignment. Repair (asOf set): the assignment that covered that moment, even if it has ended since.
  let a;
  if (asOf) {
    // Repair: the assignment(s) that covered that moment. Never guess between conflicting ones (different fleet OR vehicle).
    const all = await prisma.fleetDriverAssignment.findMany({ where: { driverUserId, startsAt: { lte: new Date(asOf) }, OR: [{ endsAt: null }, { endsAt: { gte: new Date(asOf) } }] }, orderBy: [{ startsAt: 'desc' }, { id: 'asc' }], include: { fleetPartner: true } });
    if (all.length > 1 && (new Set(all.map((x) => x.fleetPartnerId)).size > 1 || new Set(all.map((x) => x.vehicleId)).size > 1)) return null;
    a = all[0];
  } else {
    a = await prisma.fleetDriverAssignment.findFirst({ where: { driverUserId, status: 'ACTIVE' }, include: { fleetPartner: true } });
  }
  if (!a) return null;
  const s = splitFareMinor(toMinor(fare), a.fleetPartner.commissionRate);
  try {
    return await prisma.fleetTrip.create({
      data: {
        fleetPartnerId: a.fleetPartnerId, driverUserId, vehicleId: a.vehicleId, serviceType, ...sourceKey,
        status: 'COMPLETED', fareAmount: fromMinor(s.fareMinor), platformFeeAmount: fromMinor(s.feeMinor), fleetNetAmount: fromMinor(s.netMinor),
        currency: a.fleetPartner.currency || currency, completedAt,
      },
    });
  } catch (e) {
    if (e.code === 'P2002') return null; // recorded concurrently
    throw e;
  }
};

// ── Settlements ───────────────────────────────────────────────────────────────

/** Pure: totals for a set of completed trips plus adjustments (all integer minor units). */
const summariseTrips = (trips, adjustmentsMinor = 0) => {
  let gross = 0; let fee = 0;
  for (const t of trips) { gross += toMinor(t.fareAmount); fee += toMinor(t.platformFeeAmount); }
  return { grossMinor: gross, feeMinor: fee, adjustmentsMinor, netMinor: gross - fee + adjustmentsMinor, tripCount: trips.length };
};

const conflict = (message, code) => { const e = new AppError(message, 409); e.code = code; return e; };

/**
 * Create a settlement statement for [periodStart, periodEnd). One statement per period: any non-cancelled statement
 * overlapping the period blocks creation, so a trip cannot be paid twice.
 *
 * Concurrency (guide §4.2): the overlap check and the insert run inside ONE transaction that first takes a
 * per-fleet Postgres advisory lock, so two simultaneous requests for the same fleet are serialised and the second
 * sees the first. `reference` (fleet + period, unique) doubles as the idempotency key: replaying the same request
 * returns the existing statement instead of creating a second one. prisma/sql/fleet_settlement_overlap.sql adds a
 * database exclusion constraint as the final guard.
 */
const createSettlement = async ({ fleetPartnerId, periodStart, periodEnd, adjustments = 0, actor, req }) => {
  const start = new Date(periodStart); const end = new Date(periodEnd);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new AppError('periodEnd must be after periodStart.', 400);
  const fleet = await prisma.fleetPartner.findUnique({ where: { id: fleetPartnerId } });
  if (!fleet) throw new AppError('Fleet partner not found.', 404);
  const reference = `FS-${fleetPartnerId.slice(0, 6).toUpperCase()}-${start.toISOString().slice(0, 10).replace(/-/g, '')}-${end.toISOString().slice(0, 10).replace(/-/g, '')}`;

  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      // Serialise settlement creation per fleet. Released automatically at commit/rollback.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'fleet-settlement:' + fleetPartnerId}))`;

      const same = await tx.fleetSettlement.findFirst({ where: { fleetPartnerId, reference } });
      if (same && same.status !== 'CANCELLED') return { settlement: same, idempotent: true };

      const overlap = await tx.fleetSettlement.findFirst({
        where: { fleetPartnerId, status: { not: 'CANCELLED' }, periodStart: { lt: end }, periodEnd: { gt: start } }, select: { id: true },
      });
      if (overlap) throw conflict('A settlement already covers part of this period.', 'SETTLEMENT_OVERLAP');

      const trips = await tx.fleetTrip.findMany({ where: { fleetPartnerId, status: 'COMPLETED', completedAt: { gte: start, lt: end } } });
      if (!trips.length) throw new AppError('No completed trips in this period.', 400);
      const t = summariseTrips(trips, toMinor(adjustments));
      if (t.netMinor < 0) throw new AppError('Net payable would be negative; resolve adjustments first.', 400);

      // A cancelled statement keeps its reference (unique); a re-issue gets a distinct suffix.
      const ref = same ? `${reference}-R${Date.now().toString(36)}` : reference;
      const row = await tx.fleetSettlement.create({
        data: {
          fleetPartnerId, periodStart: start, periodEnd: end, currency: fleet.currency,
          grossAmount: fromMinor(t.grossMinor), platformFeeAmount: fromMinor(t.feeMinor), adjustmentsAmount: fromMinor(t.adjustmentsMinor), netAmount: fromMinor(t.netMinor),
          reference: ref,
        },
      });
      return { settlement: row, tripCount: t.tripCount, idempotent: false };
    });
  } catch (e) {
    // Unique reference or the DB exclusion constraint (23P01) fired: another request won the race.
    const raced = e.code === 'P2002' || e.code === '23P01' || e.meta?.code === '23P01' || (e.code === 'P2010' && /23P01/.test(String(e.message || '')));
    if (raced) {
      throw conflict('A settlement already covers part of this period.', 'SETTLEMENT_OVERLAP');
    }
    throw e;
  }
  if (!result.idempotent) {
    await logActivity({ userId: actor, action: 'fleet_settlement_created', entityType: 'FleetSettlement', entityId: result.settlement.id, details: { fleetPartnerId, tripCount: result.tripCount, net: result.settlement.netAmount }, req });
  }
  return { settlement: result.settlement, tripCount: result.tripCount, idempotent: result.idempotent };
};

const SETTLEMENT_FLOW = { PENDING: ['RECONCILING', 'CANCELLED'], RECONCILING: ['APPROVED', 'DISPUTED', 'CANCELLED'], APPROVED: ['PAID', 'DISPUTED'], DISPUTED: ['RECONCILING', 'CANCELLED'], PAID: [], CANCELLED: [] };

/**
 * Move a settlement along PENDING → RECONCILING → APPROVED → PAID. Maker–checker: the admin who approved a statement
 * may not be the one who marks it paid (set FLEET_MAKER_CHECKER=off to disable on a single-admin deployment).
 *
 * Concurrency (guide §4.2): the write is a CONDITIONAL update (`WHERE id AND status = <status we validated against>`).
 * If another request already moved the record, zero rows change and we answer 409 instead of overwriting the newer state.
 */
const transitionSettlement = async ({ id, to, actor, req }) => {
  const s = await prisma.fleetSettlement.findUnique({ where: { id } });
  if (!s) throw new AppError('Settlement not found.', 404);
  if (!SETTLEMENT_FLOW[s.status]?.includes(to)) throw new AppError(`Cannot move a ${s.status} settlement to ${to}.`, 400);
  if (to === 'PAID' && process.env.FLEET_MAKER_CHECKER !== 'off') {
    const approval = await prisma.activityLog.findFirst({ where: { entityType: 'FleetSettlement', entityId: id, action: 'fleet_settlement_approved' }, orderBy: { createdAt: 'desc' }, select: { userId: true } });
    if (approval && approval.userId === actor) throw new AppError('A different admin must mark this settlement as paid (maker–checker).', 403);
  }
  const { count } = await prisma.fleetSettlement.updateMany({
    where: { id, status: s.status },
    data: { status: to, ...(to === 'PAID' && { paidAt: new Date() }) },
  });
  if (count !== 1) throw conflict('This settlement was changed by someone else. Reload and try again.', 'SETTLEMENT_STATE_CHANGED');
  const row = await prisma.fleetSettlement.findUnique({ where: { id } });
  await logActivity({ userId: actor, action: `fleet_settlement_${to.toLowerCase()}`, entityType: 'FleetSettlement', entityId: id, details: { from: s.status, to, fleetPartnerId: s.fleetPartnerId }, req });
  return row;
};

module.exports = { assertDriverApproved, assignDriver, endAssignment, assertDriverDispatchable, getDispatchStatus, recordFleetTrip, summariseTrips, createSettlement, transitionSettlement, SETTLEMENT_FLOW, vehicleCompliance };
