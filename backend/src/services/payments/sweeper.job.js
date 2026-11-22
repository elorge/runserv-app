// backend/src/services/payments/sweeper.job.js
// Scheduler for collection.sweepPending(): re-checks long-pending provider payments so a lost callback never leaves money
// in limbo. Safe by construction — sweepPending() only reads provider status and applies compare-and-set transitions, and
// with no MoMo payments it is a single cheap query. An in-process lock stops overlapping runs on one instance; the
// transitions themselves are idempotent, so two instances running at once cannot double-settle.
'use strict';
const collection = require('./collection.service');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
let timer = null;
let running = false;

const runOnce = async (log = console) => {
  if (running) return { skipped: true };
  running = true;
  try {
    const r = await collection.sweepPending();
    if (r.checked) log.info?.(`[Cron] Payment sweeper: ${r.checked} checked, ${r.flagged} flagged, ${r.expired} expired`);
    return r;
  } catch (err) {
    log.error?.('[Cron] Payment sweeper error:', err.message);
    return { error: err.message };
  } finally { running = false; }
};

/** PAYMENT_SWEEPER_ENABLED=false turns it off (default on). PAYMENT_SWEEPER_INTERVAL_MS overrides the 5-minute period (min 30s). */
const start = (log = console) => {
  if (timer || String(process.env.PAYMENT_SWEEPER_ENABLED || 'true').toLowerCase() === 'false') return false;
  const ms = Math.max(30000, Number(process.env.PAYMENT_SWEEPER_INTERVAL_MS) || DEFAULT_INTERVAL_MS);
  timer = setInterval(() => runOnce(log), ms);
  timer.unref?.();
  return true;
};
const stop = () => { if (timer) clearInterval(timer); timer = null; };

module.exports = { start, stop, runOnce };
