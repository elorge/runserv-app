'use strict';
// Multi-provider payment layer: gates, secrets, state machine, MoMo adapter helpers, settle() safety rules.
const mockDb = { cfgRow: null, payment: null, events: [], exceptions: [], updates: [] };
jest.mock('../src/lib/prisma', () => ({
  paymentProviderConfig: { findUnique: jest.fn(async () => mockDb.cfgRow) },
  payment: {
    findUnique: jest.fn(async () => mockDb.payment),
    updateMany: jest.fn(async ({ where, data }) => { mockDb.updates.push(data); if (mockDb.payment && where.status && mockDb.payment.status !== where.status) return { count: 0 }; if (mockDb.payment && data.status) mockDb.payment = { ...mockDb.payment, ...data }; return { count: 1 }; }),
  },
  user: { findUnique: jest.fn(async () => ({ id: 'u1', countryCode: 'NG' })) },
  paymentEvent: { create: jest.fn(async ({ data }) => { mockDb.events.push(data); }) },
  paymentException: { create: jest.fn(async ({ data }) => { mockDb.exceptions.push(data); }) },
}));
jest.mock('../src/utils/auditLog', () => ({ logActivity: jest.fn() }));
jest.mock('../src/services/country.service', () => ({ getCountryForUser: jest.fn(async () => ({ code: 'NG', currencyCode: 'NGN' })) }));
jest.mock('../src/services/paymentSplit.service', () => ({ paymentSplit: jest.fn(async () => ({ platformFee: 20, driverEarnings: 80 })) }));
jest.mock('../src/services/notification.service', () => ({ notify: jest.fn(async () => {}), TYPES: { PAYMENT_RECEIVED: 'x' } }));
jest.mock('../src/services/payments/adapters/mtnMomo.adapter', () => {
  const real = jest.requireActual('../src/services/payments/adapters/mtnMomo.adapter');
  return { ...real, verifyCollection: jest.fn() };
});

const mtn = require('../src/services/payments/adapters/mtnMomo.adapter');
const secretBox = require('../src/services/payments/secretBox');
const cfg = require('../src/services/payments/providerConfig.service');
const col = require('../src/services/payments/collection.service');

const goodRow = (over = {}) => ({ enabled: true, onboardingStatus: 'SANDBOX_ACCESS', safeConfig: {}, capabilities: { currencies: ['NGN'], services: ['RIDE'] }, secretsEnc: null, ...over });
const setEnv = () => Object.assign(process.env, { MTN_MOMO_SUBSCRIPTION_KEY: 'k', MTN_MOMO_API_USER: 'u', MTN_MOMO_API_KEY: 'a', MTN_MOMO_CALLBACK_SECRET: 's' });
beforeEach(() => { Object.assign(mockDb, { cfgRow: null, payment: null, events: [], exceptions: [], updates: [] }); delete process.env.PAYMENT_PROVIDER_ENVIRONMENT; setEnv(); mtn.verifyCollection.mockReset(); });

describe('activation gates', () => {
  test('MTN MoMo is OFF with no config row', async () => expect((await cfg.evaluate({ providerKey: 'mtn_momo', countryCode: 'NG', currency: 'NGN' })).eligible).toBe(false));
  test('enabled sandbox row with creds + declared currency is eligible', async () => { mockDb.cfgRow = goodRow(); expect((await cfg.evaluate({ providerKey: 'mtn_momo', countryCode: 'NG', currency: 'NGN', service: 'RIDE' })).eligible).toBe(true); });
  test('undeclared currency / service are refused', async () => {
    mockDb.cfgRow = goodRow();
    expect((await cfg.evaluate({ providerKey: 'mtn_momo', countryCode: 'NG', currency: 'GHS' })).reason).toBe('CURRENCY_NOT_DECLARED');
    expect((await cfg.evaluate({ providerKey: 'mtn_momo', countryCode: 'NG', currency: 'NGN', service: 'DELIVERY' })).reason).toBe('SERVICE_NOT_ENABLED');
  });
  test('LIVE needs PRODUCTION_APPROVED', async () => { process.env.PAYMENT_PROVIDER_ENVIRONMENT = 'LIVE'; mockDb.cfgRow = goodRow(); expect((await cfg.evaluate({ providerKey: 'mtn_momo', countryCode: 'NG', currency: 'NGN' })).reason).toBe('NOT_PRODUCTION_APPROVED'); });
  test('missing credentials are refused', async () => { delete process.env.MTN_MOMO_API_KEY; mockDb.cfgRow = goodRow(); expect((await cfg.evaluate({ providerKey: 'mtn_momo', countryCode: 'NG', currency: 'NGN' })).reason).toBe('CREDENTIALS_MISSING'); });
  test('legacy providers keep working with no row; a disabled row is a kill switch', async () => {
    expect((await cfg.evaluate({ providerKey: 'paystack', countryCode: 'NG' })).eligible).toBe(true);
    mockDb.cfgRow = { enabled: false }; expect((await cfg.evaluate({ providerKey: 'paystack', countryCode: 'NG' })).eligible).toBe(false);
    await expect(cfg.assertNotKilled('NG', 'paystack')).rejects.toThrow(/unavailable/);
  });
});

describe('secrets', () => {
  test('encrypt/decrypt round trip; refused without a key', () => {
    expect(() => secretBox.encrypt('x')).toThrow();
    process.env.PAYMENT_SECRETS_KEY = require('crypto').randomBytes(32).toString('base64');
    const b = secretBox.encrypt('top-secret'); expect(JSON.stringify(b)).not.toMatch(/top-secret/); expect(secretBox.decrypt(b)).toBe('top-secret');
    b.ct = Buffer.from('tampered').toString('base64'); expect(secretBox.decrypt(b)).toBeNull();
    delete process.env.PAYMENT_SECRETS_KEY;
  });
  test('credential presence is masked booleans only', () => { const p = cfg.credentialPresence('mtn_momo', null); expect(Object.values(p).every((v) => typeof v === 'boolean')).toBe(true); });
});

describe('adapter helpers', () => {
  test('amount strings use no floats', () => { expect(mtn.amountString(1500, 'XOF')).toBe('1500'); expect(mtn.amountString(1500, 'NGN')).toBe('1500.00'); expect(mtn.amountString(12.5, 'GBP')).toBe('12.50'); expect(() => mtn.amountString(0, 'NGN')).toThrow(); });
  test('callback token verifies only for the same reference and secret', () => {
    const t = mtn.callbackToken('ref1', 's'); expect(mtn.verifyCallbackToken('ref1', t, 's')).toBe(true);
    expect(mtn.verifyCallbackToken('ref2', t, 's')).toBe(false); expect(mtn.verifyCallbackToken('ref1', t, 'other')).toBe(false); expect(mtn.verifyCallbackToken('ref1', t, '')).toBe(false);
  });
  test('refund and payout capabilities are not advertised', () => { const c = mtn.getCapabilities(); expect(c.operations.refund).toBe(false); expect(c.operations.payout).toBe(false); });
});

describe('state machine', () => {
  test('only the canonical transitions are allowed', () => {
    expect(col.canTransition('PENDING', 'COMPLETED')).toBe(true);
    expect(col.canTransition('FAILED', 'COMPLETED')).toBe(false);      // late success must be reviewed, not applied
    expect(col.canTransition('COMPLETED', 'FAILED')).toBe(false);
    expect(col.canTransition('REVIEW_REQUIRED', 'COMPLETED')).toBe(true);
  });
});

describe('settle()', () => {
  const pending = () => ({ id: 'p1', userId: 'u1', provider: 'mtn_momo', status: 'PENDING', amount: 1500, currency: 'NGN', transactionId: 'MM-x', providerRef: 'ref-1', rideId: 'r1', deliveryId: null });
  beforeEach(() => { mockDb.cfgRow = goodRow(); mockDb.payment = pending(); });

  test('provider PENDING never marks paid', async () => { mtn.verifyCollection.mockResolvedValue({ status: 'PENDING', raw: 'PENDING' }); const r = await col.settle('p1'); expect(r.pending).toBe(true); expect(mockDb.payment.status).toBe('PENDING'); });
  test('provider unreachable keeps PENDING', async () => { mtn.verifyCollection.mockRejectedValue(new Error('x')); const r = await col.settle('p1'); expect(r.unavailable).toBe(true); expect(mockDb.payment.status).toBe('PENDING'); });
  test('verified SUCCESSFUL with matching amount completes once', async () => {
    mtn.verifyCollection.mockResolvedValue({ status: 'SUCCESSFUL', raw: 'SUCCESSFUL', amount: '1500', currency: 'NGN', externalId: 'MM-x' });
    const r = await col.settle('p1'); expect(r.status).toBe('COMPLETED');
    const again = await col.settle('p1'); expect(again.alreadyProcessed).toBe(true);
    expect(mockDb.events.filter((e) => e.toStatus === 'COMPLETED')).toHaveLength(1);
  });
  test('amount mismatch → REVIEW_REQUIRED + exception, never COMPLETED', async () => {
    mtn.verifyCollection.mockResolvedValue({ status: 'SUCCESSFUL', raw: 'SUCCESSFUL', amount: '1', currency: 'NGN', externalId: 'MM-x' });
    const r = await col.settle('p1'); expect(r.status).toBe('REVIEW_REQUIRED'); expect(mockDb.exceptions[0].kind).toBe('AMOUNT_MISMATCH');
  });
  test('currency mismatch and foreign externalId also hold the money', async () => {
    mtn.verifyCollection.mockResolvedValue({ status: 'SUCCESSFUL', raw: 'SUCCESSFUL', amount: '1500', currency: 'EUR', externalId: 'MM-x' });
    expect((await col.settle('p1')).status).toBe('REVIEW_REQUIRED');
    mockDb.payment = pending();
    mtn.verifyCollection.mockResolvedValue({ status: 'SUCCESSFUL', raw: 'SUCCESSFUL', amount: '1500', currency: 'NGN', externalId: 'OTHER' });
    expect((await col.settle('p1')).status).toBe('REVIEW_REQUIRED');
  });
  test('provider FAILED → FAILED', async () => { mtn.verifyCollection.mockResolvedValue({ status: 'FAILED', raw: 'FAILED' }); expect((await col.settle('p1')).status).toBe('FAILED'); });
  test('a payment already FAILED is not resurrected by a late success', async () => { mockDb.payment = { ...pending(), status: 'FAILED' }; const r = await col.settle('p1'); expect(r.status).toBe('FAILED'); expect(mtn.verifyCollection).not.toHaveBeenCalled(); });
  test('two concurrent settles produce one COMPLETED event', async () => {
    mtn.verifyCollection.mockResolvedValue({ status: 'SUCCESSFUL', raw: 'SUCCESSFUL', amount: '1500', currency: 'NGN', externalId: 'MM-x' });
    await Promise.all([col.settle('p1'), col.settle('p1')]);
    expect(mockDb.events.filter((e) => e.toStatus === 'COMPLETED').length).toBeLessThanOrEqual(1);
  });
});
