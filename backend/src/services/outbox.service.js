// backend/src/services/outbox.service.js
//
// M13 (roadmap Phase 3): TRANSACTIONAL OUTBOX. "Trip completed" is written to OutboxEvent INSIDE the same database transaction
// that completes the trip, so the fact can never be lost between "paid" and "recorded for the fleet". A worker then delivers it
// asynchronously with retry, exponential back-off and a dead-letter state; handlers are idempotent (recordFleetTrip is unique per
// ride/delivery). Reconciliation (fleetTripReconcile.service.js) stays as the independent safety net.
'use strict';

const prisma = require('../lib/prisma');
const { logActivity } = require('../utils/auditLog');

const MAX_ATTEMPTS = Number(process.env.OUTBOX_MAX_ATTEMPTS) || 8;
const STALE_PROCESSING_MS = 5 * 60 * 1000;
const backoffMs = (attempts) => Math.min(30000 * 2 ** Math.max(attempts - 1, 0), 60 * 60 * 1000);

const handlers = {
  TRIP_COMPLETED: async (p) => {
    const fleetService = require('./fleet.service');
    // null = not a fleet trip (or ambiguous attribution): nothing to record, which is a successful outcome.
    await fleetService.recordFleetTrip({ ...p, completedAt: new Date(p.completedAt) });
  },
};

/** Call INSIDE the completion transaction (`tx`). Idempotent per (type, aggregate). */
const enqueueTx = (tx, { type, aggregateType, aggregateId, payload }) => tx.outboxEvent.upsert({
  where: { type_aggregateType_aggregateId: { type, aggregateType, aggregateId } },
  create: { type, aggregateType, aggregateId, payload },
  update: {},
});

const tripCompletedPayload = ({ serviceType, rideId = null, deliveryId = null, driverUserId, fare, currency, completedAt }) => ({
  serviceType, ...(rideId && { rideId }), ...(deliveryId && { deliveryId }), driverUserId, fare: String(fare), currency, completedAt: new Date(completedAt).toISOString(),
});

/** Claim and run one event. Safe to call concurrently: the claim is a conditional update. */
const processEvent = async (id, now = new Date()) => {
  const claim = await prisma.outboxEvent.updateMany({
    where: { id, OR: [{ status: 'PENDING', nextAttemptAt: { lte: now } }, { status: 'PROCESSING', updatedAt: { lt: new Date(now.getTime() - STALE_PROCESSING_MS) } }] },
    data: { status: 'PROCESSING', attempts: { increment: 1 } },
  });
  if (claim.count !== 1) return { skipped: true };
  const ev = await prisma.outboxEvent.findUnique({ where: { id } });
  try {
    const h = handlers[ev.type];
    if (!h) throw new Error(`no handler for ${ev.type}`);
    await h(ev.payload);
    await prisma.outboxEvent.update({ where: { id }, data: { status: 'DONE', processedAt: new Date(), lastError: null } });
    return { done: true };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 500);
    if (ev.attempts >= MAX_ATTEMPTS) {
      await prisma.outboxEvent.update({ where: { id }, data: { status: 'DEAD', lastError: msg } });
      await logActivity({ userId: null, action: 'outbox_event_dead', entityType: 'OutboxEvent', entityId: id, details: { type: ev.type, aggregateId: ev.aggregateId, attempts: ev.attempts, error: msg } });
      return { dead: true };
    }
    await prisma.outboxEvent.update({ where: { id }, data: { status: 'PENDING', lastError: msg, nextAttemptAt: new Date(Date.now() + backoffMs(ev.attempts)) } });
    return { retry: true };
  }
};

/** Best-effort immediate delivery right after commit (keeps latency as before); the worker retries on failure. */
const processByKey = async (key) => {
  const ev = await prisma.outboxEvent.findUnique({ where: { type_aggregateType_aggregateId: key }, select: { id: true } });
  return ev ? processEvent(ev.id) : { skipped: true };
};

const processDue = async ({ limit = 25, now = new Date() } = {}) => {
  const due = await prisma.outboxEvent.findMany({
    where: { OR: [{ status: 'PENDING', nextAttemptAt: { lte: now } }, { status: 'PROCESSING', updatedAt: { lt: new Date(now.getTime() - STALE_PROCESSING_MS) } }] },
    orderBy: { createdAt: 'asc' }, take: limit, select: { id: true },
  });
  const r = { processed: 0, done: 0, retry: 0, dead: 0 };
  for (const { id } of due) {
    const o = await processEvent(id, now);
    if (o.skipped) continue;
    r.processed += 1; if (o.done) r.done += 1; if (o.retry) r.retry += 1; if (o.dead) r.dead += 1;
  }
  return r;
};

/** Backlog numbers + alert strings for the launch dashboard. */
const stats = async (now = new Date()) => {
  const [pending, processing, dead, oldest] = await Promise.all([
    prisma.outboxEvent.count({ where: { status: 'PENDING' } }), prisma.outboxEvent.count({ where: { status: 'PROCESSING' } }),
    prisma.outboxEvent.count({ where: { status: 'DEAD' } }),
    prisma.outboxEvent.findFirst({ where: { status: { in: ['PENDING', 'PROCESSING'] } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
  ]);
  const oldestAgeSeconds = oldest ? Math.floor((now.getTime() - new Date(oldest.createdAt).getTime()) / 1000) : 0;
  const alerts = [];
  if (dead > 0) alerts.push(`${dead} outbox event(s) are dead-lettered and need manual attention`);
  if (oldestAgeSeconds > 600) alerts.push(`Oldest unprocessed outbox event is ${Math.round(oldestAgeSeconds / 60)} minutes old`);
  return { pending, processing, dead, oldestAgeSeconds, alerts };
};

let timer = null;
const startWorker = ({ intervalMs = 15000 } = {}) => {
  if (timer || process.env.OUTBOX_WORKER === 'off') return null;
  let busy = false;
  timer = setInterval(async () => {
    if (busy) return; busy = true;
    try { await processDue(); } catch (e) { console.error('[outbox] worker error:', e.message); } finally { busy = false; }
  }, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
};
const stopWorker = () => { if (timer) { clearInterval(timer); timer = null; } };

module.exports = { enqueueTx, tripCompletedPayload, processEvent, processByKey, processDue, stats, startWorker, stopWorker, backoffMs, MAX_ATTEMPTS };
