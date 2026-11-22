// backend/src/services/emailQuota.service.js
//
// M16.1 §13: deterministic two-provider quota routing. Brevo takes the first BREVO_DAILY_ALLOCATION sends of the quota window (300),
// Resend the next RESEND_DAILY_ALLOCATION (100); beyond that jobs stay queued. The counters live in PostgreSQL (EmailQuotaWindow) and
// a slot is taken with ONE conditional UPDATE (`reserved < allocation`), so parallel workers on several instances cannot oversell.
//   reserved  slots taken (released again if the provider certainly did not accept the message)
//   accepted  provider accepted the message. Delivery / bounce webhooks never touch these counters.
'use strict';
const prisma = require('../lib/prisma');
const providers = require('./emailProviders.service');

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d; };
const truthy = (v) => String(v || '').toLowerCase() === 'true';

function config(env = process.env) {
  return {
    routing: env.EMAIL_PROVIDER_ROUTING || 'quota_tiered',
    allocation: { brevo: num(env.BREVO_DAILY_ALLOCATION, 300), resend: num(env.RESEND_DAILY_ALLOCATION, 100) },
    hardCap: num(env.EMAIL_SEND_HARD_CAP, 400),
    timezone: env.EMAIL_QUOTA_WINDOW_TIMEZONE || 'UTC',
    // Conservative: the window boundary is moved LATER by this many minutes, never earlier, so counters are never reset early.
    resetOffsetMinutes: num(env.EMAIL_QUOTA_RESET_OFFSET_MINUTES, 60),
    failover: env.EMAIL_FAILOVER_ON_TRANSIENT_ERROR === undefined ? true : truthy(env.EMAIL_FAILOVER_ON_TRANSIENT_ERROR),
  };
}

/** "2026-11-22"-style key of the quota window containing `now` (a Date or ms). */
function windowKey(now = Date.now(), env = process.env) {
  const c = config(env);
  const t = new Date(new Date(now).getTime() - c.resetOffsetMinutes * 60000);
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: c.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t); }
  catch { return t.toISOString().slice(0, 10); }
}

/** When the current window ends (the next time the key changes). Scans hours, then minutes. */
function nextResetAt(now = Date.now(), env = process.env) {
  const key = windowKey(now, env); let t = new Date(now).getTime();
  for (let i = 0; i < 26; i += 1) { if (windowKey(t + 3600000, env) !== key) break; t += 3600000; }
  for (let i = 0; i < 61; i += 1) { t += 60000; if (windowKey(t, env) !== key) return new Date(t); }
  return new Date(t);
}

async function ensureRow(provider, key) {
  const where = { provider_windowKey: { provider, windowKey: key } };
  const row = await prisma.emailQuotaWindow.findUnique({ where });
  if (row) return row;
  try { return await prisma.emailQuotaWindow.create({ data: { provider, windowKey: key } }); }
  catch (e) { if (e?.code === 'P2002') return prisma.emailQuotaWindow.findUnique({ where }); throw e; }
}

async function isPaused(provider) { const c = await prisma.emailProviderControl.findUnique({ where: { provider } }); return !!c?.paused; }

/**
 * Take one slot from `provider`. Returns { ok: true, key } or { ok: false, reason } with reason one of
 * DISABLED | PAUSED | EXHAUSTED (provider said so) | UNHEALTHY | ALLOCATION_EXHAUSTED | HARD_CAP.
 */
async function reserve(provider, { now = Date.now(), env = process.env } = {}) {
  const c = config(env);
  if (!providers.isEnabled(provider, env) || !providers.isConfigured(provider, env)) return { ok: false, reason: 'DISABLED' };
  if (await isPaused(provider)) return { ok: false, reason: 'PAUSED' };
  const key = windowKey(now, env);
  const row = await ensureRow(provider, key);
  if (row.exhaustedAt) return { ok: false, reason: 'EXHAUSTED' };
  if (row.unhealthyUntil && new Date(row.unhealthyUntil).getTime() > new Date(now).getTime()) return { ok: false, reason: 'UNHEALTHY' };
  const alloc = c.allocation[provider];
  // THE arbitration: one conditional update. Two workers at 299/300 cannot both succeed.
  const got = await prisma.emailQuotaWindow.updateMany({ where: { provider, windowKey: key, reserved: { lt: alloc }, exhaustedAt: null }, data: { reserved: { increment: 1 } } });
  if (got.count !== 1) return { ok: false, reason: 'ALLOCATION_EXHAUSTED' };
  // Overall ceiling (EMAIL_SEND_HARD_CAP): checked after the take, released straight away if it would be exceeded (never sent).
  const rows = await prisma.emailQuotaWindow.findMany({ where: { windowKey: key } });
  if (rows.reduce((s, r) => s + r.reserved, 0) > c.hardCap) { await release(provider, key); return { ok: false, reason: 'HARD_CAP' }; }
  const after = alloc && (await prisma.emailQuotaWindow.findUnique({ where: { provider_windowKey: { provider, windowKey: key } } }));
  if (after && [Math.ceil(alloc * 0.8), alloc].includes(after.reserved)) console.warn(`[email-quota] ${provider} has used ${after.reserved}/${alloc} of today's Runserv allocation`);
  return { ok: true, key };
}

/** Give a slot back (the provider certainly did not accept the message). */
async function release(provider, key) { await prisma.emailQuotaWindow.updateMany({ where: { provider, windowKey: key, reserved: { gt: 0 } }, data: { reserved: { decrement: 1 } } }); }
async function markAccepted(provider, key) { await ensureRow(provider, key); await prisma.emailQuotaWindow.updateMany({ where: { provider, windowKey: key }, data: { accepted: { increment: 1 } } }); }
/** The provider itself said its quota is used up: stop calling it for the rest of the window. */
async function markExhausted(provider, key, now = new Date()) { await ensureRow(provider, key); await prisma.emailQuotaWindow.updateMany({ where: { provider, windowKey: key, exhaustedAt: null }, data: { exhaustedAt: now } }); }
async function markUnhealthy(provider, key, ms, now = Date.now()) { await ensureRow(provider, key); await prisma.emailQuotaWindow.updateMany({ where: { provider, windowKey: key }, data: { unhealthyUntil: new Date(now + ms) } }); }

/**
 * Decide where a NEW job goes. Returns { provider, key, reason } or { none: true, reason }.
 * reason: BREVO_ALLOCATION | BREVO_ALLOCATION_EXHAUSTED | BREVO_QUOTA_RESPONSE | BREVO_PAUSED | BREVO_DISABLED | TRANSIENT_FALLBACK
 */
async function route({ now = Date.now(), env = process.env } = {}) {
  const c = config(env);
  const b = await reserve('brevo', { now, env });
  if (b.ok) return { provider: 'brevo', key: b.key, reason: 'BREVO_ALLOCATION' };
  if (c.routing !== 'quota_tiered') return { none: true, reason: `BREVO_${b.reason}` };
  if (b.reason === 'HARD_CAP') return { none: true, reason: 'HARD_CAP' };
  let reason;
  if (b.reason === 'ALLOCATION_EXHAUSTED') reason = 'BREVO_ALLOCATION_EXHAUSTED';
  else if (b.reason === 'EXHAUSTED') reason = 'BREVO_QUOTA_RESPONSE';
  else if (b.reason === 'PAUSED') reason = 'BREVO_PAUSED';
  else if (b.reason === 'DISABLED') reason = 'BREVO_DISABLED';
  else { if (!c.failover) return { none: true, reason: 'BREVO_UNHEALTHY' }; reason = 'TRANSIENT_FALLBACK'; }   // UNHEALTHY: availability fallback, consumes a Resend slot
  const r = await reserve('resend', { now, env });
  if (r.ok) return { provider: 'resend', key: r.key, reason };
  return { none: true, reason: `NO_CAPACITY(${r.reason})` };
}

/** Admin view: today's usage per provider, active tier, reset time. */
async function usage({ now = Date.now(), env = process.env } = {}) {
  const c = config(env); const key = windowKey(now, env);
  const out = [];
  for (const p of providers.PROVIDERS) {
    const row = await prisma.emailQuotaWindow.findUnique({ where: { provider_windowKey: { provider: p, windowKey: key } } });
    const alloc = c.allocation[p]; const reserved = row?.reserved || 0;
    out.push({
      provider: p, enabled: providers.isEnabled(p, env) && providers.isConfigured(p, env), paused: await isPaused(p),
      allocation: alloc, reserved, accepted: row?.accepted || 0, remaining: Math.max(0, alloc - reserved),
      quotaExhausted: !!row?.exhaustedAt, unhealthy: !!(row?.unhealthyUntil && new Date(row.unhealthyUntil).getTime() > now),
      percentUsed: alloc ? Math.round((reserved / alloc) * 100) : 0,
    });
  }
  const brevo = out[0];
  const activeTier = brevo.enabled && !brevo.paused && !brevo.quotaExhausted && brevo.remaining > 0 ? 'brevo' : 'resend';
  return { windowKey: key, timezone: c.timezone, resetAt: nextResetAt(now, env), hardCap: c.hardCap, activeTier, providers: out };
}

const setPaused = async (provider, paused, by) => {
  if (!providers.PROVIDERS.includes(provider)) throw Object.assign(new Error('Unknown provider'), { statusCode: 400 });
  const data = { paused: !!paused, pausedAt: paused ? new Date() : null, pausedBy: paused ? by || null : null };
  const row = await prisma.emailProviderControl.findUnique({ where: { provider } });
  if (row) await prisma.emailProviderControl.update({ where: { provider }, data }); else await prisma.emailProviderControl.create({ data: { provider, ...data } });
};

module.exports = { config, windowKey, nextResetAt, reserve, release, markAccepted, markExhausted, markUnhealthy, route, usage, setPaused, isPaused };
