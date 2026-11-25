'use strict';
// Regression tests for the M7 security audit: each one fails against the code as it was before the fix.
const mockDb = {};
jest.mock('../src/lib/prisma', () => mockDb);
jest.mock('../src/utils/auditLog', () => ({ logActivity: jest.fn().mockResolvedValue() }));
jest.mock('../src/services/notification.service', () => ({ notify: jest.fn().mockResolvedValue(), TYPES: {} }));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }), { virtual: true });

const ops = require('../src/services/walletOps');

describe('wallet helpers', () => {
  test('creditWallet is one database increment and refuses a missing wallet', async () => {
    const tx = { wallet: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    await ops.creditWallet(tx, { id: 'w' }, 25.5, { currency: 'NGN', refType: 'T', refId: '1' });
    expect(tx.wallet.updateMany).toHaveBeenCalledWith({ where: { id: 'w', currency: 'NGN' }, data: { balance: { increment: 25.5 } } });
    tx.wallet.updateMany.mockResolvedValue({ count: 0 });
    await expect(ops.creditWallet(tx, { id: 'x' }, 5, { currency: 'NGN', refType: 'T', refId: '1' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(ops.creditWallet(tx, { id: 'x' }, -5, { currency: 'NGN', refType: 'T', refId: '1' })).rejects.toMatchObject({ statusCode: 400 });
  });
  test('claim: only the request that still matches the row it read wins', async () => {
    const d = { updateMany: jest.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 }) };
    expect(await ops.claim(d, { id: 1, status: 'PENDING' }, { status: 'COMPLETED' })).toBe(true);
    expect(await ops.claim(d, { id: 1, status: 'PENDING' }, { status: 'FAILED' })).toBe(false);
  });
  test('references are unguessable and unique', () => {
    const s = new Set(Array.from({ length: 500 }, () => ops.newReference('ADMIN')));
    expect(s.size).toBe(500);
  });
});

describe('webhook signatures', () => {
  const OLD = { ...process.env };
  afterEach(() => { process.env = { ...OLD }; jest.resetModules(); });
  test('Flutterwave: no secret configured means NOTHING passes (a missing header used to equal an unset secret)', () => {
    delete process.env.FLUTTERWAVE_WEBHOOK_HASH; process.env.PAYSTACK_SECRET_KEY = 'sk';
    const ps = require('../src/services/payment.service');
    expect(ps.validateFlutterwaveWebhook(undefined)).toBe(false);
    expect(ps.validateFlutterwaveWebhook('')).toBe(false);
    process.env.FLUTTERWAVE_WEBHOOK_HASH = 'abc123';
    expect(ps.validateFlutterwaveWebhook('abc123')).toBe(true);
    expect(ps.validateFlutterwaveWebhook('abc124')).toBe(false);
    expect(ps.validateFlutterwaveWebhook('abc')).toBe(false);
  });
});

describe('live channel rules', () => {
  const sock = require('../src/services/socket.service')._test;
  test('coordinates must be real numbers in range', () => {
    expect(sock.cleanCoords({ lat: 6.5, lng: 3.3 })).toEqual({ lat: 6.5, lng: 3.3 });
    expect(sock.cleanCoords({ lat: '6.5', lng: '3.3' })).toEqual({ lat: 6.5, lng: 3.3 });
    for (const bad of [{ lat: 91, lng: 0 }, { lat: 0, lng: 181 }, { lat: NaN, lng: 1 }, { lat: 'x', lng: 1 }, {}, null]) expect(sock.cleanCoords(bad)).toBeNull();
  });
  test('only the two people on a LIVE trip are counterparts; strangers and finished trips are not', async () => {
    mockDb.ride = { findUnique: jest.fn().mockResolvedValue({ customerId: 'cust-0001', driverId: 'drv-00001', status: 'IN_PROGRESS' }) };
    expect(await sock.counterpart('cust-0001', 'ride_abcdef123456')).toBe('drv-00001');
    expect(await sock.counterpart('drv-00001', 'ride_abcdef123456')).toBe('cust-0001');
    expect(await sock.counterpart('stranger-1', 'ride_abcdef123456')).toBeNull();
    mockDb.ride.findUnique.mockResolvedValue({ customerId: 'cust-0001', driverId: 'drv-00001', status: 'COMPLETED' });
    expect(await sock.counterpart('cust-0001', 'ride_abcdef123456')).toBeNull();
    expect(await sock.counterpart('cust-0001', 'other_abcdef123456')).toBeNull();     // unknown channel kinds get nothing
    expect(await sock.counterpart('cust-0001', 'ride_x')).toBeNull();                  // malformed id
  });
});

describe('two-person approval of staff-entered company money', () => {
  const svc = require('../src/services/moneyApprovals.service');
  const row = (o = {}) => ({ id: 'm1', kind: 'ORG_WALLET_CREDIT', targetId: 'c1', amount: 1000, currency: 'NGN', reason: 'Bank transfer', status: 'PENDING', requestedById: 'u1', payload: {}, ...o });
  beforeEach(() => {
    mockDb.company = { findUnique: jest.fn().mockResolvedValue({ currency: 'NGN' }) };
    mockDb.pendingMoneyAction = { create: jest.fn(async ({ data }) => ({ id: 'm1', ...data })), findUnique: jest.fn().mockResolvedValue(row()), updateMany: jest.fn().mockResolvedValue({ count: 1 }) };
  });
  test('a request changes nothing; it needs a reason and respects the size limit', async () => {
    await expect(svc.request({ kind: 'ORG_WALLET_CREDIT', targetId: 'c1', amount: 100, reason: 'x', actor: 'u1' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.request({ kind: 'ORG_WALLET_CREDIT', targetId: 'c1', amount: 9e9, reason: 'big transfer', actor: 'u1', role: 'ADMIN' })).rejects.toMatchObject({ statusCode: 403 });
    const r = await svc.request({ kind: 'ORG_WALLET_CREDIT', targetId: 'c1', amount: 1000, reason: 'Bank transfer seen', actor: 'u1', role: 'ADMIN' });
    expect(r.status ?? 'PENDING').toBe('PENDING');
  });
  test('the person who made the request cannot approve it', async () => {
    await expect(svc.approve({ id: 'm1', actor: 'u1' })).rejects.toMatchObject({ statusCode: 403 });
  });
  test('two approvals at once: only the one that wins the decision moves money', async () => {
    mockDb.pendingMoneyAction.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.approve({ id: 'm1', actor: 'u2' })).rejects.toMatchObject({ statusCode: 409 });
  });
  test('a decided request cannot be decided again', async () => {
    mockDb.pendingMoneyAction.findUnique.mockResolvedValue(row({ status: 'APPROVED' }));
    await expect(svc.approve({ id: 'm1', actor: 'u2' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(svc.reject({ id: 'm1', actor: 'u2', note: 'no' })).rejects.toBeTruthy();
  });
});

describe('staff two-step sign-in (TOTP)', () => {
  const mfa = require('../src/services/mfa.service');
  const secretAscii = Buffer.from('12345678901234567890');
  test('matches the RFC 4226 / 6238 reference values', () => {
    expect(mfa.hotp(secretAscii, 0)).toBe('755224');
    expect(mfa.hotp(secretAscii, 1)).toBe('287082');
    expect(mfa.hotp(secretAscii, 9)).toBe('520489');
    expect(mfa.hotp(secretAscii, 1)).toBe('287082');   // 6238 vector at T=59s is step 1
  });
  test('base32 round-trips and a code from the previous/next step is tolerated, an older one is not', () => {
    const b32 = mfa.b32encode(secretAscii); expect(mfa.b32decode(b32).equals(secretAscii)).toBe(true);
    const now = 59000;                                           // step 1
    expect(mfa.checkTotp(b32, '287082', now)).toBe(1);
    expect(mfa.checkTotp(b32, '755224', now)).toBe(0);           // one step back
    expect(mfa.checkTotp(b32, '123456', now)).toBeNull();
    expect(mfa.checkTotp(b32, '28708', now)).toBeNull();
  });
  test('the secret is stored encrypted and tampering is detected', () => {
    process.env.JWT_SECRET = 'test-secret';
    const blob = mfa.seal('JBSWY3DPEHPK3PXP'); expect(blob).not.toContain('JBSWY3DP'); expect(mfa.open(blob)).toBe('JBSWY3DPEHPK3PXP');
    expect(mfa.open(blob.slice(0, -3) + 'AAA')).toBeNull();
  });
  test('a code cannot be used twice, and a backup code works exactly once', async () => {
    process.env.JWT_SECRET = 'test-secret';
    const b32 = mfa.b32encode(secretAscii); const nowStep = mfa.stepOf();
    const code = mfa.hotp(secretAscii, nowStep);
    const state = { mfaEnabled: true, mfaSecretEnc: mfa.seal(b32), mfaLastStep: null, mfaBackupHashes: [mfa.hashCode('ABCDE-12345')] };
    mockDb.user = {
      findUnique: jest.fn(async () => ({ ...state })),
      updateMany: jest.fn(async ({ where, data }) => {
        if (where.mfaBackupHashes) { if (!state.mfaBackupHashes.includes(where.mfaBackupHashes.has)) return { count: 0 }; Object.assign(state, data); return { count: 1 }; }
        if (state.mfaLastStep != null && state.mfaLastStep >= data.mfaLastStep) return { count: 0 };
        Object.assign(state, data); return { count: 1 };
      }),
    };
    const u = { id: 'staff-1' };
    expect((await mfa.verify({ user: u, code })).via).toBe('app');
    await expect(mfa.verify({ user: u, code })).rejects.toMatchObject({ statusCode: 400 });      // replay
    expect((await mfa.verify({ user: u, backupCode: 'abcde-12345' })).via).toBe('backup');
    await expect(mfa.verify({ user: u, backupCode: 'ABCDE-12345' })).rejects.toMatchObject({ statusCode: 400 });
  });
  test('five wrong codes lock the account for a while', async () => {
    mockDb.user = { findUnique: jest.fn(async () => ({ mfaEnabled: true, mfaSecretEnc: mfa.seal(mfa.b32encode(secretAscii)), mfaLastStep: null, mfaBackupHashes: [] })) };
    const u = { id: 'staff-2' };
    for (let i = 0; i < 5; i++) await expect(mfa.verify({ user: u, code: '000000' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(mfa.verify({ user: u, code: '000000' })).rejects.toMatchObject({ statusCode: 429 });
  });
  test('the middleware gate: a password-only staff token is limited to the two-step routes', async () => {
    jest.resetModules();
    process.env.JWT_SECRET = 'test-secret'; process.env.REQUIRE_STAFF_MFA = 'true';
    const jwt = require('jsonwebtoken');
    jest.doMock('../src/lib/prisma', () => ({ user: { findUnique: jest.fn().mockResolvedValue({ id: 'a1', role: 'ADMIN', isActive: true, isSuspended: false, mfaEnabled: true }) } }));
    jest.doMock('../src/utils/auditLog', () => ({ logActivity: jest.fn(), logAccessDenied: jest.fn() }));
    const { authenticate } = require('../src/middleware/auth.middleware');
    const run = async (token, path) => { const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; let nexted = false; await authenticate({ headers: { authorization: `Bearer ${token}` }, baseUrl: '/api/admin', path }, res, () => { nexted = true; }); return { res, nexted }; };
    const plain = jwt.sign({ userId: 'a1' }, 'test-secret'); const full = jwt.sign({ userId: 'a1', mfa: true }, 'test-secret');
    const a = await run(plain, '/users'); expect(a.nexted).toBe(false); expect(a.res.code).toBe(401); expect(a.res.body.code).toBe('MFA_REQUIRED');
    expect((await run(full, '/users')).nexted).toBe(true);
    const b = await (async () => { const res = { status() { return this; }, json() { return this; } }; let n = false; await authenticate({ headers: { authorization: `Bearer ${plain}` }, baseUrl: '/api/auth', path: '/mfa/verify' }, res, () => { n = true; }); return n; })();
    expect(b).toBe(true);
  });
});

describe('ledger', () => {
  const ledger = require('../src/services/ledger.service');
  test('writes balanced legs, rejects unbalanced or non-positive ones, skips when the client has no ledger table', async () => {
    const tx = { ledgerEntry: { createMany: jest.fn().mockResolvedValue({}) } };
    await ledger.move(tx, { account: 'WALLET:w1', direction: 'CREDIT', amount: 100.1, currency: 'NGN', refType: 'T', refId: '1' });
    const rows = tx.ledgerEntry.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(2); expect(new Set(rows.map((r) => r.entryGroup)).size).toBe(1);
    expect(rows.find((r) => r.direction === 'CREDIT')).toMatchObject({ account: 'WALLET:w1', amount: 100.1 });
    expect(rows.find((r) => r.direction === 'DEBIT')).toMatchObject({ account: 'PLATFORM:CLEARING', amount: 100.1 });
    await expect(ledger.post(tx, { refType: 'T', refId: '1', currency: 'NGN', legs: [{ account: 'a', direction: 'DEBIT', amount: 5 }, { account: 'b', direction: 'CREDIT', amount: 4 }] })).rejects.toBeTruthy();
    await expect(ledger.move(tx, { account: 'a', direction: 'DEBIT', amount: 0, currency: 'NGN', refType: 'T', refId: '1' })).rejects.toBeTruthy();
    expect(await ledger.move({}, { account: 'a', direction: 'DEBIT', amount: 5, currency: 'NGN', refType: 'T', refId: '1' })).toBeNull();
  });
  test('debit/credit helpers write the ledger in the same transaction when given meta', async () => {
    const tx = { wallet: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }, ledgerEntry: { createMany: jest.fn().mockResolvedValue({}) } };
    await ops.debitWallet(tx, { id: 'w1' }, 40, { currency: 'NGN', refType: 'X', refId: 'r' });
    expect(tx.ledgerEntry.createMany.mock.calls[0][0].data.find((r) => r.direction === 'DEBIT').account).toBe('WALLET:w1');
    await expect(ops.debitWallet(tx, { id: 'w1' }, 40)).rejects.toMatchObject({ statusCode: 500 });   // WP-01: no meta, no mutation
    expect(tx.ledgerEntry.createMany).toHaveBeenCalledTimes(1);
  });
});
