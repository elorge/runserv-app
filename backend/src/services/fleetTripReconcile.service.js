// backend/src/services/fleetTripReconcile.service.js
//
// FleetTrip reconciliation + audited repair (Launch Readiness Guide §4.1).
//
// recordFleetTrip() runs AFTER a ride/delivery completes and is deliberately non-fatal: if it fails, the trip is completed and
// paid but the fleet never sees it, and a log line is the only trace. This service closes that gap WITHOUT a schema change:
//   * findMissingFleetTrips()  – compares eligible COMPLETED rides/deliveries with FleetTrip rows (missing / amount-mismatch)
//   * repairMissingFleetTrips() – re-records the missing ones. recordFleetTrip is idempotent per ride/delivery (and the
//                                 unique rideId / deliveryId columns are the final guard), so repair can be re-run safely.
// The fleet that earns the trip is the one whose assignment was ACTIVE for that driver AT COMPLETION TIME, not "now".
//
// NOT done here (needs a design decision + migration): a transactional outbox written in the same DB transaction as the
// completion. This reconciliation is the safety net until then; run it on a schedule and alert on a non-empty result.
'use strict';

const prisma = require('../lib/prisma');
const { toMinor } = require('../utils/money');
const { logActivity } = require('../utils/auditLog');
const { AppError } = require('../middleware/errorHandler');

const MAX_WINDOW_DAYS = 31;

const parseWindow = ({ since, until }) => {
  const end = until ? new Date(until) : new Date();
  const start = since ? new Date(since) : new Date(end.getTime() - 24 * 3600 * 1000);
  // M12: Number.isNaN(<Date>) is always false (no coercion), so an invalid date used to reach Prisma and surface as a 500.
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new AppError('since/until must be valid dates.', 400);
  if (end <= start) throw new AppError('until must be after since.', 400);
  if (end - start > MAX_WINDOW_DAYS * 86400000) throw new AppError(`Window may not exceed ${MAX_WINDOW_DAYS} days.`, 400);
  return { start, end };
};

/**
 * Every assignment that covered `at` for this driver, most recently started first (ties broken by id so the order is stable).
 * Pure; exported for tests.
 */
const assignmentsCovering = (assignments, driverUserId, at) => {
  const t = new Date(at).getTime();
  return assignments
    .filter((a) => a.driverUserId === driverUserId && new Date(a.startsAt).getTime() <= t && (!a.endsAt || new Date(a.endsAt).getTime() >= t))
    .sort((x, y) => (new Date(y.startsAt).getTime() - new Date(x.startsAt).getTime()) || String(x.id).localeCompare(String(y.id)));
};

/**
 * The assignment that covered `at`. M12: deterministic (latest start wins) instead of "whichever the database returned first".
 * Returns null when none; `ambiguous` is true when more than one covered the moment (overlapping history), in which case the
 * caller must report it for a human rather than silently pick a fleet to pay.
 */
const assignmentAt = (assignments, driverUserId, at) => {
  const all = assignmentsCovering(assignments, driverUserId, at);
  if (!all.length) return null;
  const distinctFleets = new Set(all.map((a) => a.fleetPartnerId));
  const distinctVehicles = new Set(all.map((a) => a.vehicleId));
  // M13: overlapping assignments that differ by fleet OR vehicle make attribution uncertain.
  return Object.assign({}, all[0], { ambiguous: all.length > 1 && (distinctFleets.size > 1 || distinctVehicles.size > 1) });
};

/**
 * @returns {{ window, checked:number, scanned:{rides:number,deliveries:number}, truncated:boolean, nextSince:Date|null,
 *             missing:object[], amountMismatch:object[], fieldMismatch:object[], ambiguous:object[] }}
 *   missing        – completed trips by fleet drivers that have NO FleetTrip
 *   amountMismatch – FleetTrip.fareAmount differs from the completed ride/delivery's actual fare (minor-unit comparison)
 *   fieldMismatch  – (M12) currency, fleet partner, vehicle or service type differs from what the assignment/trip implies
 *   ambiguous      – (M12) trips covered by overlapping assignments of DIFFERENT fleets; never auto-repaired
 *   truncated      – (M12) the scan hit the row limit. The result is INCOMPLETE: re-run with since=nextSince until false.
 */
/** M13: stable composite cursor "<ISO completedAt>|<id>" — resume strictly AFTER that (time, id) pair, so rows sharing a timestamp are neither repeated nor skipped. */
const parseCursor = (c) => {
  if (c === undefined || c === null || c === '') return null;
  const i = String(c).lastIndexOf('|');
  const t = new Date(String(c).slice(0, i));
  if (i < 1 || !Number.isFinite(t.getTime()) || i === String(c).length - 1) throw new AppError('cursor is not valid.', 400);
  return { t, id: String(c).slice(i + 1) };
};
const keyCmp = (aT, aId, bT, bId) => (new Date(aT).getTime() - new Date(bT).getTime()) || (String(aId) < String(bId) ? -1 : String(aId) > String(bId) ? 1 : 0);
const afterCursor = (field, cur) => (cur ? { AND: [{ OR: [{ [field]: { gt: cur.t } }, { [field]: cur.t, id: { gt: cur.id } }] }] } : {});

const findMissingFleetTrips = async ({ since, until, limit = 500, cursor } = {}) => {
  const cur = parseCursor(cursor);
  const { start, end } = parseWindow({ since, until });
  const take = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 2000);
  const empty = { window: { start, end }, checked: 0, scanned: { rides: 0, deliveries: 0 }, truncated: false, nextSince: null, nextCursor: null, missing: [], amountMismatch: [], fieldMismatch: [], ambiguous: [] };

  const assignments = await prisma.fleetDriverAssignment.findMany({
    where: { startsAt: { lt: end }, OR: [{ endsAt: null }, { endsAt: { gte: start } }] },
    select: { id: true, fleetPartnerId: true, vehicleId: true, driverUserId: true, startsAt: true, endsAt: true },
  });
  const driverIds = [...new Set(assignments.map((a) => a.driverUserId))];
  if (!driverIds.length) return empty;

  // Fetch take+1 so we can tell "exactly take rows" from "more rows exist"; oldest first so nextSince is a clean cursor.
  const [ridesAll, deliveriesAll] = await Promise.all([
    prisma.ride.findMany({ where: { status: 'COMPLETED', driverId: { in: driverIds }, completedAt: { gte: start, lt: end }, ...afterCursor('completedAt', cur) }, orderBy: [{ completedAt: 'asc' }, { id: 'asc' }], select: { id: true, driverId: true, actualFare: true, currency: true, completedAt: true }, take: take + 1 }),
    prisma.delivery.findMany({ where: { status: 'DELIVERED', partnerId: { in: driverIds }, deliveredAt: { gte: start, lt: end }, ...afterCursor('deliveredAt', cur) }, orderBy: [{ deliveredAt: 'asc' }, { id: 'asc' }], select: { id: true, partnerId: true, actualFee: true, currency: true, deliveredAt: true }, take: take + 1 }),
  ]);
  const ridesTrunc = ridesAll.length > take; const delTrunc = deliveriesAll.length > take;
  const rides = ridesTrunc ? ridesAll.slice(0, take) : ridesAll;
  const deliveries = delTrunc ? deliveriesAll.slice(0, take) : deliveriesAll;
  const truncated = ridesTrunc || delTrunc;
  // Cut every list at the earliest "last seen" (time, id) of a truncated list so nothing after that point is half-scanned.
  const cuts = [];
  if (ridesTrunc) cuts.push({ t: rides[rides.length - 1].completedAt, id: rides[rides.length - 1].id });
  if (delTrunc) cuts.push({ t: deliveries[deliveries.length - 1].deliveredAt, id: deliveries[deliveries.length - 1].id });
  const cutoff = cuts.length ? cuts.reduce((m, c) => (keyCmp(c.t, c.id, m.t, m.id) < 0 ? c : m)) : null;
  const inScan = (d, id) => cutoff === null || keyCmp(d, id, cutoff.t, cutoff.id) <= 0;

  const candidates = [
    ...rides.map((r) => ({ serviceType: 'RIDE', rideId: r.id, deliveryId: null, driverUserId: r.driverId, fare: r.actualFare, currency: r.currency, completedAt: r.completedAt })),
    ...deliveries.map((d) => ({ serviceType: 'DELIVERY', rideId: null, deliveryId: d.id, driverUserId: d.partnerId, fare: d.actualFee, currency: d.currency, completedAt: d.deliveredAt })),
  ].filter((c) => c.completedAt && c.fare !== null && c.fare !== undefined && inScan(c.completedAt, c.rideId || c.deliveryId));

  const rideIds = candidates.map((c) => c.rideId).filter(Boolean);
  const deliveryIds = candidates.map((c) => c.deliveryId).filter(Boolean);
  const existing = (rideIds.length || deliveryIds.length) ? await prisma.fleetTrip.findMany({
    where: { OR: [rideIds.length ? { rideId: { in: rideIds } } : null, deliveryIds.length ? { deliveryId: { in: deliveryIds } } : null].filter(Boolean) },
    select: { id: true, rideId: true, deliveryId: true, fareAmount: true, fleetPartnerId: true, vehicleId: true, serviceType: true, currency: true },
  }) : [];
  const byKey = new Map(existing.map((t) => [t.rideId ? `r:${t.rideId}` : `d:${t.deliveryId}`, t]));

  const missing = []; const amountMismatch = []; const fieldMismatch = []; const ambiguous = [];
  for (const c of candidates) {
    const a = assignmentAt(assignments, c.driverUserId, c.completedAt);
    if (!a) continue;                                   // not a fleet trip at the time it completed
    if (a.ambiguous) { ambiguous.push({ rideId: c.rideId, deliveryId: c.deliveryId, driverUserId: c.driverUserId, completedAt: c.completedAt, note: 'Overlapping assignments for different fleets; resolve the assignment history by hand.' }); continue; }
    const t = byKey.get(c.rideId ? `r:${c.rideId}` : `d:${c.deliveryId}`);
    if (!t) { missing.push({ ...c, fleetPartnerId: a.fleetPartnerId, vehicleId: a.vehicleId }); continue; }
    if (toMinor(t.fareAmount) !== toMinor(c.fare)) amountMismatch.push({ fleetTripId: t.id, rideId: c.rideId, deliveryId: c.deliveryId, recordedFare: String(t.fareAmount), actualFare: String(c.fare) });
    const diffs = [];
    if (c.currency && t.currency && c.currency !== t.currency) diffs.push({ field: 'currency', recorded: t.currency, expected: c.currency });
    if (t.fleetPartnerId !== a.fleetPartnerId) diffs.push({ field: 'fleetPartnerId', recorded: t.fleetPartnerId, expected: a.fleetPartnerId });
    if (t.vehicleId !== a.vehicleId) diffs.push({ field: 'vehicleId', recorded: t.vehicleId, expected: a.vehicleId });
    if (t.serviceType !== c.serviceType) diffs.push({ field: 'serviceType', recorded: t.serviceType, expected: c.serviceType });
    if (diffs.length) fieldMismatch.push({ fleetTripId: t.id, rideId: c.rideId, deliveryId: c.deliveryId, diffs });
  }
  return {
    window: { start, end }, checked: candidates.length, scanned: { rides: rides.length, deliveries: deliveries.length },
    truncated, nextSince: truncated ? new Date(cutoff.t) : null, nextCursor: truncated ? `${new Date(cutoff.t).toISOString()}|${cutoff.id}` : null, missing, amountMismatch, fieldMismatch, ambiguous,
  };
};

/**
 * Re-record every missing FleetTrip found for the window. Idempotent and audited. Amount mismatches are REPORTED only:
 * correcting a recorded fare changes money owed to a fleet and needs a human decision.
 */
const repairMissingFleetTrips = async ({ since, until, actor, req, record }) => {
  const fleetService = record ? null : require('./fleet.service');
  const doRecord = record || ((args) => fleetService.recordFleetTrip(args));
  const found = await findMissingFleetTrips({ since, until });
  let repaired = 0; const failed = [];
  for (const m of found.missing) {
    try {
      const row = await doRecord({ serviceType: m.serviceType, rideId: m.rideId, deliveryId: m.deliveryId, driverUserId: m.driverUserId, fare: m.fare, currency: m.currency, completedAt: m.completedAt, asOf: m.completedAt });
      if (row) repaired += 1;
    } catch (e) { failed.push({ rideId: m.rideId, deliveryId: m.deliveryId, error: String(e.message || e).slice(0, 200) }); }
  }
  await logActivity({ userId: actor, action: 'fleet_trip_reconciliation_repair', entityType: 'FleetTrip', entityId: 'reconciliation', details: { window: found.window, missing: found.missing.length, repaired, failed: failed.length, amountMismatch: found.amountMismatch.length, fieldMismatch: found.fieldMismatch.length, ambiguous: found.ambiguous.length, truncated: found.truncated }, req });
  return { ...found, repaired, failed };
};

module.exports = { parseCursor, findMissingFleetTrips, repairMissingFleetTrips, assignmentAt, assignmentsCovering, parseWindow, MAX_WINDOW_DAYS };
