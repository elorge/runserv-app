// In-memory stand-in for the slice of Prisma the guest-booking code uses. Real matching/uniqueness logic, no database.
'use strict';
const crypto = require('crypto');

const UNIQUE = {
  user: [['phone'], ['email']],
  guestIdentity: [['phone'], ['userId'], ['email']],
  guestSession: [['tokenHash']],
  payment: [['deliveryId'], ['transactionId']],
  smsOutbox: [['kind', 'bookingId']],
  emailQuotaWindow: [['provider', 'windowKey']],
  emailWebhookEvent: [['provider', 'eventKey']],
  emailProviderControl: [['provider']],
  guestBooking: [['reference'], ['quoteId'], ['trackingTokenHash'], ['identityId', 'idempotencyKey'], ['rideId'], ['deliveryId']],
};
const DEFAULTS = {
  user: () => ({ isActive: true, isSuspended: false, role: 'CUSTOMER', authProvider: 'PASSWORD' }),
  guestOtp: () => ({ attempts: 0, consumedAt: null, supersededAt: null, channel: 'PHONE', purpose: 'GUEST_BOOKING_VERIFY' }),
  emailOutbox: () => ({ status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), slotHeld: false, provider: null, routeReason: null, providerMessageId: null, errorCategory: null, lastError: null, deliveryStatus: null, sentAt: null, updatedAt: new Date() }),
  emailQuotaWindow: () => ({ reserved: 0, accepted: 0, exhaustedAt: null, unhealthyUntil: null }),
  emailProviderControl: () => ({ paused: false, pausedAt: null, pausedBy: null }),
  smsOutbox: () => ({ status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null, sentAt: null, toPhone: null, updatedAt: new Date() }),
  guestSession: () => ({ revokedAt: null }),
  guestIdentity: () => ({ convertedAt: null, blockedAt: null, blockReason: null, email: null, contactPhone: null, verifiedChannel: 'PHONE', emailVerifiedAt: null, phoneVerifiedAt: null }),
  guestBooking: () => ({ trackingRevokedAt: null }),
  ride: () => ({ status: 'REQUESTED', driverId: null, cancelledAt: null, cancellationReason: null, acceptedAt: null, arrivedAt: null, startedAt: null, completedAt: null }),
  delivery: () => ({ status: 'PENDING', partnerId: null, podCodeAttempts: 0, podVerifiedAt: null, failedAt: null, returnStatus: null, cancelledAt: null, cancellationReason: null }),
};

const val = (row, k) => row[k];
const cmp = (row, k, cond) => {
  const v = val(row, k);
  if (cond === null) return v == null;
  if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
  if (cond && typeof cond === 'object') {
    if ('equals' in cond) { const a = v == null ? v : String(v); const b = String(cond.equals); if (!(a != null && (cond.mode === 'insensitive' ? a.toLowerCase() === b.toLowerCase() : a === b))) return false; }
    if ('gt' in cond && !(v != null && Number(v) > Number(cond.gt))) return false;
    if ('in' in cond && !cond.in.includes(v)) return false;
    if ('lte' in cond && !(v != null && new Date(v) <= new Date(cond.lte))) return false;
    if ('gte' in cond && !(v != null && new Date(v) >= new Date(cond.gte))) return false;
    if ('lt' in cond && !(v != null && new Date(v) < new Date(cond.lt))) return false;
    if ('not' in cond && (cond.not === null ? v == null : v === cond.not)) return false;
    if ('contains' in cond && !String(v ?? '').includes(cond.contains)) return false;
    return true;
  }
  return v === cond;
};
const match = (row, where = {}) => Object.entries(where).every(([k, cond]) => {
  if (k === 'OR') return cond.some((w) => match(row, w));
  if (k === 'AND') return cond.every((w) => match(row, w));
  if (k === 'NOT') return !match(row, cond);
  if (k.includes('_') && cond && typeof cond === 'object' && !('in' in cond)) return Object.entries(cond).every(([ck, cv]) => row[ck] === cv);   // compound unique
  return cmp(row, k, cond);
});

const makeFakeGuestPrisma = (seed = {}) => {
  const tables = {};
  const t = (n) => (tables[n] = tables[n] || []);
  Object.entries(seed).forEach(([n, rows]) => { tables[n] = rows.map((r) => ({ ...r })); });
  const calls = { audit: [] };

  const model = (name) => {
    const clone = (r) => (r ? { ...r } : r);
    const withInclude = (r, include) => {
      if (!r) return r; const o = { ...r };
      if (include?.identity && name === 'guestSession') o.identity = clone(t('guestIdentity').find((x) => x.id === r.identityId));
      return o;
    };
    const apply = (row, data) => { for (const [k, v] of Object.entries(data)) row[k] = v && typeof v === 'object' && !(v instanceof Date) && 'increment' in v ? (row[k] || 0) + v.increment : (v && typeof v === 'object' && !(v instanceof Date) && 'decrement' in v ? (row[k] || 0) - v.decrement : v); if (name === 'smsOutbox' || name === 'emailOutbox') row.updatedAt = new Date(); };
    const checkUnique = (row, skip) => {
      for (const keys of UNIQUE[name] || []) {
        if (keys.some((k) => row[k] == null)) continue;
        const dup = t(name).find((x) => x !== skip && keys.every((k) => x[k] === row[k]));
        if (dup) { const e = new Error(`Unique constraint failed on ${keys.join(',')}`); e.code = 'P2002'; e.meta = { target: keys }; throw e; }
      }
    };
    return {
      findUnique: async ({ where, include }) => { const [[k, v]] = Object.entries(where); const w = k.includes('_') ? where[k] : where; return withInclude(clone(t(name).find((r) => match(r, w))), include); },
      findFirst: async ({ where, orderBy } = {}) => {
        let rows = t(name).filter((r) => match(r, where));
        if (orderBy) { const [[k, d]] = Object.entries(orderBy); rows = [...rows].sort((a, b) => (d === 'desc' ? 1 : -1) * (new Date(a[k]) - new Date(b[k]))); }
        return clone(rows[0] ?? null);
      },
      findMany: async ({ where, orderBy, take } = {}) => {
        let rows = t(name).filter((r) => match(r, where));
        if (orderBy) { const [[k, d]] = Object.entries(orderBy); rows = [...rows].sort((a, b) => (d === 'desc' ? 1 : -1) * (new Date(a[k]) - new Date(b[k]))); }
        return rows.slice(0, take ?? rows.length).map(clone);
      },
      count: async ({ where } = {}) => t(name).filter((r) => match(r, where)).length,
      create: async ({ data }) => { const row = { id: crypto.randomUUID(), createdAt: new Date(), ...(DEFAULTS[name]?.() || {}), ...data }; checkUnique(row); t(name).push(row); if (name === 'guestAuditEvent') calls.audit.push(row); return clone(row); },
      update: async ({ where, data }) => { const row = t(name).find((r) => match(r, where)); if (!row) { const e = new Error('Record not found'); e.code = 'P2025'; throw e; } const next = { ...row }; apply(next, data); checkUnique(next, row); Object.assign(row, next); return clone(row); },
      updateMany: async ({ where, data }) => { const rows = t(name).filter((r) => match(r, where)); rows.forEach((r) => apply(r, data)); return { count: rows.length }; },
      delete: async ({ where }) => { const i = t(name).findIndex((r) => match(r, where)); if (i >= 0) t(name).splice(i, 1); return {}; },
    };
  };
  const fake = { _t: t, _calls: calls };
  ['user', 'guestIdentity', 'guestOtp', 'guestSession', 'guestBooking', 'smsOutbox', 'emailOutbox', 'emailQuotaWindow', 'emailProviderControl', 'emailWebhookEvent', 'guestAuditEvent', 'ride', 'delivery', 'driverProfile', 'deliveryPartnerProfile', 'payment', 'commissionLedger'].forEach((n) => { fake[n] = model(n); });
  // Advisory locks: like pg_advisory_xact_lock, a key is held until the surrounding transaction ends and other transactions queue behind it.
  const lockTails = new Map();
  fake.$executeRaw = async () => 0;                              // outside a transaction there is nothing to lock
  fake.$transaction = async (fn) => {                       // snapshot/rollback so a failed transaction leaves nothing behind
    const held = [];
    const tx = Object.create(fake);
    tx.$executeRaw = async (strings, ...vals) => {
      if (!/pg_advisory_xact_lock/.test(strings.join(''))) return 0;
      const key = String(vals[0]);
      const prev = lockTails.get(key) || Promise.resolve();
      let release; const mine = new Promise((r) => { release = r; });
      lockTails.set(key, prev.then(() => mine));
      await prev; held.push(release);
      return 0;
    };
    const before = Object.fromEntries(Object.entries(tables).map(([n, rows]) => [n, rows.map((r) => ({ ...r }))]));
    try { return await fn(tx); }
    catch (e) { Object.keys(tables).forEach((n) => { tables[n].splice(0, tables[n].length, ...(before[n] || [])); }); throw e; }
    finally { held.forEach((r) => r()); }
  };
  return fake;
};

module.exports = { makeFakeGuestPrisma };
