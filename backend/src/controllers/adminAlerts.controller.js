// backend/src/controllers/adminAlerts.controller.js — WP-08: staff view of durable operations alerts.
'use strict';
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { logActivity } = require('../utils/auditLog');
const { staffMarkets, canActInMarket } = require('../utils/marketScope');

const STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'];
const SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'];
const encode = (a) => Buffer.from(JSON.stringify([new Date(a.createdAt).toISOString(), a.id])).toString('base64url');
const decode = (c) => { try { const [t, id] = JSON.parse(Buffer.from(String(c), 'base64url').toString('utf8')); const d = new Date(t); if (Number.isNaN(d.getTime()) || !id) return null; return { createdAt: d, id: String(id) }; } catch (_) { return null; } };

/** Country-limited staff only see alerts of their own markets (data.countryCode); alerts with no market are for unrestricted staff only. */
const marketFilter = (user) => { const mk = staffMarkets(user); return mk.length ? { OR: mk.map((c) => ({ data: { path: ['countryCode'], equals: c } })) } : null; };
const inScope = (user, alert) => staffMarkets(user).length === 0 || (!!alert.data?.countryCode && canActInMarket(user, alert.data.countryCode));

exports.list = async (req, res) => {
  const { status, kind, severity, cursor } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
  if (status && !STATUSES.includes(status)) throw new AppError('Invalid status', 400);
  if (severity && !SEVERITIES.includes(severity)) throw new AppError('Invalid severity', 400);
  const where = { ...(status && { status }), ...(kind && { kind: String(kind).slice(0, 80) }), ...(severity && { severity }) };
  const scope = marketFilter(req.user);
  where.AND = scope ? [scope] : [];
  if (cursor) {
    const c = decode(cursor); if (!c) throw new AppError('Invalid cursor', 400);
    where.AND.push({ OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }] });
  }
  if (!where.AND.length) delete where.AND;
  const rows = await prisma.opsAlert.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
  const hasMore = rows.length > limit; const alerts = hasMore ? rows.slice(0, limit) : rows;
  const openCount = await prisma.opsAlert.count({ where: { status: 'OPEN', ...(scope && { AND: [scope] }) } });
  res.json({ success: true, data: { alerts, nextCursor: hasMore ? encode(alerts[alerts.length - 1]) : null, openCount } });
};

exports.getOne = async (req, res) => {
  const alert = await prisma.opsAlert.findUnique({ where: { id: req.params.id } });
  if (!alert || !inScope(req.user, alert)) throw new AppError('Alert not found', 404);
  const deliveries = await prisma.opsAlertDelivery.findMany({ where: { alertId: alert.id }, orderBy: { createdAt: 'asc' } });
  res.json({ success: true, data: { alert, deliveries } });
};

exports.acknowledge = async (req, res) => {
  const now = new Date();
  const existing = await prisma.opsAlert.findUnique({ where: { id: req.params.id } });
  if (!existing || !inScope(req.user, existing)) throw new AppError('Alert not found', 404);
  const r = await prisma.opsAlert.updateMany({ where: { id: req.params.id, status: 'OPEN' }, data: { status: 'ACKNOWLEDGED', acknowledgedById: req.user.id, acknowledgedAt: now } });
  const alert = await prisma.opsAlert.findUnique({ where: { id: req.params.id } });
  if (!alert) throw new AppError('Alert not found', 404);
  if (r.count !== 1) throw new AppError(`Alert is already ${alert.status}`, 409);
  await logActivity({ userId: req.user.id, action: 'ops_alert_acknowledged', entityType: 'OpsAlert', entityId: alert.id, details: { kind: alert.kind }, req });
  res.json({ success: true, data: { alert } });
};

exports.resolve = async (req, res) => {
  const note = String(req.body?.note || '').trim();
  if (note.length < 3) throw new AppError('A resolution note is required', 400);
  const now = new Date();
  const existing = await prisma.opsAlert.findUnique({ where: { id: req.params.id } });
  if (!existing || !inScope(req.user, existing)) throw new AppError('Alert not found', 404);
  const r = await prisma.opsAlert.updateMany({ where: { id: req.params.id, status: { in: ['OPEN', 'ACKNOWLEDGED'] } }, data: { status: 'RESOLVED', resolvedById: req.user.id, resolvedAt: now, resolutionNote: note.slice(0, 1000) } });
  const alert = await prisma.opsAlert.findUnique({ where: { id: req.params.id } });
  if (!alert) throw new AppError('Alert not found', 404);
  if (r.count !== 1) throw new AppError('Alert is already resolved', 409);
  await logActivity({ userId: req.user.id, action: 'ops_alert_resolved', entityType: 'OpsAlert', entityId: alert.id, details: { kind: alert.kind, note: note.slice(0, 200) }, req });
  res.json({ success: true, data: { alert } });
};
