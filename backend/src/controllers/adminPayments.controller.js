// backend/src/controllers/adminPayments.controller.js
'use strict';
const prisma = require('../lib/prisma');
const cfg = require('../services/payments/providerConfig.service');
const collection = require('../services/payments/collection.service');
const recon = require('../services/payments/reconciliation.service');

const ok = (res, data, code = 200) => res.status(code).json({ success: true, data });
const P = (req) => ({ providerKey: req.params.key, countryCode: req.params.country, environment: req.body.environment, actor: req.user.id, req });

exports.directory = async (_req, res) => ok(res, { providers: await cfg.directory(), activeEnvironment: cfg.activeEnvironment() });
exports.updateSettings = async (req, res) => { const row = await cfg.upsertSettings({ ...P(req), onboardingStatus: req.body.onboardingStatus, capabilities: req.body.capabilities, safeConfig: req.body.safeConfig }); ok(res, { id: row.id }); };
exports.enable = async (req, res) => ok(res, await cfg.requestEnable({ ...P(req), reason: req.body.reason }));
exports.disable = async (req, res) => { await cfg.disable({ ...P(req), reason: req.body.reason }); ok(res, { enabled: false }); };
exports.setSecrets = async (req, res) => ok(res, await cfg.setSecrets({ ...P(req), values: req.body.values }));   // response: names + date only
exports.listChangeRequests = async (_req, res) => ok(res, { requests: await prisma.providerChangeRequest.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }) });
exports.approve = async (req, res) => ok(res, await cfg.decide({ id: req.params.id, approve: true, actor: req.user.id, note: req.body?.note, req }));
exports.reject = async (req, res) => ok(res, await cfg.decide({ id: req.params.id, approve: false, actor: req.user.id, note: req.body?.note, req }));

exports.events = async (req, res) => ok(res, { events: await prisma.paymentEvent.findMany({ where: { paymentId: req.params.id }, orderBy: { createdAt: 'asc' }, take: 200 }) });
exports.resolve = async (req, res) => ok(res, await collection.adminResolve({ paymentId: req.params.id, outcome: req.body.outcome, note: req.body.note, actor: req.user.id, req }));
exports.sweep = async (_req, res) => ok(res, await collection.sweepPending());

exports.exceptions = async (req, res) => {
  const where = { ...(req.query.status ? { status: String(req.query.status) } : { status: 'OPEN' }), ...(req.query.kind && { kind: String(req.query.kind) }), ...(req.query.provider && { provider: String(req.query.provider) }) };
  ok(res, { exceptions: await prisma.paymentException.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 }) });
};
exports.resolveException = async (req, res) => {
  const n = await prisma.paymentException.updateMany({ where: { id: req.params.id, status: 'OPEN' }, data: { status: req.body.dismiss ? 'DISMISSED' : 'RESOLVED', resolvedById: req.user.id, resolvedAt: new Date(), resolution: req.body.resolution } });
  if (n.count !== 1) return res.status(409).json({ success: false, message: 'Already closed.' });
  require('../utils/auditLog').logActivity({ userId: req.user.id, action: 'payment_exception_closed', entityType: 'PaymentException', entityId: req.params.id, details: { dismiss: !!req.body.dismiss }, req });
  ok(res, { id: req.params.id });
};
exports.audit = async (_req, res) => ok(res, { entries: await prisma.activityLog.findMany({ where: { entityType: { in: ['PaymentProviderConfig', 'ProviderChangeRequest', 'PaymentException', 'ReconciliationRun'] } }, orderBy: { createdAt: 'desc' }, take: 200 }) });
exports.reconciliationRuns = async (_req, res) => ok(res, { runs: await prisma.reconciliationRun.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }) });
exports.reconcile = async (req, res) => ok(res, await recon.run({ ...req.body, actor: req.user.id, req }), 201);
