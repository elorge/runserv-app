// backend/src/routes/adminOrg.routes.js — mounted at /api/admin/corporate (inside admin.routes.js, so
// authentication and the admin-role gate already apply).
'use strict';
const express = require('express');
const { body, param } = require('express-validator');
const { authorize } = require('../middleware/auth.middleware');
const { isPhoneAcceptable } = require('../utils/phone');
const c = require('../controllers/adminOrg.controller');

const router = express.Router();
const write = authorize('ADMIN', 'SUPER_ADMIN');
const id = param('id').isString().notEmpty();
const policies = ['APPROVAL_REQUIRED', 'OPEN_SATURDAY', 'OPEN_WEEKEND', 'CLOSED'];

router.get('/stats', c.getStats);
router.get('/companies', c.listCompanies);
router.get('/companies/:id', id, c.getCompany);
router.post('/companies', write, [
  body('name').trim().notEmpty().isLength({ max: 200 }), body('email').isEmail().normalizeEmail(), body('phone').custom(isPhoneAcceptable),
  body('address').optional().isString(), body('rcNumber').optional({ checkFalsy: true }).isString().isLength({ min: 6, max: 20 }), body('billingEmail').optional({ checkFalsy: true }).isEmail(),
  body('commissionRate').optional().isFloat({ min: 0, max: 0.6 }), body('subscriptionFee').optional().isFloat({ min: 0 }),
  body('slug').optional({ checkFalsy: true }).isString(),
  body('admin.firstName').trim().notEmpty(), body('admin.lastName').trim().notEmpty(), body('admin.email').isEmail(),
  body('admin.phone').optional({ checkFalsy: true }).custom(isPhoneAcceptable), body('admin.password').optional().isLength({ min: 8 }),
], c.createCompany);
router.put('/companies/:id/status', write, id, [body('status').isIn(['ACTIVE', 'SUSPENDED', 'PENDING'])], c.setStatus);
router.put('/companies/:id/verification', write, id, [body('status').isIn(['UNVERIFIED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED']), body('notes').optional().isString().isLength({ max: 1000 })], c.setVerification);
router.put('/companies/:id/terms', write, id, [
  body('billingMode').optional().isIn(['PREPAID', 'POSTPAID', 'HYBRID']), body('creditLimit').optional().isFloat({ min: 0 }), body('creditTermsSigned').optional().isBoolean(),
  body('commissionRate').optional().isFloat({ min: 0, max: 0.6 }), body('subscriptionFee').optional().isFloat({ min: 0 }), body('paymentTermsDays').optional().isInt({ min: 0, max: 90 }),
  body('lowBalanceThreshold').optional().isFloat({ min: 0 }), body('timezone').optional().isString(),
], c.setTerms);
router.put('/companies/:id/domain', write, id, [body('slug').optional({ nullable: true, checkFalsy: true }).isString(), body('customDomain').optional({ nullable: true, checkFalsy: true }).isFQDN()], c.setDomain);
router.get('/approvals', c.listApprovals);
router.post('/approvals/:id/approve', write, id, [body('note').optional().isString()], c.approveApproval);
router.post('/approvals/:id/reject', write, id, [body('note').isString().isLength({ min: 3, max: 300 })], c.rejectApproval);
router.post('/companies/:id/wallet/credit', write, id, [body('amount').isFloat({ min: 1 }), body('reference').optional().isString().isLength({ max: 80 }), body('note').optional().isString()], c.creditWallet);
router.post('/companies/:id/wallet/adjust', write, id, [body('amount').isFloat(), body('note').isString().notEmpty()], c.adjustWallet);

router.get('/invoices', c.listInvoices);
router.post('/invoices/generate', write, [body('companyId').optional().isString(), body('period').optional().matches(/^\d{4}-(0[1-9]|1[0-2])$/)], c.generateInvoices);
router.get('/invoices/:id', id, c.getInvoice);
router.post('/invoices/:id/payments', write, id, [body('amount').isFloat({ min: 0.01 }), body('method').optional().isString().isLength({ max: 40 }), body('reference').optional().isString().isLength({ max: 120 }), body('receivedAt').optional().isISO8601(), body('note').optional().isString()], c.recordPayment);
router.post('/invoices/:id/settle-drivers', write, id, c.settleDrivers);
router.put('/invoices/:id/void', write, id, c.voidInvoice);
router.get('/payouts', c.listPayouts);

module.exports = router;
