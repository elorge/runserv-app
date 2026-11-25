'use strict';
const jwt = require('jsonwebtoken');

describe('debitWallet: one conditional update, never check-then-spend', () => {
  const { debitWallet } = require('../src/services/walletOps');
  const M = { currency: 'NGN', refType: 'TEST', refId: 'r1' };
  test('refuses a mutation with no ledger context (WP-01)', async () => {
    await expect(debitWallet(txWith(1), { id: 'w1' }, 5)).rejects.toMatchObject({ statusCode: 500 });
    await expect(require('../src/services/walletOps').creditWallet(txWith(1), { id: 'w1' }, 5, { refType: 'X' })).rejects.toMatchObject({ statusCode: 500 });
  });
  const txWith = (count) => ({ wallet: { updateMany: jest.fn().mockResolvedValue({ count }) } });
  test('takes the money only if the balance covers it (balance >= amount in the WHERE clause)', async () => {
    const tx = txWith(1); await debitWallet(tx, { id: 'w1' }, 500, M);
    expect(tx.wallet.updateMany).toHaveBeenCalledWith({ where: { id: 'w1', currency: 'NGN', balance: { gte: 500 } }, data: { balance: { decrement: 500 } } });
  });
  test('refuses when nothing matched (the second of two parallel spends lands here)', async () => {
    await expect(debitWallet(txWith(0), { id: 'w1' }, 500, M)).rejects.toMatchObject({ statusCode: 400, message: 'Insufficient wallet balance' });
  });
  test('refuses zero, negative and non-numeric amounts', async () => {
    for (const bad of [0, -1, 'x', NaN, Infinity]) await expect(debitWallet(txWith(1), { id: 'w1' }, bad, M)).rejects.toMatchObject({ statusCode: 400 });
  });
  test('only an explicit WALLET choice is acted on', () => {
    const { riderPaymentChoice } = require('../src/services/walletOps');
    expect([riderPaymentChoice('wallet'), riderPaymentChoice('WALLET'), riderPaymentChoice('CARD'), riderPaymentChoice(undefined), riderPaymentChoice('CORPORATE')]).toEqual(['WALLET', 'WALLET', 'CASH', 'CASH', 'CASH']);
  });
});

describe('environment guard fails closed', () => {
  const g = require('../src/utils/envGuard');
  test('a missing NODE_ENV is production, not development', () => { expect(g.isProduction({})).toBe(true); expect(g.isDevLike({})).toBe(false); });
  test('only development/test relax', () => { expect(g.isDevLike({ NODE_ENV: 'development' })).toBe(true); expect(g.isDevLike({ NODE_ENV: 'test' })).toBe(true); expect(g.isProduction({ NODE_ENV: 'staging' })).toBe(true); });
  test('production refuses a weak or placeholder JWT secret and missing origins', () => {
    expect(g.productionProblems({ NODE_ENV: 'production', JWT_SECRET: 'short', DATABASE_URL: 'x' }).join(' ')).toMatch(/JWT_SECRET/);
    expect(g.productionProblems({ NODE_ENV: 'production', JWT_SECRET: 'secret' + 'x'.repeat(40), DATABASE_URL: 'x', CLIENT_URL: 'https://a' }).join(' ')).toMatch(/placeholder/);
    expect(() => g.assertProductionEnv({ NODE_ENV: 'production' })).toThrow(/unsafe configuration/);
    const good = { NODE_ENV: 'production', REQUIRE_STAFF_MFA: 'true', MFA_ENCRYPTION_KEY: 'm'.repeat(32), JWT_SECRET: 'q'.repeat(48), DATABASE_URL: 'x', CLIENT_URL: 'https://a', CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's', OSRM_URL: 'https://osrm.example.com' };
    expect(g.productionProblems(good)).toEqual([]);
  });
  test('bank receipts need an encryption key in production', () => {
    expect(g.productionProblems({ NODE_ENV: 'production', JWT_SECRET: 'q'.repeat(48), DATABASE_URL: 'x', CLIENT_URL: 'https://a', BANK_RECEIPTS_ENABLED: 'true' }).join(' ')).toMatch(/BANK_SECRETS_KEY/);
  });
  test('development is never blocked', () => { expect(g.productionProblems({ NODE_ENV: 'development' })).toEqual([]); });
});

describe('error handler never leaks internals', () => {
  const { errorHandler, AppError } = require('../src/middleware/errorHandler');
  const run = (err, env) => { const prev = process.env.NODE_ENV; process.env.NODE_ENV = env; const out = {}; const res = { status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; } }; errorHandler(err, { path: '/x', method: 'GET' }, res, () => {}); process.env.NODE_ENV = prev; return out; };
  test('an unexpected failure shows a generic message in production', () => {
    const o = run(new Error('PrismaClientKnownRequestError: SELECT * FROM "User" at /app/src/x.js'), 'production');
    expect(o.code).toBe(500); expect(JSON.stringify(o.body)).not.toMatch(/SELECT|prisma|\/app/i); expect(o.body.stack).toBeUndefined();
  });
  test('a deliberate AppError keeps its message', () => { expect(run(new AppError('Insufficient wallet balance', 400), 'production').body.message).toBe('Insufficient wallet balance'); });
  test('duplicate-key errors do not name database columns', () => { const e = Object.assign(new Error('x'), { code: 'P2002', meta: { target: ['User_email_key'] } }); expect(JSON.stringify(run(e, 'production').body)).not.toMatch(/User_email_key/); });
});

describe('authentication', () => {
  const user = { id: 'u1', email: 'a@b.c', isActive: true, isSuspended: false, role: 'CUSTOMER' };
  const load = (u) => { jest.resetModules(); jest.doMock('../src/lib/prisma', () => ({ user: { findUnique: async () => u } })); jest.doMock('../src/utils/auditLog', () => ({ logActivity: () => {} })); return require('../src/middleware/auth.middleware').authenticate; };
  const call = async (auth, token) => { const out = {}; const res = { status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; } }; let nexted = false; await auth({ headers: { authorization: `Bearer ${token}` } }, res, () => { nexted = true; }); return { ...out, nexted }; };
  beforeAll(() => { process.env.JWT_SECRET = 'unit-test-secret-unit-test-secret-1234'; });
  test('a valid HS256 token passes', async () => { expect((await call(load(user), jwt.sign({ userId: 'u1' }, process.env.JWT_SECRET))).nexted).toBe(true); });
  test('an unsigned "alg: none" token is refused', async () => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    expect((await call(load(user), `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ userId: 'u1' })}.`)).code).toBe(401);
  });
  test('a token signed with a different algorithm is refused', async () => { expect((await call(load(user), jwt.sign({ userId: 'u1' }, process.env.JWT_SECRET, { algorithm: 'HS512' }))).code).toBe(401); });
  test('a suspended account is refused even with a valid token', async () => { expect((await call(load({ ...user, isSuspended: true }), jwt.sign({ userId: 'u1' }, process.env.JWT_SECRET))).code).toBe(403); });
});

describe('OTP codes come from a cryptographic generator', () => {
  test('source uses crypto.randomInt, not Math.random', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/services/otp.service.js'), 'utf8');
    expect(src).toMatch(/crypto\.randomInt/); expect(src).not.toMatch(/Math\.random/);
  });
});

describe('paying a trip from the wallet', () => {
  const setup = ({ trip, existing = null, balanceOk = true }) => {
    jest.resetModules();
    const tx = { wallet: { updateMany: jest.fn().mockResolvedValue({ count: balanceOk ? 1 : 0 }), findUnique: jest.fn().mockResolvedValue({ id: 'w1', balance: 0 }), update: jest.fn() }, payment: { create: jest.fn().mockResolvedValue({ id: 'p1' }) }, walletTransaction: { create: jest.fn() } };
    const prisma = { ride: { findUnique: jest.fn().mockResolvedValue(trip) }, delivery: { findUnique: jest.fn().mockResolvedValue(null) }, payment: { findFirst: jest.fn().mockResolvedValue(existing) }, wallet: { findUnique: jest.fn().mockResolvedValue({ id: 'w1', balance: 9999999, currency: 'NGN' }) }, $transaction: jest.fn(async (fn) => fn(tx)) };
    jest.doMock('../src/lib/prisma', () => prisma);
    jest.doMock('../src/services/paymentSplit.service', () => ({ paymentSplit: jest.fn().mockResolvedValue({ platformFee: 1, driverEarnings: 1 }) }));
    jest.doMock('../src/services/notification.service', () => ({ notify: jest.fn(), TYPES: {} }));
    jest.doMock('../src/services/email.service', () => ({}));
    return { ctrl: require('../src/controllers/payment.controller'), prisma, tx };
  };
  const call = (ctrl, body) => ctrl.processWalletPayment({ body, user: { id: 'me', email: null } }, { status() { return this; }, json() { return this; } });
  test("cannot pay someone else's trip", async () => {
    const { ctrl } = setup({ trip: { customerId: 'other', payerType: 'SELF', estimatedFare: 1000 } });
    await expect(call(ctrl, { rideId: 'r1', amount: 1 })).rejects.toMatchObject({ statusCode: 404 });
  });
  test('cannot pay twice for the same trip', async () => {
    const { ctrl } = setup({ trip: { customerId: 'me', payerType: 'SELF', estimatedFare: 1000 }, existing: { id: 'p0' } });
    await expect(call(ctrl, { rideId: 'r1' })).rejects.toMatchObject({ statusCode: 409 });
  });
  test('the amount comes from the server, never from the request', async () => {
    const { ctrl, tx } = setup({ trip: { customerId: 'me', payerType: 'SELF', actualFare: 2500, estimatedFare: 2000 } });
    try { await call(ctrl, { rideId: 'r1', amount: 1 }); } catch (e) { /* the response/notify mocks may throw after the money step; we only inspect the debit */ }
    expect(tx.wallet.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ balance: { gte: 2500 } }) }));
  });
  test('a company-billed trip cannot be paid from a personal wallet', async () => {
    const { ctrl } = setup({ trip: { customerId: 'me', payerType: 'ORGANIZATION', estimatedFare: 1000 } });
    await expect(call(ctrl, { rideId: 'r1' })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('top-up credit is claimed once (verify call + webhook racing)', () => {
  const { withClaim } = require('../src/services/walletOps');
  const make = (claimCount, txImpl) => ({ walletTransaction: { updateMany: jest.fn().mockResolvedValue({ count: claimCount }) }, $transaction: jest.fn(txImpl || (async () => ['ok'])) });
  test('the first caller claims and credits', async () => { const p = make(1); expect(await withClaim(p, 'row1', [])).toEqual(['ok']); expect(p.walletTransaction.updateMany.mock.calls[0][0].where).toMatchObject({ id: 'row1', status: { in: ['PENDING', 'FAILED'] } }); });
  test('the second caller gets null and the wallet is not touched', async () => { const p = make(0); expect(await withClaim(p, 'row1', [])).toBeNull(); expect(p.$transaction).not.toHaveBeenCalled(); });
  test('a failed credit releases the claim so it can be retried', async () => {
    const p = make(1, async () => { throw new Error('db down'); });
    await expect(withClaim(p, 'row1', [])).rejects.toThrow('db down');
    expect(p.walletTransaction.updateMany).toHaveBeenLastCalledWith({ where: { id: 'row1', status: 'PROCESSING' }, data: { status: 'PENDING' } });
  });
  test('with no pending row, the unique reference on the new row is the guard (no claim step)', async () => { const p = make(1); await withClaim(p, undefined, []); expect(p.walletTransaction.updateMany).not.toHaveBeenCalled(); });
});
