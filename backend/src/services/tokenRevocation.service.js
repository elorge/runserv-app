// backend/src/services/tokenRevocation.service.js
// WP-03: session / token revocation.
//   - revokeCurrent(req): logout of THIS token (stored by jti, or SHA-256 of the token for tokens issued before jti existed).
//   - revokeAllForUser(id): "log out everywhere" / compromised account: every token issued before now is refused (User.sessionsRevokedAt).
//   - isRevoked(token, decoded): checked by authenticate() on every request (one primary-key lookup).
// Fails CLOSED for the check only where the table exists; a database error while checking is treated as "revoked" in production.
'use strict';
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { logActivity } = require('../utils/auditLog');
const { isProduction } = require('../utils/envGuard');

const keyOf = (token, decoded) => (decoded && decoded.jti) ? String(decoded.jti) : crypto.createHash('sha256').update(String(token)).digest('hex');

const isRevoked = async (token, decoded) => {
  try {
    if (!prisma.revokedToken) return false;
    const row = await prisma.revokedToken.findUnique({ where: { id: keyOf(token, decoded) }, select: { id: true } });
    return !!row;
  } catch (e) {
    return isProduction();   // cannot prove the token is still good → refuse it in production
  }
};

const revokeCurrent = async (req) => {
  if (!req?.rawToken || !req?.user || !prisma.revokedToken) return false;
  const d = req.tokenClaims || {};
  const expiresAt = d.exp ? new Date(d.exp * 1000) : new Date(Date.now() + 7 * 24 * 3600 * 1000);
  try {
    await prisma.revokedToken.upsert({ where: { id: keyOf(req.rawToken, d) }, create: { id: keyOf(req.rawToken, d), userId: req.user.id, reason: 'LOGOUT', expiresAt }, update: {} });
  } catch (e) { console.error('[auth] token revoke failed:', e.message); throw e; }
  logActivity({ userId: req.user.id, action: 'logout', entityType: 'User', entityId: req.user.id, details: {}, req });
  return true;
};

const revokeAllForUser = async (userId, { reason = 'REVOKE_ALL', req = null } = {}) => {
  await prisma.user.update({ where: { id: userId }, data: { sessionsRevokedAt: new Date() } });
  logActivity({ userId, action: 'sessions_revoked', entityType: 'User', entityId: userId, details: { reason }, req });
};

/** Housekeeping for a scheduled job: expired rows are useless. */
const purgeExpired = () => prisma.revokedToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });

/**
 * Was this token issued at or before the moment of "log out everywhere"? Tokens carry iatMs (millisecond issue time) and are compared
 * INCLUSIVELY, so a token minted in the same second as the revocation can no longer slip through. A token without iatMs (issued before
 * this change) falls back to whole seconds, also inclusive: the safe direction is to make that user sign in again.
 */
const issuedBeforeRevocation = (claims, sessionsRevokedAt) => {
  if (!sessionsRevokedAt) return false;
  const at = new Date(sessionsRevokedAt).getTime();
  if (Number.isFinite(claims?.iatMs)) return claims.iatMs <= at;
  return Number(claims?.iat) <= Math.floor(at / 1000);
};

module.exports = { issuedBeforeRevocation, keyOf, isRevoked, revokeCurrent, revokeAllForUser, purgeExpired };
