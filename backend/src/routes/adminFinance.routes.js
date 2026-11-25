// backend/src/routes/adminFinance.routes.js — WP-01: mounted at /api/admin/finance. Finance staff only (Super Admin or general/finance Admin).
'use strict';
const express = require('express');
const prisma = require('../lib/prisma');
const { authenticate, authorize } = require('../middleware/auth.middleware');
const recon = require('../services/ledgerReconciliation.service');
const { logActivity } = require('../utils/auditLog');

const router = express.Router();
router.use(authenticate, authorize('ADMIN', 'SUPER_ADMIN'));
const lim = (v, d = 25) => Math.min(100, Math.max(1, parseInt(v, 10) || d));

router.get('/reconciliation/latest', async (req, res) => {
  const run = await prisma.ledgerReconciliationRun.findFirst({ orderBy: { startedAt: 'desc' } });
  res.json({ success: true, data: { run } });
});
router.get('/reconciliation/runs', async (req, res) => {
  const take = lim(req.query.limit);
  const rows = await prisma.ledgerReconciliationRun.findMany({ orderBy: { startedAt: 'desc' }, take: take + 1, ...(req.query.cursor ? { cursor: { id: String(req.query.cursor) }, skip: 1 } : {}), select: { id: true, trigger: true, status: true, startedAt: true, finishedAt: true, summary: true } });
  const more = rows.length > take; const items = more ? rows.slice(0, take) : rows;
  res.json({ success: true, data: { items, nextCursor: more ? items[items.length - 1].id : null } });
});
router.get('/reconciliation/runs/:id', async (req, res) => {
  const run = await prisma.ledgerReconciliationRun.findUnique({ where: { id: req.params.id } });
  if (!run) return res.status(404).json({ success: false, message: 'Run not found.' });
  res.json({ success: true, data: { run } });
});
router.post('/reconciliation/run', async (req, res) => {
  const run = await recon.run({ trigger: 'MANUAL', actorId: req.user.id });
  logActivity({ userId: req.user.id, action: 'reconciliation_run', entityType: 'LedgerReconciliationRun', entityId: run.id, details: { status: run.status }, req });
  res.status(201).json({ success: true, data: { run } });
});
router.get('/ledger', async (req, res) => {
  const where = {};
  if (req.query.account) where.account = String(req.query.account).slice(0, 80);
  if (req.query.refType) where.refType = String(req.query.refType).slice(0, 60);
  if (req.query.refId) where.refId = String(req.query.refId).slice(0, 120);
  const take = lim(req.query.limit, 50);
  const rows = await prisma.ledgerEntry.findMany({ where, orderBy: { createdAt: 'desc' }, take: take + 1, ...(req.query.cursor ? { cursor: { id: String(req.query.cursor) }, skip: 1 } : {}) });
  const more = rows.length > take; const items = more ? rows.slice(0, take) : rows;
  res.json({ success: true, data: { items, nextCursor: more ? items[items.length - 1].id : null } });
});
module.exports = router;
