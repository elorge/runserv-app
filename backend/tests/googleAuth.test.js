'use strict';
const mockVerify = jest.fn();
jest.mock('google-auth-library', () => ({ OAuth2Client: jest.fn(() => ({ verifyIdToken: mockVerify })) }));
const db = {};
const fn = () => jest.fn();
jest.mock('../src/lib/prisma', () => {
  db.user = { findFirst: fn(), findUnique: fn(), create: fn(), update: fn() };
  return db;
});
jest.mock('../src/utils/walletHelpers', () => ({ ensureWallet: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/services/otp.service', () => ({ createOtp: jest.fn().mockResolvedValue({ code: '123456', tempToken: 'tmp' }), sendOtp: jest.fn(), verifyOtp: jest.fn(), maskPhone: (p) => p.replace(/.(?=.{3})/g, '*') }));
jest.mock('../src/services/email.service', () => ({}), { virtual: false });
jest.mock('../src/services/notification.service', () => ({ notify: jest.fn() }));

process.env.JWT_SECRET = 'test-secret'; process.env.GOOGLE_CLIENT_IDS = 'web-id,ios-id';
const auth = require('../src/controllers/auth.controller');

const res = () => { const r = { status: jest.fn(() => r), json: jest.fn(() => r) }; return r; };
const claims = (o = {}) => ({ getPayload: () => ({ sub: 'g-123', email: 'Ada@Gmail.com', email_verified: true, given_name: 'Ada', family_name: 'Obi', picture: 'https://p/x.png', ...o }) });
const SAFE = { id: 'u1', email: 'ada@gmail.com', phone: null, role: 'CUSTOMER' };

beforeEach(() => { jest.clearAllMocks(); db.user.findUnique.mockResolvedValue(SAFE); });

describe('Google sign-in', () => {
  test('a new Google user becomes a verified CUSTOMER with no phone yet, and is told to add one', async () => {
    mockVerify.mockResolvedValue(claims()); db.user.findFirst.mockResolvedValue(null);
    db.user.create.mockImplementation(async ({ data }) => ({ id: 'u1', ...data }));
    const r = res(); await auth.googleAuth({ body: { idToken: 'tok' } }, r);
    const data = db.user.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ email: 'ada@gmail.com', phone: null, googleId: 'g-123', authProvider: 'GOOGLE', isVerified: true, role: 'CUSTOMER', firstName: 'Ada', lastName: 'Obi' });
    expect(data.password).not.toBe('tok');                      // random, unusable password hash
    expect(r.json.mock.calls[0][0].data).toMatchObject({ isNew: true, needsPhone: true, token: expect.any(String) });
    expect(mockVerify).toHaveBeenCalledWith({ idToken: 'tok', audience: ['web-id', 'ios-id'] });   // our own client IDs only
  });
  test('an invalid token, or an unverified Google email, is refused', async () => {
    mockVerify.mockRejectedValue(new Error('bad')); await expect(auth.googleAuth({ body: { idToken: 'x' } }, res())).rejects.toMatchObject({ statusCode: 401 });
    mockVerify.mockResolvedValue(claims({ email_verified: false })); await expect(auth.googleAuth({ body: { idToken: 'x' } }, res())).rejects.toMatchObject({ statusCode: 400 });
  });
  test('an existing verified customer is linked to Google and keeps their password', async () => {
    mockVerify.mockResolvedValue(claims()); db.user.findFirst.mockResolvedValue({ id: 'u1', role: 'CUSTOMER', isActive: true, isSuspended: false, isVerified: true, googleId: null, authProvider: 'PASSWORD', profileImage: 'x' });
    db.user.update.mockImplementation(async ({ data }) => data);
    await auth.googleAuth({ body: { idToken: 'tok' } }, res());
    const data = db.user.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ googleId: 'g-123' }); expect(data.password).toBeUndefined();
  });
  test('an UNVERIFIED password sign-up with that email is taken over by the real owner: its password is replaced', async () => {
    mockVerify.mockResolvedValue(claims()); db.user.findFirst.mockResolvedValue({ id: 'u1', role: 'CUSTOMER', isActive: true, isSuspended: false, isVerified: false, googleId: null, authProvider: 'PASSWORD', profileImage: 'x' });
    db.user.update.mockImplementation(async ({ data }) => data);
    await auth.googleAuth({ body: { idToken: 'tok' } }, res());
    const data = db.user.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ googleId: 'g-123', isVerified: true }); expect(typeof data.password).toBe('string');
  });
  test('drivers, admins, 2FA users and suspended accounts cannot use Google sign-in', async () => {
    mockVerify.mockResolvedValue(claims());
    for (const u of [{ role: 'DRIVER' }, { role: 'SUPER_ADMIN' }, { role: 'CUSTOMER', twoFactorEnabled: true }, { role: 'CUSTOMER', isSuspended: true, isActive: true }]) {
      db.user.findFirst.mockResolvedValue({ id: 'u1', isActive: true, isSuspended: false, ...u });
      await expect(auth.googleAuth({ body: { idToken: 'tok' } }, res())).rejects.toMatchObject({ statusCode: 403 });
    }
  });
  test('without configured client IDs the endpoint is unavailable (never accepts any audience)', async () => {
    const saved = process.env.GOOGLE_CLIENT_IDS; delete process.env.GOOGLE_CLIENT_IDS; delete process.env.GOOGLE_CLIENT_ID;
    await expect(auth.googleAuth({ body: { idToken: 'x' } }, res())).rejects.toMatchObject({ statusCode: 503 });
    process.env.GOOGLE_CLIENT_IDS = saved;
  });
});

describe('adding a phone number after Google sign-up', () => {
  const otp = require('../src/services/otp.service');
  const jwt = require('jsonwebtoken');
  test('the verified number is saved only if the code, the user and the number all match', async () => {
    const phoneToken = jwt.sign({ userId: 'u1', phone: '+2348012345678' }, 'test-secret', { expiresIn: '10m' });
    otp.verifyOtp.mockResolvedValue({ valid: true, userId: 'u1' }); db.user.findFirst.mockResolvedValue(null);
    db.user.update.mockImplementation(async ({ data }) => ({ id: 'u1', ...data }));
    const r = res(); await auth.verifyPhone({ user: { id: 'u1' }, body: { code: '123456', tempToken: 't', phoneToken } }, r);
    expect(db.user.update.mock.calls[0][0].data).toEqual({ phone: '+2348012345678' });
  });
  test("someone else's token, a wrong code, or an expired request is refused", async () => {
    const other = jwt.sign({ userId: 'someone-else', phone: '+2348000000000' }, 'test-secret');
    await expect(auth.verifyPhone({ user: { id: 'u1' }, body: { code: '1', tempToken: 't', phoneToken: other } }, res())).rejects.toMatchObject({ statusCode: 403 });
    const mine = jwt.sign({ userId: 'u1', phone: '+2348012345678' }, 'test-secret');
    otp.verifyOtp.mockResolvedValue({ valid: false, reason: 'Invalid code' });
    await expect(auth.verifyPhone({ user: { id: 'u1' }, body: { code: '000000', tempToken: 't', phoneToken: mine } }, res())).rejects.toMatchObject({ statusCode: 400 });
    await expect(auth.verifyPhone({ user: { id: 'u1' }, body: { code: '1', tempToken: 't', phoneToken: 'garbage' } }, res())).rejects.toMatchObject({ statusCode: 400 });
  });
  test('a number already used by another account is refused', async () => {
    const phoneToken = jwt.sign({ userId: 'u1', phone: '+2348012345678' }, 'test-secret');
    otp.verifyOtp.mockResolvedValue({ valid: true, userId: 'u1' }); db.user.findFirst.mockResolvedValue({ id: 'other' });
    await expect(auth.verifyPhone({ user: { id: 'u1' }, body: { code: '1', tempToken: 't', phoneToken } }, res())).rejects.toMatchObject({ statusCode: 400 });
  });
});
