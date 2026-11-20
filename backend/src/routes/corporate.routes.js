// backend/src/routes/corporate.routes.js — mounted at /api/corporate
'use strict';

const express = require('express');
const { body, param, query } = require('express-validator');
const { isPhoneAcceptable } = require('../utils/phone');
const { authenticate, authorize } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/corporate.controller');

const router = express.Router();
router.use(authenticate);

const portal = ctrl.loadMember;                 // signed-in user has an organisation portal role
const need = ctrl.need;                         // …and this permission (see services/orgAccess.js)
const staff = authorize('CUSTOMER');
const earner = authorize('DRIVER', 'DELIVERY_PARTNER');
const id = param('id').isString().notEmpty();
const period = query('period').optional().matches(/^\d{4}-(0[1-9]|1[0-2])$/).withMessage('period must be YYYY-MM');
const policies = ['APPROVAL_REQUIRED', 'OPEN_SATURDAY', 'OPEN_WEEKEND', 'CLOSED'];
const money = (f) => body(f).optional({ nullable: true, checkFalsy: false }).custom((v) => v === '' || v === null || (!Number.isNaN(Number(v)) && Number(v) >= 0)).withMessage(`${f} must be zero or more`);

// ── Organisation application ─────────────────────────────────────────────────
router.post('/apply', staff, [
  body('name').trim().notEmpty().isLength({ max: 200 }), body('email').isEmail().normalizeEmail(), body('phone').custom(isPhoneAcceptable),
  body('rcNumber').optional().isString().isLength({ min: 6, max: 20 }), body('address').optional().isString(), body('billingEmail').optional({ checkFalsy: true }).isEmail(),
], ctrl.applyForOrganisation);

// ── Portal: profile / settings / branding ────────────────────────────────────
router.get('/profile', portal, ctrl.getPortalProfile);
router.put('/settings', portal, need('manageSettings'), [
  body('weekendPolicy').optional().isIn(policies), body('requireTripPurpose').optional().isBoolean(), body('allowDeliveries').optional().isBoolean(),
  money('maxTripAmount'), money('approvalThreshold'), money('lowBalanceThreshold'),
  body('phone').optional().custom(isPhoneAcceptable), body('billingEmail').optional({ checkFalsy: true }).isEmail(),
], ctrl.updateSettings);
router.put('/branding', portal, need('manageSettings'), [
  body('brandName').optional({ nullable: true }).isString().isLength({ max: 80 }),
  body('brandColor').optional({ nullable: true, checkFalsy: true }).matches(/^#[0-9a-fA-F]{6}$/).withMessage('Use a hex colour like #1D4ED8'),
  body('brandAccent').optional({ nullable: true, checkFalsy: true }).matches(/^#[0-9a-fA-F]{6}$/).withMessage('Use a hex colour like #0EA5E9'),
  body('logoUrl').optional({ nullable: true, checkFalsy: true }).isURL({ protocols: ['https'] }).withMessage('Logo must be an https link'),
  body('tagline').optional({ nullable: true }).isString().isLength({ max: 120 }), body('supportEmail').optional({ nullable: true, checkFalsy: true }).isEmail(),
], ctrl.updateBranding);

router.get('/dashboard', portal, [period], ctrl.getDashboard);

// ── Portal: departments & staff directory ────────────────────────────────────
router.get('/departments', portal, ctrl.listDepartments);
const deptBody = [body('name').optional().trim().isLength({ min: 1, max: 80 }), body('costCenter').optional().isString().isLength({ max: 40 }), money('monthlyBudget'), money('maxTripAmount'), money('approvalThreshold'), body('headEmployeeId').optional({ nullable: true }).isString()];
router.post('/departments', portal, need('manageStaff'), [body('name').trim().notEmpty().isLength({ max: 80 }), ...deptBody.slice(1)], ctrl.createDepartment);
router.put('/departments/:id', portal, need('manageStaff'), id, deptBody, ctrl.updateDepartment);

router.get('/directory', portal, need('manageStaff'), ctrl.listDirectory);
router.post('/directory/import', portal, need('manageStaff'), [body('rows').isArray({ min: 1, max: 5000 })], ctrl.importDirectory);
router.post('/directory/:id/exit', portal, need('manageStaff'), id, ctrl.markDirectoryExit);

// ── Portal: staff ────────────────────────────────────────────────────────────
router.get('/employees', portal, [query('status').optional().isIn(['PENDING', 'ACTIVE', 'REJECTED', 'DELISTED'])], ctrl.listEmployees);
router.get('/employees/:id/history', portal, id, [period], ctrl.getEmployeeHistory);
router.post('/employees/:id/review', portal, need('manageStaff'), id, [
  body('approve').isBoolean().withMessage('approve is required'), body('departmentId').optional({ nullable: true }).isString(), body('supervisorId').optional({ nullable: true }).isString(),
  money('monthlyLimit'), body('note').optional().isString().isLength({ max: 300 }),
], ctrl.reviewEmployee);
router.post('/employees/:id/delist', portal, need('manageStaff'), id, [body('reason').optional().isString().isLength({ max: 120 })], ctrl.delistEmployee);
router.put('/employees/:id/role', portal, need('manageRoles'), id, [body('role').isIn(['ORG_ADMIN', 'HR', 'MANAGER', 'FINANCE', 'STAFF'])], ctrl.setRole);
router.put('/employees/:id', portal, need('manageStaff'), id, [
  money('monthlyLimit'), body('jobTitle').optional().isString(), body('staffNumber').optional().isString().isLength({ min: 1, max: 40 }),
  body('departmentId').optional().isString(), body('supervisorId').optional({ nullable: true }).isString(),
  body('requireTripPurpose').optional().isBoolean(), body('restrictToBusinessHours').optional().isBoolean(),
], ctrl.updateEmployee);

// ── Portal: approvals ────────────────────────────────────────────────────────
router.get('/weekend-requests', portal, need('approveTrips'), [query('status').optional().isIn(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'])], ctrl.listWeekendRequests);
router.post('/weekend-requests/:id/review', portal, need('approveTrips'), id, [body('approve').isBoolean(), body('note').optional().isString().isLength({ max: 300 })], ctrl.reviewWeekendRequest);
router.get('/approvals', portal, need('approveTrips'), [query('status').optional().isIn(['PENDING', 'APPROVED', 'REJECTED', 'USED', 'EXPIRED', 'CANCELLED'])], ctrl.listApprovals);
router.post('/approvals/:id/decide', portal, need('approveTrips'), id, [body('approve').isBoolean(), body('note').optional().isString().isLength({ max: 300 })], ctrl.decideApproval);

// ── Portal: trips & audit ────────────────────────────────────────────────────
router.get('/trips', portal, need('audit'), [
  period, query('page').optional().isInt({ min: 1 }), query('limit').optional().isInt({ min: 1, max: 200 }),
  query('status').optional().isIn(['REQUESTED', 'COMPLETED', 'CANCELLED', 'ALL']), query('type').optional().isIn(['RIDE', 'DELIVERY']),
  query('auditStatus').optional().isIn(['UNREVIEWED', 'VERIFIED', 'FLAGGED']), query('from').optional().isISO8601(), query('to').optional().isISO8601(),
], ctrl.getTrips);
router.put('/trips/:id/audit', portal, need('audit'), id, [body('status').isIn(['UNREVIEWED', 'VERIFIED', 'FLAGGED']), body('note').optional({ nullable: true }).isString().isLength({ max: 500 })], ctrl.auditTrip);

// ── Portal: billing & wallet ─────────────────────────────────────────────────
router.get('/billing', portal, need('seeBilling'), ctrl.getBillingOverview);
router.get('/billing/pay-instructions', portal, need('seeBilling'), ctrl.getPayInstructions);
router.get('/billing/bank-receipts', portal, need('seeBilling'), ctrl.getBankReceipts);
router.get('/invoices/:id', portal, need('seeBilling'), id, ctrl.getInvoiceById);
router.get('/wallet/transactions', portal, need('seeBilling'), ctrl.getWalletTransactions);
router.post('/wallet/topup/initiate', portal, need('seeBilling'), [body('amount').isFloat({ min: 1000, max: 100000000 }).withMessage('Minimum top-up is 1,000'), body('callbackUrl').optional().isURL({ require_tld: false })], ctrl.initiateTopUp);
router.post('/wallet/topup/verify', portal, need('seeBilling'), [body('reference').isString().notEmpty()], ctrl.verifyTopUp);

// ── Staff self-service (mobile) ──────────────────────────────────────────────
router.get('/lookup/:code', staff, ctrl.lookup);
router.get('/my-account', staff, ctrl.getMyAccount);
router.post('/join-request', staff, [
  body('orgCode').trim().notEmpty().withMessage('Enter your organisation code'),
  body('staffNumber').trim().notEmpty().withMessage('Enter your staff ID').isLength({ max: 40 }),
  body('department').optional().isString().isLength({ max: 80 }), body('jobTitle').optional().isString().isLength({ max: 80 }),
], ctrl.requestToJoin);
router.delete('/join-request', staff, ctrl.cancelJoinRequest);
router.post('/leave', staff, ctrl.leave);
router.get('/my-trips', staff, [period], ctrl.getMyTrips);
router.post('/my-weekend-requests', staff, [body('date').matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('date must be YYYY-MM-DD'), body('reason').trim().isLength({ min: 5, max: 300 }).withMessage('Tell your company why you need to ride (at least 5 characters)')], ctrl.createWeekendRequest);
router.delete('/my-weekend-requests/:id', staff, id, ctrl.cancelWeekendRequest);
router.post('/my-approvals', staff, [
  body('serviceType').optional().isIn(['RIDE', 'DELIVERY']), body('pickupAddress').isString().notEmpty(), body('dropoffAddress').isString().notEmpty(),
  body('estimatedFare').isFloat({ min: 0 }), body('distanceKm').optional({ nullable: true }).isFloat({ min: 0 }), body('purpose').optional({ nullable: true }).isString(), body('purposeCategory').optional({ nullable: true }).isString(),
], ctrl.requestApproval);
router.get('/my-approvals/:id', staff, id, ctrl.getMyApproval);

// ── Drivers / partners ───────────────────────────────────────────────────────
router.get('/earnings/summary', earner, ctrl.getEarningsSummary);
router.get('/earnings/trips', earner, [period, query('page').optional().isInt({ min: 1 }), query('limit').optional().isInt({ min: 1, max: 100 })], ctrl.getEarningsTrips);

module.exports = router;
