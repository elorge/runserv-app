// backend/src/routes/adminGuest.routes.js — operations view of guest bookings (guide §9). Mounted at /api/admin/guest-bookings
// behind the admin router's authenticate + marketGuard, and requireScope('RIDES','DELIVERIES','SUPPORT') at the mount.
'use strict';
const express = require('express');
const { body, param, query } = require('express-validator');
const validate = require('../middleware/validate');
const { authorize } = require('../middleware/auth.middleware');
const c = require('../controllers/adminGuest.controller');

const router = express.Router();

router.get('/', [
  query('service').optional().isIn(['RIDE', 'PARCEL']),
  query('status').optional().isString().isLength({ max: 30 }),
  query('q').optional().isString().isLength({ max: 40 }),
  query('page').optional().isInt({ min: 1, max: 10000 }), query('limit').optional().isInt({ min: 1, max: 100 }),
], validate, c.list);

// static routes BEFORE /:id
router.get('/abuse', c.abuse);
router.get('/sms', [query('status').optional().isIn(['PENDING', 'PROCESSING', 'SENT', 'DEAD', 'SKIPPED']), query('kind').optional().isIn(['GUEST_TRACKING', 'RECIPIENT_CODE'])], validate, c.smsList);
router.post('/sms/:id/retry', authorize('ADMIN', 'SUPER_ADMIN'), param('id').isUUID(), validate, c.smsRetry);
// M16.1: email queue + provider usage. Pause/resume is admin-only and can only REDUCE sending: no route can raise a provider quota.
router.get('/email', [query('status').optional().isIn(['PENDING', 'PROCESSING', 'SENT', 'DEAD', 'SKIPPED']), query('provider').optional().isIn(['brevo', 'resend'])], validate, c.emailList);
router.post('/email/:id/retry', authorize('ADMIN', 'SUPER_ADMIN'), param('id').isUUID(), validate, c.emailRetry);
router.post('/email/providers/:provider/pause', authorize('ADMIN', 'SUPER_ADMIN'), param('provider').isIn(['brevo', 'resend']), validate, c.emailProviderPause(true));
router.post('/email/providers/:provider/resume', authorize('ADMIN', 'SUPER_ADMIN'), param('provider').isIn(['brevo', 'resend']), validate, c.emailProviderPause(false));
router.post('/lookup', [body('reference').isString().trim().matches(/^RS-[A-Z0-9]{6}$/i), body('phone').isString().trim().isLength({ min: 7, max: 20 })], validate, c.lookup);
router.post('/identities/:id/block', authorize('ADMIN', 'SUPER_ADMIN'), param('id').isUUID(), body('reason').isString().trim().isLength({ min: 5, max: 200 }), validate, c.block);
router.post('/identities/:id/unblock', authorize('ADMIN', 'SUPER_ADMIN'), param('id').isUUID(), validate, c.unblock);
// M16.2.1: manual hand-over exception = REQUEST (reason + evidence) then APPROVE (pod-override) or REJECT, by authorised operators. Never reachable by a courier.
router.post('/deliveries/:id/handover-exception/request', authorize('ADMIN', 'SUPER_ADMIN'), param('id').isUUID(), body('reason').isString().trim().isLength({ min: 10, max: 300 }), body('evidence').isString().trim().isLength({ min: 10, max: 300 }), validate, c.exceptionRequest);
router.post('/deliveries/:id/handover-exception/reject', authorize('ADMIN', 'SUPER_ADMIN'), param('id').isUUID(), body('reason').isString().trim().isLength({ min: 5, max: 300 }), validate, c.exceptionReject);
router.post('/deliveries/:id/pod-override', authorize('ADMIN', 'SUPER_ADMIN'), param('id').isUUID(), body('reason').isString().trim().isLength({ min: 10, max: 300 }), validate, c.podOverride);

// M16.2: resend the recipient's hand-over code + tracking link (same code). Reason is mandatory and audited.
router.post('/:id/recipient-notification/resend', authorize('ADMIN', 'SUPER_ADMIN'), param('id').isUUID(), body('reason').isString().trim().isLength({ min: 5, max: 200 }), validate, c.recipientResend);

// M16.2.1: rotate is separate from resend; metrics and the attention list are read-only operations views.
router.post('/:id/recipient-notification/rotate', authorize('ADMIN', 'SUPER_ADMIN'), param('id').isUUID(), body('reason').isString().trim().isLength({ min: 10, max: 200 }), body('confirm').isBoolean({ strict: true }), validate, c.recipientRotate);
router.get('/pilot-metrics', query('hours').optional().isInt({ min: 1, max: 2160 }), validate, c.pilotMetrics);
router.get('/recipient-attention', c.recipientAttention);

router.get('/:id', param('id').isUUID(), validate, c.detail);

module.exports = router;
