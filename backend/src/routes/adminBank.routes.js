// backend/src/routes/adminBank.routes.js — mounted at /api/admin/banks (inside admin.routes.js)
'use strict';
const express = require('express');
const { body, param } = require('express-validator');
const { authorize } = require('../middleware/auth.middleware');
const validate = require('../middleware/validate');
const globalStaff = require('../middleware/globalStaff');
const c = require('../controllers/adminBank.controller');

const router = express.Router();
router.use(globalStaff);
const write = authorize('ADMIN', 'SUPER_ADMIN');
const id = param('id').isString().notEmpty();
const https = (f) => body(f).optional({ nullable: true, checkFalsy: true }).isURL({ protocols: ['https'], require_protocol: true }).withMessage(`${f} must be an https link`);
const optDate = (f) => body(f).optional({ nullable: true, checkFalsy: true }).isISO8601().toDate();
const bankBody = [body('legalName').optional().trim().notEmpty(), body('displayName').optional().trim().notEmpty(), https('logoUrl'), https('websiteUrl'), body('contactEmail').optional({ checkFalsy: true }).isEmail(), optDate('agreementStartAt'), optDate('agreementEndAt'), body('agreementReference').optional().isString().isLength({ max: 120 }), body('countryCode').optional().isISO31661Alpha2()];
const offerBody = [
  body('offerType').optional().isIn(['DISCOUNT', 'CASHBACK', 'SPONSORED_RIDE', 'SPONSORED_DELIVERY', 'DEFERRED_PAYMENT', 'CREDIT', 'ACCOUNT_OPENING']),
  body('eligibilityType').optional().isIn(['PUBLIC', 'EXISTING_BANK_CUSTOMERS', 'NEW_BANK_CUSTOMERS', 'INVITATION_ONLY', 'BANK_APPROVAL_REQUIRED']),
  body('discountPercent').optional({ nullable: true }).isFloat({ min: 0.01, max: 100 }), body('discountAmount').optional({ nullable: true }).isFloat({ min: 0.01 }),
  body('maxBenefitAmount').optional({ nullable: true }).isFloat({ min: 0.01 }), body('minTripAmount').optional({ nullable: true }).isFloat({ min: 0 }),
  body('redemptionLimit').optional({ nullable: true }).isInt({ min: 1 }), body('perCustomerLimit').optional({ nullable: true }).isInt({ min: 1 }), https('accountOpeningUrl'),
];

router.get('/partners', c.listPartners);
router.post('/partners', write, [body('legalName').trim().notEmpty(), body('displayName').trim().notEmpty(), ...bankBody], validate, c.createPartner);
router.put('/partners/:id', write, id, bankBody, validate, c.updatePartner);
router.put('/partners/:id/status', write, id, [body('status').isIn(['PROSPECT', 'DUE_DILIGENCE', 'CONTRACT_PENDING', 'ACTIVE', 'PAUSED', 'TERMINATED']), body('reason').optional().isString().isLength({ max: 500 })], validate, c.setPartnerStatus);

router.get('/campaigns', c.listCampaigns);
router.post('/campaigns', write, [body('bankPartnerId').isString().notEmpty(), body('name').trim().notEmpty().isLength({ max: 200 }), optDate('startsAt'), optDate('endsAt'), body('budgetAmount').optional({ nullable: true }).isFloat({ min: 0 }), https('landingPageUrl'), body('attributionWindowDays').optional().isInt({ min: 1, max: 365 }), body('offers').optional().isArray({ max: 20 }), body('offers.*.title').optional().trim().notEmpty()], validate, c.createCampaign);
router.get('/campaigns/:id', id, validate, c.getCampaign);
router.put('/campaigns/:id', write, id, [body('name').optional().trim().notEmpty(), optDate('startsAt'), optDate('endsAt'), body('budgetAmount').optional({ nullable: true }).isFloat({ min: 0 }), https('landingPageUrl'), body('attributionWindowDays').optional().isInt({ min: 1, max: 365 })], validate, c.updateCampaign);
router.get('/campaigns/:id/report', id, validate, c.report);
router.post('/campaigns/:id/offers', write, id, [body('title').trim().notEmpty().isLength({ max: 200 }), body('termsAndConditions').trim().notEmpty(), body('offerType').isIn(['DISCOUNT', 'CASHBACK', 'SPONSORED_RIDE', 'SPONSORED_DELIVERY', 'DEFERRED_PAYMENT', 'CREDIT', 'ACCOUNT_OPENING']), ...offerBody], validate, c.addOffer);
router.post('/campaigns/:id/:action(submit|approve|reject|pause|resume|cancel)', write, id, [body('confirmWrittenApproval').optional().isBoolean({ strict: true }), body('note').optional().isString().isLength({ max: 500 }), body('reason').optional().isString().isLength({ max: 500 })], validate, c.campaignAction);
router.put('/offers/:id', write, id, offerBody, validate, c.updateOffer);
router.delete('/offers/:id', write, id, validate, c.deleteOffer);

router.get('/settlements', c.listSettlements);
router.post('/settlements', write, [body('bankPartnerId').isString().notEmpty(), body('campaignId').optional({ nullable: true }).isString(), body('periodStart').isISO8601(), body('periodEnd').isISO8601(), body('agreedAmount').isFloat({ min: 0 }), body('adjustmentsAmount').optional().isFloat(), body('invoiceReference').optional().isString().isLength({ max: 120 })], validate, c.createSettlement);
router.put('/settlements/:id/status', write, id, [body('status').isIn(['RECONCILING', 'APPROVED', 'PAID', 'DISPUTED', 'CANCELLED']), body('bankTransactionRef').optional().isString().isLength({ min: 6, max: 80 })], validate, c.transitionSettlement);

// Runserv's own account at each bank, the bank's signing secret, payment instructions and money received.
router.get('/receiving-accounts', c.listAccounts);
router.post('/receiving-accounts', write, [body('bankPartnerId').isString().notEmpty(), body('accountName').isString().isLength({ min: 3, max: 120 }), body('accountNumber').isString().isLength({ min: 6, max: 40 }), body('bankName').optional().isString().isLength({ max: 120 }), body('currency').optional().isString().isLength({ min: 3, max: 3 }), body('label').optional({ nullable: true }).isString().isLength({ max: 80 }), body('isPrimary').optional().isBoolean()], validate, c.createAccount);
router.put('/receiving-accounts/:id', write, id, [body('isActive').optional().isBoolean(), body('isPrimary').optional().isBoolean(), body('label').optional({ nullable: true }).isString().isLength({ max: 80 })], validate, c.updateAccount);
router.post('/partners/:id/webhook-secret', write, id, validate, c.rotateSecret);
router.get('/settlements/:id/payment-instructions', id, validate, c.paymentInstructions);
router.get('/payments/summary', c.paymentsSummary);
router.get('/payments', c.listPayments);
router.post('/payments/manual', write, [body('bankPartnerId').isString().notEmpty(), body('bankTransactionRef').isString().isLength({ min: 6, max: 80 }), body('amount').isFloat({ gt: 0 }), body('currency').optional().isString().isLength({ min: 3, max: 3 }), body('paidAt').optional().isISO8601(), body('reference').optional().isString().isLength({ max: 200 }), body('payerName').optional().isString().isLength({ max: 120 }), body('creditedAccountNumber').optional().isString().isLength({ max: 40 }), body('confirmSeenOnStatement').isBoolean({ strict: true })], validate, c.recordManualPayment);
router.post('/payments/:id/match', write, id, [body('settlementId').optional().isString(), body('invoiceId').optional().isString(), body('companyId').optional().isString(), body('note').isString().isLength({ min: 3, max: 500 })], validate, c.matchPayment);
router.post('/payments/:id/approve', write, id, [body('note').optional().isString().isLength({ max: 500 })], validate, c.approveReview);
router.post('/payments/:id/reject', write, id, [body('note').isString().isLength({ min: 3, max: 500 })], validate, c.rejectReview);
router.get('/payments/by-account', c.paymentsByAccount);
router.post('/payments/alerts/run', write, c.runAlerts);
router.get('/statements', c.listStatementImports);
router.post('/statements/import', write, [body('bankPartnerId').isString().notEmpty(), body('receivingAccountId').isString().notEmpty(), body('fileName').optional().isString().isLength({ max: 200 }), body('csvText').isString().isLength({ min: 20 })], validate, c.importStatement);
router.post('/payments/:id/reverse', write, id, [body('note').isString().isLength({ min: 3, max: 500 })], validate, c.reversePayment);

module.exports = router;
