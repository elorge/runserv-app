// backend/src/services/opsAlert.service.js
//
// M16.2.2: ACTIVE alert to the operations role when a recipient hand-over notification fails (action plan P1.4: "no alert is sent to an ops role").
// Until now a dead-lettered recipient email was only an Admin alert STRING and a work-list row: nobody was told. Now, at the moment a recipient
// notification fails permanently (email dead-letter, provider hard bounce / block, SMS dead-letter) or a hand-over code is locked:
//   1. an in-app notification is written for every active staff member who may act on deliveries in that market (SUPER_ADMIN, general ADMIN,
//      ADMIN of the DELIVERIES / SUPPORT department, SUPPORT), and pushed over the socket to staff who are connected;
//   2. optionally a webhook (OPS_ALERT_WEBHOOK_URL, https only, e.g. a chat channel) receives one short line;
//   3. an OPS_ALERT_SENT audit event records who was told, ONLY when a channel confirmed delivery (in-app notify succeeded / webhook 2xx);
//      otherwise OPS_ALERT_FAILED is audited.
// WP-08: every alert is now a DURABLE OpsAlert row (deduplicated per open dedupeKey) with OpsAlertDelivery rows per channel. A delivery is SENT
// only on confirmed delivery; the opsAlertWorker retries FAILED deliveries with backoff and escalates alerts that stay OPEN.
// Content is deliberately minimal: reference, channel, a failure CATEGORY and the next step. Never the code, the address, the phone number,
// the tracking link or provider error text. Alerting is best-effort and can never break the outbox worker or a courier request.
'use strict';
const prisma = require('../lib/prisma');
const { staffMarkets } = require('../utils/marketScope');

const TYPE = 'ops_recipient_handover_failed';
const MAX_STAFF = 50;
const WEBHOOK_TIMEOUT_MS = 5000;

/** Which staff may act on parcels in this market. Same rules as requireScope('DELIVERIES','SUPPORT') plus the market assignment. */
const staffWhere = () => ({ isActive: true, OR: [
  { role: 'SUPER_ADMIN' },
  { role: 'ADMIN', adminDepartment: null },
  { role: 'ADMIN', adminDepartment: { in: ['DELIVERIES', 'SUPPORT'] } },
  { role: 'SUPPORT' },
] });

const WHY = {
  EMAIL_DEAD: 'The recipient email could not be sent.',
  EMAIL_BOUNCED: 'The recipient email was rejected by the receiving mail server.',
  SMS_DEAD: 'The recipient SMS could not be sent.',
  CODE_LOCKED: 'The hand-over code is locked after too many wrong attempts.',
};
const NEXT = {
  EMAIL_DEAD: 'Check the recipient address with the sender, then resend or rotate the code.',
  EMAIL_BOUNCED: 'Confirm the recipient address with the sender, then resend or rotate the code.',
  SMS_DEAD: 'Confirm the recipient number with the sender, then resend or rotate the code.',
  CODE_LOCKED: 'Contact the courier and recipient, then rotate the code or follow the manual hand-over exception process.',
};

const enabled = (env = process.env) => String(env.OPS_ALERTS_ENABLED === undefined || env.OPS_ALERTS_ENABLED === '' ? 'true' : env.OPS_ALERTS_ENABLED).toLowerCase() !== 'false';

/** Market (country) of a booking or a registered delivery, for the staff filter. Null = unknown, which notifies unrestricted staff only. */
async function marketOf({ bookingId, deliveryId }) {
  if (bookingId) {
    const b = await prisma.guestBooking.findUnique({ where: { id: bookingId }, include: { identity: true } });
    return { reference: b?.reference || null, countryCode: b?.identity?.countryCode || null, deliveryId: deliveryId || b?.deliveryId || null };
  }
  if (deliveryId) {
    const gb = await prisma.guestBooking.findUnique({ where: { deliveryId }, include: { identity: true } });   // a guest parcel is reported by its booking reference
    if (gb) return { reference: gb.reference, countryCode: gb.identity?.countryCode || null, deliveryId, bookingId: gb.id };
    const d = await prisma.delivery.findUnique({ where: { id: deliveryId } });
    const cust = d?.customerId ? await prisma.user.findUnique({ where: { id: d.customerId } }) : null;
    return { reference: refOfDelivery(deliveryId), countryCode: cust?.countryCode || null, deliveryId };
  }
  return { reference: null, countryCode: null, deliveryId: null };
}

/** Registered parcels have no guest reference: a short, stable label derived from the delivery id (the Admin list shows the same one). */
const refOfDelivery = (id) => `PRCL-${String(id || '').replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase()}`;

const MAX_DELIVERY_ATTEMPTS = () => Number(process.env.OPS_ALERT_MAX_DELIVERY_ATTEMPTS) || 6;
const escalateMs = (env = process.env) => (Number(env.OPS_ALERT_ESCALATE_MINUTES) > 0 ? Number(env.OPS_ALERT_ESCALATE_MINUTES) : 30) * 60 * 1000;
const backoffMs = (attempts) => Math.min(30000 * 2 ** Math.max(attempts - 1, 0), 60 * 60 * 1000);

/** Webhook post. SENT only when the endpoint answered 2xx. Returns { status: SENT|FAILED|NOT_CONFIGURED|REJECTED_NOT_HTTPS, category }. */
const postWebhook = async (text, env) => {
  const url = String(env.OPS_ALERT_WEBHOOK_URL || '').trim();
  if (!url) return { status: 'NOT_CONFIGURED' };
  if (!/^https:\/\//i.test(url)) return { status: 'REJECTED_NOT_HTTPS' };
  try {
    const res = await require('axios').post(url, { text }, { timeout: WEBHOOK_TIMEOUT_MS, maxRedirects: 0 });
    const code = res && Number(res.status);
    if (code >= 200 && code < 300) return { status: 'SENT' };
    return { status: 'FAILED', category: `HTTP_${code || 'UNKNOWN'}` };
  } catch (e) {
    const category = e.response?.status ? `HTTP_${e.response.status}` : (e.code === 'ECONNABORTED' ? 'TIMEOUT' : (e.code || 'NETWORK'));
    console.error('[ops-alert] webhook failed:', category);
    return { status: 'FAILED', category: String(category).slice(0, 40) };
  }
};

const isP2002 = (e) => e && e.code === 'P2002';

/** Create the alert, or bump the occurrence counter of the open alert with the same dedupeKey. */
async function raise({ kind, dedupeKey, severity = 'WARNING', title, message, data = null }) {
  const bump = async (open) => {
    await prisma.opsAlert.update({ where: { id: open.id }, data: { occurrences: { increment: 1 }, lastSeenAt: new Date() } });
    return { alert: open, created: false };
  };
  const open = await prisma.opsAlert.findFirst({ where: { dedupeKey, status: { in: ['OPEN', 'ACKNOWLEDGED'] } }, orderBy: { createdAt: 'desc' } });
  if (open) return bump(open);
  try {
    const alert = await prisma.opsAlert.create({ data: { kind, dedupeKey, severity, title, message, data } });
    return { alert, created: true };
  } catch (e) {
    if (!isP2002(e)) throw e;            // lost a race with a concurrent identical alert
    const again = await prisma.opsAlert.findFirst({ where: { dedupeKey, status: { in: ['OPEN', 'ACKNOWLEDGED'] } } });
    if (!again) throw e;
    return bump(again);
  }
}

/** Raise an alert and, when it is newly opened, deliver round 0 (IN_APP + webhook). Repeats only bump the counter. */
async function raiseAndDeliver(input, opts = {}) {
  const out = await raise(input);
  if (out.created) { try { await deliverRound(out.alert, { round: 0, ...opts }); } catch (e) { console.error('[ops-alert] initial delivery failed, worker will retry:', e.message); } }
  return out;
}

const staffFor = async (countryCode, { unrestricted = false } = {}) => {
  const where = unrestricted ? { isActive: true, role: 'SUPER_ADMIN' } : staffWhere();
  const rows = await prisma.user.findMany({ where, select: { id: true, role: true, supportCountries: true }, take: 500 });
  return rows.filter((u) => { if (unrestricted) return true; const mk = staffMarkets(u); return mk.length === 0 || (countryCode && mk.includes(countryCode)); }).slice(0, MAX_STAFF);
};

/** Deliver one channel of one alert and record the outcome. Idempotent per delivery row: SENT rows are left alone. */
async function runDelivery(alert, delivery, { env = process.env, unrestricted = false } = {}) {
  if (delivery.status === 'SENT') return delivery;
  const attempts = (delivery.attempts || 0) + 1;
  let status = 'FAILED'; let lastError = null; let notified = 0; let webhook = null;
  const prefix = delivery.round > 0 ? '[ESCALATED] ' : '';
  try {
    if (delivery.channel === 'IN_APP') {
      const staff = await staffFor(alert.data?.countryCode || null, { unrestricted });
      if (!staff.length) lastError = 'NO_RECIPIENTS';
      const notifier = require('./notification.service');
      for (const u of staff) {
        try { await notifier.notify({ userId: u.id, title: `${prefix}${alert.title}`, message: alert.message, type: alert.kind === 'RECIPIENT_HANDOVER_FAILED' ? TYPE : `ops_${String(alert.kind).toLowerCase()}`, data: { ...(alert.data || {}), alertId: alert.id } }); notified += 1; }
        catch (e) { console.error('[ops-alert] notify failed:', e.message); }
      }
      if (notified > 0) status = 'SENT'; else if (!lastError) lastError = 'NOTIFY_ERROR';
    } else {
      webhook = await postWebhook(`Runserv: ${prefix}${alert.title}. ${alert.message}`, env);
      if (webhook.status === 'SENT') status = 'SENT'; else lastError = webhook.category || webhook.status;
    }
  } catch (e) { lastError = 'INTERNAL_ERROR'; console.error('[ops-alert] delivery error:', e.message); }
  const now = new Date();
  const next = status === 'SENT' || attempts >= MAX_DELIVERY_ATTEMPTS() ? null : new Date(now.getTime() + backoffMs(attempts));
  await prisma.opsAlertDelivery.update({ where: { id: delivery.id }, data: { status, attempts, lastError: status === 'SENT' ? null : lastError, sentAt: status === 'SENT' ? now : null, nextAttemptAt: next, updatedAt: now } });
  await prisma.opsAlert.update({ where: { id: alert.id }, data: { attempts: { increment: 1 }, ...(status === 'SENT' && { lastNotifiedAt: now }) } });
  if (status === 'SENT' && !alert.firstNotifiedAt) await prisma.opsAlert.updateMany({ where: { id: alert.id, firstNotifiedAt: null }, data: { firstNotifiedAt: now } });
  return { ...delivery, status, attempts, lastError, notified, webhook };
}

/** Create delivery rows for a round (IN_APP always; WEBHOOK when a URL is configured) and run them. */
async function deliverRound(alert, { round = 0, env = process.env, unrestricted = false } = {}) {
  const channels = ['IN_APP'];
  if (String(env.OPS_ALERT_WEBHOOK_URL || '').trim()) channels.push('WEBHOOK');
  const out = {};
  for (const channel of channels) {
    const d = await prisma.opsAlertDelivery.create({ data: { alertId: alert.id, channel, round, status: 'PENDING', attempts: 0 } });
    out[channel] = await runDelivery(alert, d, { env, unrestricted });
  }
  return out;
}

/**
 * Tell operations that a recipient hand-over needs attention.
 *   why: EMAIL_DEAD | EMAIL_BOUNCED | SMS_DEAD | CODE_LOCKED     category: the failure category (e.g. INVALID_ADDRESS), never provider text
 * Returns { notified, webhook } and never throws. webhook is SENT only on a confirmed 2xx.
 */
async function recipientHandoverFailed({ bookingId = null, deliveryId = null, why, category = null, env = process.env } = {}) {
  try {
    if (!enabled(env) || !WHY[why] || (!bookingId && !deliveryId)) return { notified: 0, webhook: 'SKIPPED' };
    const m = await marketOf({ bookingId, deliveryId });
    const ref = m.reference || 'a parcel';
    const title = 'Parcel hand-over needs attention';
    const message = `${WHY[why]} Parcel ${ref}. ${NEXT[why]}`;
    const bid = bookingId || m.bookingId || null;
    const data = { bookingId: bid, deliveryId: m.deliveryId, reference: m.reference, why, category, countryCode: m.countryCode, link: bid ? `/guest-bookings/${bid}` : '/guest-bookings/attention' };
    const dedupeKey = `handover:${why}:${bid || m.deliveryId}`;

    let alert = null; let created = true;
    try { ({ alert, created } = await raise({ kind: 'RECIPIENT_HANDOVER_FAILED', dedupeKey, severity: why === 'CODE_LOCKED' ? 'CRITICAL' : 'WARNING', title, message, data })); }
    catch (e) { console.error('[ops-alert] durable write failed, delivering without it:', e.message); }   // e.g. migration not applied yet
    if (alert && !created) return { notified: 0, webhook: 'DEDUPED', deduped: true, alertId: alert.id };

    let notified = 0; let webhook = 'NOT_CONFIGURED';
    if (alert) {
      const r = await deliverRound(alert, { env });
      notified = r.IN_APP?.notified || 0;
      webhook = r.WEBHOOK ? (r.WEBHOOK.status === 'SENT' ? 'SENT' : 'FAILED') : 'NOT_CONFIGURED';
    } else {          // legacy non-durable path
      const staff = await staffFor(m.countryCode);
      const notifier = require('./notification.service');
      for (const u of staff) {
        try { await notifier.notify({ userId: u.id, title, message, type: TYPE, data }); notified += 1; } catch (e) { console.error('[ops-alert] notify failed:', e.message); }
      }
      webhook = (await postWebhook(`Runserv: ${title}. ${message}`, env)).status;
    }
    const confirmed = notified > 0 || webhook === 'SENT';
    await require('./guestIdentity.service').audit(confirmed ? 'OPS_ALERT_SENT' : 'OPS_ALERT_FAILED', { bookingId: bid, meta: { deliveryId: m.deliveryId, why, category, notified, webhook, alertId: alert?.id || null } });
    return { notified, webhook, alertId: alert?.id || null };
  } catch (e) {
    console.error('[ops-alert] failed:', e.message);
    return { notified: 0, webhook: 'ERROR' };
  }
}

/** Worker pass: retry due FAILED deliveries, then escalate alerts that are still OPEN. */
async function processDue({ now = new Date(), env = process.env, limit = 25 } = {}) {
  const r = { retried: 0, recovered: 0, escalated: 0 };
  if (!enabled(env)) return r;
  const due = await prisma.opsAlertDelivery.findMany({ where: { status: 'FAILED', nextAttemptAt: { lte: now } }, orderBy: { createdAt: 'asc' }, take: limit });
  for (const d of due) {
    const alert = await prisma.opsAlert.findUnique({ where: { id: d.alertId } });
    if (!alert || alert.status === 'RESOLVED') { await prisma.opsAlertDelivery.update({ where: { id: d.id }, data: { nextAttemptAt: null } }); continue; }
    // claim: push nextAttemptAt out so a concurrent worker does not double-send
    const claim = await prisma.opsAlertDelivery.updateMany({ where: { id: d.id, status: 'FAILED', nextAttemptAt: { lte: now } }, data: { nextAttemptAt: new Date(now.getTime() + 60000) } });
    if (claim.count !== 1) continue;
    const out = await runDelivery(alert, d, { env, unrestricted: d.round > 0 });
    r.retried += 1; if (out.status === 'SENT') r.recovered += 1;
  }
  const stale = await prisma.opsAlert.findMany({ where: { status: 'OPEN', escalatedAt: null, createdAt: { lte: new Date(now.getTime() - escalateMs(env)) } }, orderBy: { createdAt: 'asc' }, take: limit });
  for (const a of stale) {
    const claim = await prisma.opsAlert.updateMany({ where: { id: a.id, status: 'OPEN', escalatedAt: null }, data: { escalatedAt: now } });
    if (claim.count !== 1) continue;
    try { await deliverRound({ ...a, escalatedAt: now }, { round: 1, env, unrestricted: true }); }
    catch (e) { console.error('[ops-alert] escalation failed, will retry:', e.message); await prisma.opsAlert.updateMany({ where: { id: a.id, escalatedAt: now }, data: { escalatedAt: null } }).catch(() => {}); continue; }   // release the claim so the next pass escalates
    await require('../utils/auditLog').logActivity({ userId: null, action: 'ops_alert_escalated', entityType: 'OpsAlert', entityId: a.id, details: { kind: a.kind, severity: a.severity } });
    r.escalated += 1;
  }
  return r;
}

let timer = null;
const startWorker = ({ intervalMs = 30000 } = {}) => {
  if (timer || process.env.OPS_ALERT_WORKER === 'off') return null;
  let busy = false;
  timer = setInterval(async () => {
    if (busy) return; busy = true;
    try { await processDue(); } catch (e) { console.error('[ops-alert] worker error:', e.message); } finally { busy = false; }
  }, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
};
const stopWorker = () => { if (timer) { clearInterval(timer); timer = null; } };

module.exports = { TYPE, enabled, recipientHandoverFailed, refOfDelivery, staffWhere, raise, raiseAndDeliver, deliverRound, processDue, startWorker, stopWorker, postWebhook, backoffMs };
