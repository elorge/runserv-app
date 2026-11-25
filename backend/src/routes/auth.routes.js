// backend/src/routes/auth.routes.js
const express = require('express');
const { body } = require('express-validator');
const authController = require('../controllers/auth.controller');
const { isPhoneAcceptable, registrationPhoneCheck } = require('../utils/phone');
const { authenticate } = require('../middleware/auth.middleware');

const rateLimit = require('express-rate-limit');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many OTP requests, please try again later.' },
});

const router = express.Router();

// ── Public ────────────────────────────────────────────────────────────────────

router.post(
  '/register',
  authLimiter,
  [
    body('email').isEmail().normalizeEmail(),
    // Country-aware (see utils/phone.js): Nigeria keeps its old format, every other
    // market needs +<its dial code> and must match the selected country.
    body('countryCode').optional().isString().isLength({ min: 2, max: 2 }),
    body('phone').custom(registrationPhoneCheck),
    body('password').isLength({ min: 8 }),
    body('firstName').trim().notEmpty(),
    body('lastName').trim().notEmpty(),
    body('role').isIn(['CUSTOMER', 'DRIVER', 'DELIVERY_PARTNER']),
  ],
  authController.register
);

router.post(
  '/login',
  authLimiter,
  [
    body('email').optional().isEmail().normalizeEmail(),
    body('phone').optional().custom(isPhoneAcceptable).withMessage('Invalid phone number'),
    body('password').notEmpty(),
  ],
  authController.login
);

router.post(
  '/verify-otp',
  [
    body('code').isLength({ min: 6, max: 6 }).isNumeric(),
    body('tempToken').notEmpty(),
  ],
  authController.verifyOtp
);

router.post(
  '/resend-otp',
  otpLimiter,
  [body('tempToken').notEmpty()],
  authController.resendOtp
);

router.post(
  '/forgot-password',
  authLimiter,
  [body('email').isEmail().normalizeEmail()],
  authController.forgotPassword
);

router.post(
  '/reset-password/:token',
  [body('password').isLength({ min: 8 })],
  authController.resetPassword
);

router.get('/reset-password/:token', authController.getResetPasswordForm);

router.get('/verify-email/:token', authController.verifyEmail);

// ── Private ───────────────────────────────────────────────────────────────────

router.post('/google', authLimiter, [body('idToken').isString().notEmpty()], authController.googleAuth);
router.post('/phone/request', authenticate, otpLimiter, [body('phone').custom(registrationPhoneCheck), body('countryCode').optional().isString().isLength({ min: 2, max: 2 })], authController.requestPhoneVerification);
router.post('/phone/verify', authenticate, otpLimiter, [body('code').isString().notEmpty(), body('tempToken').isString().notEmpty(), body('phoneToken').isString().notEmpty()], authController.verifyPhone);

// Staff two-step sign-in (authenticator app). A staff password-only token can reach ONLY these.
router.post('/mfa/setup',   authenticate, otpLimiter, authController.mfaSetup);
router.post('/mfa/enable',  authenticate, otpLimiter, [body('code').isString().isLength({ min: 6, max: 8 })], authController.mfaEnable);
router.post('/mfa/verify',  authenticate, otpLimiter, [body('code').optional().isString().isLength({ min: 6, max: 8 }), body('backupCode').optional().isString().isLength({ min: 10, max: 14 })], authController.mfaVerify);
router.post('/mfa/disable', authenticate, otpLimiter, [body('code').isString().isLength({ min: 6, max: 8 })], authController.mfaDisable);
router.get('/me', authenticate, authController.getCurrentUser);

router.post('/refresh', authenticate, authController.refreshToken);

router.post('/logout', authenticate, authController.logout);
router.post('/logout-all', authenticate, authController.logoutAll);   // WP-03

router.post('/resend-verification-email', authLimiter, [body('email').isEmail().normalizeEmail()], authController.resendVerificationByEmail);

router.post(
  '/2fa/setup',
  authenticate,
  [body('method').optional().isIn(['SMS', 'EMAIL'])],
  authController.setupTwoFactor
);

router.post(
  '/2fa/enable',
  authLimiter,
  authenticate,
  [body('method').optional().isIn(['EMAIL'])],
  authController.enableTwoFactor
);

router.post(
  '/2fa/confirm',
  authenticate,
  [
    body('code').isLength({ min: 6, max: 6 }).isNumeric(),
    body('tempToken').notEmpty(),
    body('method').optional().isIn(['SMS', 'EMAIL']),
  ],
  authController.confirmSetupTwoFactor
);

router.post(
  '/2fa/disable',
  authenticate,
  [body('password').notEmpty()],
  authController.disableTwoFactor
);

module.exports = router;