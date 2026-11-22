// backend/src/middleware/auth.middleware.js

'use strict';
const jwt    = require('jsonwebtoken');
const prisma = require('../lib/prisma');
const { logActivity } = require('../utils/auditLog'); // ← ADDED

// ─── audit logging for denied access ─── ADDED ────────────────────────────────
// Fire-and-forget — a logging failure must never delay or block the 403 response.
const logAccessDenied = (req, requiredRoles) => {
  if (!req.user) return; // authenticate() already returned 401, no actor to attribute
  logActivity({
    userId:     req.user.id,
    action:     'authorization_denied',
    entityType: 'Route',
    details: {
      path:            req.originalUrl,
      method:          req.method,
      requiredRoles,
      actualRole:      req.user.role,
      adminDepartment: req.user.adminDepartment ?? null,
    },
    req,
  });
};
// ─── END ADDED ─────────────────────────────────────────────────────────────────

// ─── authenticate ─────────────────────────────────────────────────────────────
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer '))
      return res.status(401).json({ success: false, message: 'Access denied. No token provided.' });

    const token   = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: {
          id: true, email: true, phone: true,
          firstName: true, lastName: true,
          role: true, isVerified: true, isActive: true, isSuspended: true,
          adminDepartment: true,
          supportCountries: true,
          supportLanguages: true,
          // Every country-aware lookup (payment options, limits, transfer minimums,
          // phone dial code…) reads req.user.countryCode. Without it they all
          // silently fell back to Nigeria for every non-Nigerian user.
          countryCode: true,
          authProvider: true,
          passwordChangedAt: true,
          mfaEnabled: true,
        },
      });

if (!user)          return res.status(401).json({ success: false, message: 'Invalid token. User not found.' });
    if (!user.isActive) return res.status(403).json({ success: false, message: 'Account is deactivated.' });
    // M15: a guest identity has a backing User row but must never reach an authenticated route (it acts only via a GuestSession).
    if (user.authProvider === 'GUEST') return res.status(403).json({ success: false, code: 'GUEST_NOT_ALLOWED', message: 'Please create an account or sign in to use this.' });
    if (user.isSuspended) return res.status(403).json({ success: false, message: 'Account is suspended. Contact support.' });

    if (user.passwordChangedAt) {
      const changedAt = Math.floor(user.passwordChangedAt.getTime() / 1000);
      if (decoded.iat < changedAt) {
        return res.status(401).json({ success: false, message: 'Password was changed. Please log in again.' });
      }
    }

    // Staff need a token that passed the second step. A password-only token (every sign-in route issues one, including
    // OTP and social sign-in) may only reach the two-step routes, so no sign-in path can skip it.
    if (['ADMIN', 'SUPER_ADMIN', 'MODERATOR', 'SUPPORT'].includes(user.role) && (user.mfaEnabled || process.env.REQUIRE_STAFF_MFA === 'true') && !decoded.mfa) {
      const url = `${req.baseUrl || ''}${req.path || ''}`;
      if (!/\/auth\/mfa(\/|$)/.test(url)) {
        return res.status(401).json({ success: false, code: 'MFA_REQUIRED', mfaEnrolled: !!user.mfaEnabled, message: user.mfaEnabled ? 'Enter your authenticator code to continue.' : 'Set up two-step sign-in to continue.' });
      }
    }

    req.user = user;
    req.tokenMfa = !!decoded.mfa;
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError') return res.status(401).json({ success: false, message: 'Invalid token.' });
    if (err.name === 'TokenExpiredError') return res.status(401).json({ success: false, message: 'Token expired.' });
    return res.status(500).json({ success: false, message: 'Authentication failed.' });
  }
};

// ─── authorize (role-based) ───────────────────────────────────────────────────
const authorize = (...roles) => (req, res, next) => {
  if (!req.user)
    return res.status(401).json({ success: false, message: 'Unauthorized.' });
  if (!roles.includes(req.user.role)) {
    logAccessDenied(req, roles); // ← ADDED
    return res.status(403).json({ success: false, message: `Access denied. Requires role: ${roles.join(' or ')}.` });
  }
  next();
};

// ─── requireScope (department-based) ─────────────────────────────────────────
//
// Usage:  router.get('/drivers', authenticate, requireScope('RIDES'), handler)
//
// Passes when:
//   1. SUPER_ADMIN — always
//   2. ADMIN with no department (null) — general admin, always
//   3. ADMIN with matching department — e.g. RIDES admin on a RIDES route
//   4. SUPPORT role on SUPPORT scope
//
const requireScope = (...scopes) => (req, res, next) => {
  if (!req.user)
    return res.status(401).json({ success: false, message: 'Unauthorized.' });

  const { role, adminDepartment } = req.user;

  // Super admin bypasses all scope checks
  if (role === 'SUPER_ADMIN') return next();

  // General admin (no department) has access to all admin scopes
  if (role === 'ADMIN' && adminDepartment === null) return next();

  // Scoped admin — must match at least one of the required scopes
  if (role === 'ADMIN' && scopes.includes(adminDepartment)) return next();

  // Support role — only allowed on SUPPORT scope
  if (role === 'SUPPORT' && scopes.includes('SUPPORT')) return next();

  logAccessDenied(req, scopes); // ← ADDED

  return res.status(403).json({
    success: false,
    message: `Access denied. Your account (${role}${adminDepartment ? `/${adminDepartment}` : ''}) is not authorised for this section.`,
  });
};

// ─── helpers for common combos ────────────────────────────────────────────────
const isAdminOrSuper  = authorize('ADMIN', 'SUPER_ADMIN', 'SUPPORT');
const isSuperAdmin    = authorize('SUPER_ADMIN');
const isRidesAdmin    = [authenticate, requireScope('RIDES')];
const isDeliveryAdmin = [authenticate, requireScope('DELIVERIES')];
const isSupportAgent  = [authenticate, requireScope('SUPPORT')];

// Aliases kept for legacy references
const protect    = authenticate;
const restrictTo = authorize;

/** People who signed up with Google add their phone number before booking (drivers need to call them). */
const requirePhone = (req, res, next) => {
  if (req.user?.phone) return next();
  return res.status(400).json({ success: false, code: 'PHONE_REQUIRED', message: 'Add your phone number to book a ride or delivery.' });
};

module.exports = {
  authenticate, authorize, requireScope, requirePhone,
  protect, restrictTo,
  isAdminOrSuper, isSuperAdmin,
  isRidesAdmin, isDeliveryAdmin, isSupportAgent,
};
