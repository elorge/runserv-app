// backend/src/routes/adminAudit.routes.js — WP-09: read-only audit trail viewer, mounted at /api/admin/audit-logs.
// Super Admin and Admin only. Rows are append-only history: there is deliberately no write/delete route here.
// details JSON is redacted for secret-looking keys before it leaves the server.
'use strict';
const express = require('express');
const prisma = require('../lib/prisma');
const { authenticate, authorize } = require('../middleware/auth.middleware');
const { logActivity } = require('../utils/auditLog');

const router = express.Router();
router.use(authenticate, authorize('ADMIN', 'SUPER_ADMIN'));

const SECRET_KEY = /secret|token|password|passcode|pin|otp|code|hash|authorization|cvv|card|private|signature|apikey|api_key/i;
const redact = (v, depth = 0) => {
  if (v === null || typeof v !== 'object') return v;
  if (depth > 5) return '[truncated]';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(x, depth + 1);
  return out;
};
const lim = (v) => Math.min(100, Math.max(1, parseInt(v, 10) || 50));
const str = (v, n = 100) => (v === undefined || v === null || v === '' ? undefined : String(v).slice(0, n));
const encode = (r) => Buffer.from(`${r.createdAt.toISOString()}|${r.id}`).toString('base64url');
const decode = (c) => { try { const [t, id] = Buffer.from(String(c), 'base64url').toString().split('|'); const d = new Date(t); return Number.isNaN(d.getTime()) || !id ? null : { d, id }; } catch { return null; } };

const buildWhere = (q) => {
  const and = [];
  if (str(q.action)) and.push({ action: str(q.action) });
  if (str(q.entityType)) and.push({ entityType: str(q.entityType) });
  if (str(q.entityId)) and.push({ entityId: str(q.entityId, 200) });
  if (str(q.userId)) and.push({ userId: str(q.userId, 200) });
  const from = q.from ? new Date(q.from) : null; const to = q.to ? new Date(q.to) : null;
  if (from && !Number.isNaN(from.getTime())) and.push({ createdAt: { gte: from } });
  if (to && !Number.isNaN(to.getTime())) and.push({ createdAt: { lte: to } });
  if (str(q.q)) and.push({ OR: [{ action: { contains: str(q.q), mode: 'insensitive' } }, { entityType: { contains: str(q.q), mode: 'insensitive' } }, { entityId: { contains: str(q.q), mode: 'insensitive' } }] });
  return and.length ? { AND: and } : {};
};

router.get('/', async (req, res) => {
  const take = lim(req.query.limit);
  const cur = req.query.cursor ? decode(req.query.cursor) : null;
  if (req.query.cursor && !cur) return res.status(400).json({ success: false, message: 'Invalid cursor.' });
  const where = buildWhere(req.query);
  const page = cur ? { AND: [where, { OR: [{ createdAt: { lt: cur.d } }, { createdAt: cur.d, id: { lt: cur.id } }] }] } : where;
  const rows = await prisma.activityLog.findMany({ where: page, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: take + 1, include: { user: { select: { id: true, firstName: true, lastName: true, email: true, role: true } } } });
  const more = rows.length > take; const items = (more ? rows.slice(0, take) : rows).map((r) => ({ ...r, details: redact(r.details) }));
  res.json({ success: true, data: { items, nextCursor: more ? encode(items[items.length - 1]) : null } });
});

// Distinct values for the filter drop-downs (bounded).
router.get('/facets', async (req, res) => {
  const [a, e] = await Promise.all([
    prisma.activityLog.groupBy({ by: ['action'], _count: { _all: true }, orderBy: { _count: { action: 'desc' } }, take: 200 }),
    prisma.activityLog.groupBy({ by: ['entityType'], _count: { _all: true }, orderBy: { _count: { entityType: 'desc' } }, take: 100 }),
  ]);
  res.json({ success: true, data: { actions: a.map((x) => x.action), entityTypes: e.map((x) => x.entityType) } });
});

router.get('/export', async (req, res) => {
  const rows = await prisma.activityLog.findMany({ where: buildWhere(req.query), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 5000 });
  logActivity({ userId: req.user.id, action: 'audit_log_exported', entityType: 'ActivityLog', details: { rows: rows.length, filters: redact(req.query) }, req });
  const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /^[=+\-@]/.test(s) ? `'${s}` : s; };   // spreadsheet formula injection guard
  const csv = ['createdAt,userId,action,entityType,entityId,ipAddress,details'].concat(rows.map((r) => [r.createdAt.toISOString(), r.userId, r.action, r.entityType, r.entityId, r.ipAddress, JSON.stringify(redact(r.details) ?? '')].map((v) => `"${esc(v).replace(/"/g, '""')}"`).join(','))).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"'); res.send(csv);
});

module.exports = router; module.exports.redact = redact;
