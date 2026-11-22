// backend/src/routes/adminPayments.routes.js
// Payments → Provider Management. Reads: ADMIN / SUPER_ADMIN. Changes to settings, secrets, enabling, approvals and manual
// resolution: SUPER_ADMIN only. Disabling (kill switch) is allowed to ADMIN too. Mounted under /api/admin.
'use strict';
const express = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const { authorize } = require('../middleware/auth.middleware');
const c = require('../controllers/adminPayments.controller');

const r = express.Router();
const staff = authorize('ADMIN', 'SUPER_ADMIN');
const sup = authorize('SUPER_ADMIN');
const env = body('environment').isIn(['SANDBOX', 'LIVE']);
const target = [param('key').isIn(['paystack', 'flutterwave', 'orange', 'mtn_momo']), param('country').isLength({ min: 2, max: 2 })];

r.get('/payment-providers', staff, c.directory);
r.get('/payment-providers/change-requests', staff, c.listChangeRequests);
r.post('/payment-providers/change-requests/:id/approve', sup, param('id').isUUID(), validate, c.approve);
r.post('/payment-providers/change-requests/:id/reject', sup, param('id').isUUID(), validate, c.reject);
r.put('/payment-providers/:key/:country/settings', sup, target, env, body('onboardingStatus').optional().isIn(['PLANNED', 'AWAITING_ONBOARDING', 'SANDBOX_ACCESS', 'CERTIFICATION', 'PRODUCTION_APPROVED']), body('capabilities').optional().isObject(), body('safeConfig').optional().isObject(), validate, c.updateSettings);
r.post('/payment-providers/:key/:country/enable', sup, target, env, body('reason').isString().isLength({ min: 5, max: 300 }), validate, c.enable);
r.post('/payment-providers/:key/:country/disable', staff, target, env, body('reason').optional().isString().isLength({ max: 300 }), validate, c.disable);
r.put('/payment-providers/:key/:country/secrets', sup, target, env, body('values').isObject(), validate, c.setSecrets);

r.get('/payment-ops/payments/:id/events', staff, param('id').isUUID(), validate, c.events);
r.post('/payment-ops/payments/:id/resolve', sup, param('id').isUUID(), body('outcome').isIn(['COMPLETE', 'FAIL']), body('note').isString(), validate, c.resolve);
r.get('/payment-ops/exceptions', staff, c.exceptions);
r.post('/payment-ops/exceptions/:id/resolve', sup, param('id').isUUID(), body('resolution').isString().isLength({ min: 5, max: 300 }), body('dismiss').optional().isBoolean(), validate, c.resolveException);
r.post('/payment-ops/sweep', sup, c.sweep);
r.get('/payment-ops/audit', staff, c.audit);
r.get('/payment-ops/reconciliation', staff, c.reconciliationRuns);
r.post('/payment-ops/reconciliation', sup, body('provider').isString(), body('periodFrom').isISO8601(), body('periodTo').isISO8601(), body('source').isString().isLength({ min: 2, max: 200 }), body('rows').isArray({ min: 1, max: 5000 }), validate, c.reconcile);

module.exports = r;
