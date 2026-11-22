'use strict';
// Payment operations: sweeper scheduler, reconciliation, admin route RBAC (over HTTP), secrets never in responses,
// MoMo webhook / initialize at route level.
const SECRET_SENTINEL = 'SUPER-SECRET-SENTINEL-9f3a';
const mockDb = {
  payments: [], exceptions: [], runs: [], cfgRow: null,
  prisma: null,
};
jest.mock('../src/lib/prisma', () => {
  const p = {
    payment: { findMany: jest.fn(async () => mockDb.payments), findFirst: jest.fn(async () => null), findUnique: jest.fn(async () => null), updateMany: jest.fn(async () => ({ count: 1 })) },
    paymentException: { create: jest.fn(async ({ data }) => { mockDb.exceptions.push(data); }), findMany: jest.fn(async () => []), updateMany: jest.fn(async () => ({ count: 1 })) },
    paymentEvent: { create: jest.fn(async () => ({})), findMany: jest.fn(async () => []) },
    reconciliationRun: { create: jest.fn(async ({ data }) => { const r = { id: 'run1', ...data }; mockDb.runs.push(r); return r; }), findMany: jest.fn(async () => []) },
    paymentProviderConfig: {
      findUnique: jest.fn(async () => mockDb.cfgRow), findMany: jest.fn(async () => (mockDb.cfgRow ? [mockDb.cfgRow] : [])),
      upsert: jest.fn(async ({ create, update }) => ({ id: 'cfg1', ...create, ...update })),
    },
    providerChangeRequest: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null), findUnique: jest.fn(async () => null) },
    country: { findMany: jest.fn(async () => [{ code: 'NG', name: 'Nigeria', paymentProviders: ['paystack'] }]) },
    activityLog: { create: jest.fn(async () => ({})), findMany: jest.fn(async () => []) },
    user: { findUnique: jest.fn(async () => ({ id: 'u1', countryCode: 'NG' })) },
  };
  return p;
});
jest.mock('../src/utils/auditLog', () => ({ logActivity: jest.fn(async () => {}) }));
jest.mock('../src/services/country.service', () => ({ getCountryForUser: jest.fn(async () => ({ code: 'NG', currencyCode: 'NGN' })) }));
jest.mock('../src/services/paymentSplit.service', () => ({ paymentSplit: jest.fn(async () => ({})) }));
jest.mock('../src/services/notification.service', () => ({ notify: jest.fn(async () => {}), TYPES: { PAYMENT_RECEIVED: 'x' } }));
jest.mock('../src/middleware/auth.middleware', () => ({
  authenticate: (req, res, next) => { if (!req.headers['x-user']) return res.status(401).json({ success: false }); req.user = { id: req.headers['x-user'], role: req.headers['x-role'], countryCode: 'NG' }; next(); },
  authorize: (...roles) => (req, res, next) => (roles.includes(req.headers['x-role']) ? next() : res.status(403).json({ success: false })),
}));

const request = require('supertest');
const express = require('express');
require('express-async-errors');
const { errorHandler } = require('../src/middleware/errorHandler');
const prisma = require('../src/lib/prisma');
const mtn = require('../src/services/payments/adapters/mtnMomo.adapter');
const recon = require('../src/services/payments/reconciliation.service');
const collection = require('../src/services/payments/collection.service');
const sweeper = require('../src/services/payments/sweeper.job');

const app = express();
app.use(express.json());
app.use('/api/admin', require('../src/middleware/auth.middleware').authenticate, require('../src/routes/adminPayments.routes')); // admin.routes.js authenticates before mounting this router
app.use('/api/payments', require('../src/routes/payment.routes'));
app.use(errorHandler);

const UUID = '11111111-1111-4111-8111-111111111111';
const as = (role) => ({ 'x-user': 'admin1', 'x-role': role });
beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(mockDb, { payments: [], exceptions: [], runs: [], cfgRow: null });
  Object.assign(process.env, { MTN_MOMO_SUBSCRIPTION_KEY: SECRET_SENTINEL, MTN_MOMO_API_USER: SECRET_SENTINEL, MTN_MOMO_API_KEY: SECRET_SENTINEL, MTN_MOMO_CALLBACK_SECRET: 'cbsecret' });
  delete process.env.PAYMENT_SWEEPER_ENABLED;
});

describe('sweeper scheduler', () => {
  afterEach(() => { sweeper.stop(); if (jest.isMockFunction(collection.sweepPending)) collection.sweepPending.mockRestore(); });
  test('runOnce delegates to sweepPending and reports counts', async () => {
    const spy = jest.spyOn(collection, 'sweepPending').mockResolvedValue({ checked: 2, flagged: 1, expired: 0 });
    const info = jest.fn();
    expect(await sweeper.runOnce({ info, error: jest.fn() })).toEqual({ checked: 2, flagged: 1, expired: 0 });
    expect(spy).toHaveBeenCalledTimes(1); expect(info).toHaveBeenCalled();
  });
  test('overlapping runs are skipped, and an error never throws', async () => {
    let release; jest.spyOn(collection, 'sweepPending').mockImplementation(() => new Promise((r) => { release = () => r({ checked: 0, flagged: 0, expired: 0 }); }));
    const first = sweeper.runOnce({ info: jest.fn(), error: jest.fn() });
    expect(await sweeper.runOnce()).toEqual({ skipped: true });
    release(); await first;
    jest.spyOn(collection, 'sweepPending').mockRejectedValue(new Error('db down'));
    const err = jest.fn(); expect(await sweeper.runOnce({ info: jest.fn(), error: err })).toEqual({ error: 'db down' }); expect(err).toHaveBeenCalled();
  });
  test('start() schedules once and can be switched off by env', () => {
    process.env.PAYMENT_SWEEPER_ENABLED = 'false'; expect(sweeper.start()).toBe(false);
    delete process.env.PAYMENT_SWEEPER_ENABLED; expect(sweeper.start()).toBe(true); expect(sweeper.start()).toBe(false);
  });
});

describe('reconciliation', () => {
  const ours = (over) => ({ id: 'p1', provider: 'mtn_momo', status: 'COMPLETED', amount: 1500, currency: 'NGN', transactionId: 'MM-1', providerRef: 'ref-1', ...over });
  const run = (rows) => recon.run({ provider: 'mtn_momo', periodFrom: '2026-11-01', periodTo: '2026-11-30', source: 'test', rows, actor: 'a1' });
  test('matching row is counted; nothing is raised', async () => {
    mockDb.payments = [ours()];
    expect(await run([{ reference: 'MM-1', amount: '1500', currency: 'NGN', status: 'SUCCESSFUL' }])).toMatchObject({ matched: 1, mismatched: 0, missingHere: 0, missingThere: 0 });
    expect(mockDb.exceptions).toHaveLength(0);
  });
  test('amount difference, unknown reference and unpaid-at-provider are all raised', async () => {
    mockDb.payments = [ours(), ours({ id: 'p2', transactionId: 'MM-2', providerRef: 'ref-2' })];
    const r = await run([{ reference: 'MM-1', amount: '1', currency: 'NGN', status: 'SUCCESSFUL' }, { reference: 'GHOST', amount: '10', currency: 'NGN', status: 'SUCCESSFUL' }]);
    expect(r).toMatchObject({ matched: 0, mismatched: 1, missingHere: 1, missingThere: 1 });
    expect(mockDb.exceptions.map((e) => e.kind).sort()).toEqual(['MISSING_AT_PROVIDER', 'MISSING_INTERNALLY', 'RECONCILIATION_MISMATCH']);
  });
  test('status disagreement (they say failed, we say paid) is a mismatch; duplicate statement rows are flagged', async () => {
    mockDb.payments = [ours()];
    const r = await run([{ reference: 'MM-1', amount: '1500', currency: 'NGN', status: 'FAILED' }, { reference: 'MM-1', amount: '1500', currency: 'NGN', status: 'FAILED' }]);
    expect(r.mismatched).toBe(2);
  });
  test('never edits a payment', async () => {
    mockDb.payments = [ours()]; await run([{ reference: 'MM-1', amount: '9', currency: 'NGN', status: 'FAILED' }]);
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
  });
});

describe('admin routes: role enforcement over HTTP', () => {
  const base = '/api/admin';
  const superOnly = [
    ['put', `${base}/payment-providers/mtn_momo/NG/settings`, { environment: 'SANDBOX' }],
    ['post', `${base}/payment-providers/mtn_momo/NG/enable`, { environment: 'SANDBOX', reason: 'pilot test' }],
    ['put', `${base}/payment-providers/mtn_momo/NG/secrets`, { environment: 'SANDBOX', values: { apiKey: 'x' } }],
    ['post', `${base}/payment-providers/change-requests/${UUID}/approve`, {}],
    ['post', `${base}/payment-ops/payments/${UUID}/resolve`, { outcome: 'FAIL', note: 'long enough evidence' }],
    ['post', `${base}/payment-ops/exceptions/${UUID}/resolve`, { resolution: 'handled' }],
    ['post', `${base}/payment-ops/sweep`, {}],
    ['post', `${base}/payment-ops/reconciliation`, { provider: 'mtn_momo', periodFrom: '2026-11-01', periodTo: '2026-11-02', source: 's', rows: [{ reference: 'a' }] }],
  ];
  test.each(superOnly)('ADMIN is refused: %s %s', async (method, url, body) => {
    expect((await request(app)[method](url).set(as('ADMIN')).send(body)).status).toBe(403);
  });
  test.each(superOnly)('unauthenticated/customer roles are refused: %s %s', async (method, url, body) => {
    expect((await request(app)[method](url).set(as('CUSTOMER')).send(body)).status).toBe(403);
  });
  test('ADMIN may read the directory, exceptions, audit and runs, and use the kill switch', async () => {
    for (const u of ['/payment-providers', '/payment-ops/exceptions', '/payment-ops/audit', '/payment-ops/reconciliation', '/payment-providers/change-requests']) {
      expect((await request(app).get(base + u).set(as('ADMIN'))).status).toBe(200);
    }
    mockDb.cfgRow = { id: 'cfg1', enabled: true, onboardingStatus: 'SANDBOX_ACCESS', safeConfig: {}, capabilities: {} };
    expect((await request(app).post(`${base}/payment-providers/mtn_momo/NG/disable`).set(as('ADMIN')).send({ environment: 'SANDBOX' })).status).toBe(200);
  });
  test('customers cannot even read; super admin passes validation on a real change', async () => {
    expect((await request(app).get(`${base}/payment-providers`).set(as('CUSTOMER'))).status).toBe(403);
    expect((await request(app).post(`${base}/payment-ops/payments/not-a-uuid/resolve`).set(as('SUPER_ADMIN')).send({ outcome: 'FAIL', note: 'x' })).status).toBe(400);
  });
});

describe('secrets never appear in responses', () => {
  test('directory shows presence booleans only', async () => {
    const res = await request(app).get('/api/admin/payment-providers').set(as('SUPER_ADMIN'));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(SECRET_SENTINEL);
    expect(JSON.stringify(res.body)).not.toContain('cbsecret');
    const momo = res.body.data.providers.find((p) => p.providerKey === 'mtn_momo');
    expect(Object.values(momo.credentials).every((v) => typeof v === 'boolean')).toBe(true);
  });
  test('setting secrets echoes names and date only', async () => {
    process.env.PAYMENT_SECRETS_KEY = require('crypto').randomBytes(32).toString('base64');
    const res = await request(app).put('/api/admin/payment-providers/mtn_momo/NG/secrets').set(as('SUPER_ADMIN')).send({ environment: 'SANDBOX', values: { apiKey: SECRET_SENTINEL + '-new' } });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(SECRET_SENTINEL);
    const stored = prisma.paymentProviderConfig.upsert.mock.calls[0][0];
    expect(JSON.stringify(stored)).not.toContain(SECRET_SENTINEL);            // encrypted at rest
    const audit = require('../src/utils/auditLog').logActivity.mock.calls.map(([a]) => JSON.stringify({ ...a, req: undefined })).join('');
    expect(audit).not.toContain(SECRET_SENTINEL);                              // audit holds names only
    delete process.env.PAYMENT_SECRETS_KEY;
  });
});

describe('MoMo customer routes over HTTP', () => {
  test('initialize needs sign-in and an Idempotency-Key', async () => {
    expect((await request(app).post('/api/payments/momo/initialize').send({ phone: '08031234567', rideId: UUID })).status).toBe(401);
    const res = await request(app).post('/api/payments/momo/initialize').set({ 'x-user': 'u1', 'x-role': 'CUSTOMER' }).send({ phone: '08031234567', rideId: UUID });
    expect(res.status).toBe(400); expect(res.body.message).toMatch(/Idempotency-Key/);
  });
  test('verify needs sign-in', async () => { expect((await request(app).post('/api/payments/momo/verify').send({ reference: 'x' })).status).toBe(401); });
  test('webhook for an unknown reference is acknowledged (200) and raised as an exception, not an error', async () => {
    const res = await request(app).post('/api/payments/momo/webhook/unknown-ref/whatever').send({ status: 'SUCCESSFUL' });
    expect(res.status).toBe(200); expect(mockDb.exceptions[0].kind).toBe('MISSING_INTERNALLY');
  });
  test('webhook with a bad token is refused with 401 and never settles', async () => {
    mockDb.cfgRow = { id: 'c', enabled: true, onboardingStatus: 'SANDBOX_ACCESS', safeConfig: {}, capabilities: { currencies: ['NGN'] } };
    prisma.payment.findFirst.mockResolvedValueOnce({ id: 'p1', userId: 'u1', provider: 'mtn_momo', providerRef: 'ref-1', status: 'PENDING' });
    const res = await request(app).post('/api/payments/momo/webhook/ref-1/bad-token').send({ status: 'SUCCESSFUL' });
    expect(res.status).toBe(401);
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(mockDb.exceptions.map((e) => e.kind)).toContain('WEBHOOK_VERIFICATION_FAILED');
  });
  test('webhook with a valid token but a lying body still asks MTN (no trust in the body)', async () => {
    mockDb.cfgRow = { id: 'c', enabled: true, onboardingStatus: 'SANDBOX_ACCESS', safeConfig: {}, capabilities: { currencies: ['NGN'] } };
    const pay = { id: 'p1', userId: 'u1', provider: 'mtn_momo', providerRef: 'ref-1', status: 'PENDING', amount: 1500, currency: 'NGN', transactionId: 'MM-x' };
    prisma.payment.findFirst.mockResolvedValueOnce(pay); prisma.payment.findUnique.mockResolvedValue(pay);
    const verify = jest.spyOn(mtn, 'verifyCollection').mockResolvedValue({ status: 'PENDING', raw: 'PENDING' });
    const res = await request(app).post(`/api/payments/momo/webhook/ref-1/${mtn.callbackToken('ref-1', 'cbsecret')}`).send({ status: 'SUCCESSFUL', amount: '1500' });
    expect(res.status).toBe(200); expect(verify).toHaveBeenCalledWith(expect.anything(), 'ref-1');
    expect(prisma.payment.updateMany.mock.calls.every(([a]) => a.data.status !== 'COMPLETED')).toBe(true);
    verify.mockRestore();
  });
});
