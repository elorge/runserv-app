// backend/src/services/fleetTripMonitor.service.js — scheduled safety net for fleet trips (runs from server startup).
// Every FLEET_TRIP_SCAN_MINUTES (default 15) it: (1) scans recently completed trips of fleet drivers for ones that never reached FleetTrip and re-records them
// (idempotent, audited); (2) raises an ops alert when anything needed repair, could not be repaired, or looks wrong (fare/field mismatch, ambiguous
// assignment); (3) raises a CRITICAL alert for dead-letter outbox events (completion events that exhausted their retries).
'use strict';
const prisma = require('../lib/prisma');
const { logger } = require('../utils/logger');
const recon = require('./fleetTripReconcile.service');

const HOUR = 3600 * 1000;
const alert = (a) => require('./opsAlert.service').raiseAndDeliver(a);

/** One scan. `graceMinutes` skips trips completed moments ago (the normal outbox path is still in flight). */
const scan = async ({ now = new Date(), lookbackHours = 48, graceMinutes = 10 } = {}) => {
  const until = new Date(now.getTime() - graceMinutes * 60000); const since = new Date(now.getTime() - lookbackHours * HOUR);
  const found = await recon.findMissingFleetTrips({ since, until });
  let repaired = 0; let failed = [];
  if (found.missing.length) { const r = await recon.repairMissingFleetTrips({ since, until, actor: null }); repaired = r.repaired; failed = r.failed; }
  const dead = await prisma.outboxEvent.count({ where: { status: 'DEAD', type: 'TRIP_COMPLETED' } });
  const problems = failed.length + found.amountMismatch.length + found.fieldMismatch.length + found.ambiguous.length;
  const summary = { checked: found.checked, missing: found.missing.length, repaired, failed: failed.length, amountMismatch: found.amountMismatch.length, fieldMismatch: found.fieldMismatch.length, ambiguous: found.ambiguous.length, truncated: found.truncated, deadLetters: dead };
  if (problems || dead) await alert({ kind: 'FLEET_TRIP_RECONCILIATION', severity: 'CRITICAL', dedupeKey: 'fleet-trip-reconciliation', title: 'Fleet trips need attention', message: `${failed.length} unrepaired, ${found.amountMismatch.length} fare mismatch, ${found.fieldMismatch.length} field mismatch, ${found.ambiguous.length} ambiguous, ${dead} dead-letter completion event(s). Open Fleets > Trip reconciliation.`, data: summary });
  else if (repaired) await alert({ kind: 'FLEET_TRIP_REPAIRED', severity: 'WARNING', dedupeKey: 'fleet-trip-repaired', title: 'Fleet trips were re-recorded', message: `${repaired} completed trip(s) had not reached the fleet's records and were repaired automatically. If this repeats, check the outbox worker.`, data: summary });
  return summary;
};

/** Disable with FLEET_TRIP_SCAN_ENABLED=false. */
const start = (log = logger, env = process.env) => {
  if (String(env.FLEET_TRIP_SCAN_ENABLED || 'true').toLowerCase() === 'false') return false;
  const minutes = Math.max(1, Number(env.FLEET_TRIP_SCAN_MINUTES) || 15);
  const t = setInterval(() => { scan().then((s) => { if (s.missing || s.deadLetters) log.warn(`[Cron] Fleet trip scan: ${JSON.stringify(s)}`); }).catch((e) => log.error('[Cron] Fleet trip scan failed: ' + e.message)); }, minutes * 60000);
  if (t.unref) t.unref();
  return true;
};
module.exports = { scan, start };
