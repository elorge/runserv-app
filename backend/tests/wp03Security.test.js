'use strict';
const g = require('../src/utils/envGuard');
const base = { NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40) + 'Q', DATABASE_URL: 'x', CLIENT_URL: 'https://a', CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's', OSRM_URL: 'https://osrm.example' };
describe('production start guard: staff MFA', () => {
  test('refuses to start without REQUIRE_STAFF_MFA=true and MFA_ENCRYPTION_KEY', () => {
    const p = g.productionProblems(base).join(' ');
    expect(p).toMatch(/REQUIRE_STAFF_MFA=true/); expect(p).toMatch(/MFA_ENCRYPTION_KEY/);
  });
  test('passes with both set; development is not affected', () => {
    expect(g.productionProblems({ ...base, REQUIRE_STAFF_MFA: 'true', MFA_ENCRYPTION_KEY: 'm'.repeat(32) }).join(' ')).not.toMatch(/MFA/);
    expect(g.productionProblems({ NODE_ENV: 'development' })).toEqual([]);
  });
});
describe('token revocation', () => {
  const mk = () => { jest.resetModules(); const p = { revokedToken: { findUnique: jest.fn(), upsert: jest.fn(async () => ({})) }, user: { update: jest.fn(async () => ({})) } }; jest.doMock('../src/lib/prisma', () => p); jest.doMock('../src/utils/auditLog', () => ({ logActivity: jest.fn() })); return { p, s: require('../src/services/tokenRevocation.service') }; };
  test('logout stores the jti with the token expiry; the same token is then refused', async () => {
    const { p, s } = mk();
    await s.revokeCurrent({ rawToken: 'tok', tokenClaims: { jti: 'J1', exp: 2000000000 }, user: { id: 'u1' } });
    expect(p.revokedToken.upsert.mock.calls[0][0].create).toMatchObject({ id: 'J1', userId: 'u1', reason: 'LOGOUT' });
    p.revokedToken.findUnique.mockResolvedValueOnce({ id: 'J1' });
    expect(await s.isRevoked('tok', { jti: 'J1' })).toBe(true);
    p.revokedToken.findUnique.mockResolvedValueOnce(null);
    expect(await s.isRevoked('tok2', { jti: 'J2' })).toBe(false);
  });
  test('tokens issued before jti existed are revoked by their SHA-256', () => {
    const { s } = mk(); expect(s.keyOf('abc', {})).toMatch(/^[a-f0-9]{64}$/);
  });
  test('a database error while checking fails CLOSED in production, open in development', async () => {
    const { p, s } = mk(); p.revokedToken.findUnique.mockRejectedValue(new Error('x'));
    const old = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production'; expect(await s.isRevoked('t', { jti: 'j' })).toBe(true);
    process.env.NODE_ENV = 'test'; expect(await s.isRevoked('t', { jti: 'j' })).toBe(false); process.env.NODE_ENV = old;
  });
  test('log out everywhere stamps sessionsRevokedAt', async () => {
    const { p, s } = mk(); await s.revokeAllForUser('u1', { reason: 'LOGOUT_ALL' });
    expect(p.user.update.mock.calls[0][0]).toMatchObject({ where: { id: 'u1' }, data: { sessionsRevokedAt: expect.any(Date) } });
  });
  test('authenticate refuses a revoked token and a token older than sessionsRevokedAt', async () => {
    jest.resetModules();
    const jwt = require('jsonwebtoken'); process.env.JWT_SECRET = 'y'.repeat(40);
    const user = { id: 'u1', role: 'CUSTOMER', isActive: true, isSuspended: false, authProvider: 'PASSWORD', passwordChangedAt: null, sessionsRevokedAt: null };
    const p = { user: { findUnique: jest.fn(async () => user) }, revokedToken: { findUnique: jest.fn(async () => null) } };
    jest.doMock('../src/lib/prisma', () => p); jest.doMock('../src/utils/auditLog', () => ({ logActivity: jest.fn() }));
    const { authenticate } = require('../src/middleware/auth.middleware');
    const run = async (token) => { const res = { status: jest.fn(function () { return this; }), json: jest.fn() }; const next = jest.fn(); await authenticate({ headers: { authorization: `Bearer ${token}` }, baseUrl: '', path: '/' }, res, next); return { res, next }; };
    const tok = jwt.sign({ userId: 'u1' }, process.env.JWT_SECRET, { jwtid: 'J9', expiresIn: '1h' });
    expect((await run(tok)).next).toHaveBeenCalled();
    p.revokedToken.findUnique.mockResolvedValue({ id: 'J9' });
    expect((await run(tok)).res.status).toHaveBeenCalledWith(401);
    p.revokedToken.findUnique.mockResolvedValue(null); user.sessionsRevokedAt = new Date(Date.now() + 60000);
    expect((await run(tok)).res.status).toHaveBeenCalledWith(401);
  });
});
