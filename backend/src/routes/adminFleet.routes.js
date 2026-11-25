// backend/src/routes/adminFleet.routes.js — mounted at /api/admin/fleet (inside admin.routes.js, so
// authentication and the admin-role gate already apply). Writes need ADMIN or SUPER_ADMIN; commercial
// terms and "paid" are SUPER_ADMIN/ADMIN actions that are always written to the audit log.
'use strict';
const express = require('express');
const { body, param } = require('express-validator');
const { authorize } = require('../middleware/auth.middleware');
const validate = require('../middleware/validate');
const globalStaff = require('../middleware/globalStaff');
const c = require('../controllers/adminFleet.controller');

const router = express.Router();
router.use(globalStaff);
const write = authorize('ADMIN', 'SUPER_ADMIN');
const id = param('id').isString().notEmpty();

router.get('/stats', c.stats);
router.get('/partners', c.list);
router.get('/partners/:id', id, validate, c.get);
router.put('/partners/:id/status', write, id, [body('status').isIn(['PENDING', 'UNDER_REVIEW', 'ACTIVE', 'SUSPENDED', 'REJECTED', 'DEACTIVATED']), body('reason').optional().isString().isLength({ max: 500 })], validate, c.setStatus);
router.put('/partners/:id/verification', write, id, [body('status').isIn(['UNVERIFIED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED']), body('notes').optional().isString().isLength({ max: 1000 })], validate, c.setVerification);
router.put('/partners/:id/terms', write, id, [body('commissionRate').optional().isFloat({ min: 0, max: 0.6 }), body('settlementTermsDays').optional().isInt({ min: 0, max: 90 }), body('note').optional().isString()], validate, c.setCommercialTerms);
router.get('/vehicles', c.listVehicles);
router.put('/vehicles/:id/status', write, id, [body('status').isIn(['PENDING', 'ACTIVE', 'IN_SERVICE', 'MAINTENANCE', 'SUSPENDED', 'RETIRED']), body('reason').optional().isString().isLength({ max: 500 })], validate, c.setVehicleStatus);
router.put('/documents/:id/review', write, id, [body('approved').isBoolean(), body('note').optional().isString().isLength({ max: 500 })], validate, c.reviewDocument);

router.get('/settlements', c.listSettlements);
router.post('/settlements', write, [body('fleetPartnerId').isString().notEmpty(), body('periodStart').isISO8601(), body('periodEnd').isISO8601(), body('adjustments').optional().isFloat()], validate, c.createSettlement);
router.put('/settlements/:id/status', write, id, [body('status').isIn(['RECONCILING', 'APPROVED', 'PAID', 'DISPUTED', 'CANCELLED']), body('paymentReference').optional().isString().isLength({ max: 80 }), body('paymentMethod').optional().isString(), body('paidAmount').optional().isFloat({ min: 0 }), body('paymentProofRef').optional().isString().isLength({ max: 300 }), body('paymentNote').optional().isString().isLength({ max: 500 })], validate, c.transitionSettlement);

router.get('/outbox/stats', c.outboxStats);
router.get('/reconciliation/trips', [require('express-validator').query('since').optional().isISO8601(), require('express-validator').query('until').optional().isISO8601()], validate, c.reconcileTrips);
router.post('/reconciliation/trips/repair', write, [body('since').optional().isISO8601(), body('until').optional().isISO8601()], validate, c.repairTrips);

module.exports = router;
