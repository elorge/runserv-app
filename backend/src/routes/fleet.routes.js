// backend/src/routes/fleet.routes.js — Fleet Partner Portal, mounted at /api/fleet
'use strict';
const express = require('express');
const { body, param, query } = require('express-validator');
const { authenticate } = require('../middleware/auth.middleware');
const validate = require('../middleware/validate');
const { isPhoneAcceptable } = require('../utils/phone');
const { loadMember } = require('../services/fleetAccess');
const uploadService = require('../services/upload.service');
const c = require('../controllers/fleet.controller');
const rateLimit = require('express-rate-limit');
const { isFleetDocumentRef } = require('../utils/trustedFileUrl');

// Applying creates a fleet record and a pending review for staff: cap it per signed-in user so it cannot be used to flood the queue.
const applyLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => req.user?.id || req.ip, message: { success: false, message: 'Too many applications. Please try again later.' } });
const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => req.user?.id || req.ip, message: { success: false, message: 'Too many uploads. Please wait a moment.' } });

const router = express.Router();
router.use(authenticate);

const id = param('id').isString().notEmpty();
const roles = ['ADMIN', 'FLEET_MANAGER', 'OPERATIONS', 'FINANCE', 'VIEWER'];
const { isCategoryEnabled, KNOWN: KNOWN_TYPES } = require('../utils/vehicleCategories');
const types = KNOWN_TYPES;
const enabledType = (v) => isCategoryEnabled(v);
const date = (f) => body(f).optional({ nullable: true, checkFalsy: true }).isISO8601().toDate();

router.post('/apply', applyLimiter, [
  body('legalName').trim().notEmpty().isLength({ max: 200 }), body('tradingName').optional().isString().isLength({ max: 200 }),
  body('email').isEmail().normalizeEmail(), body('phone').custom(isPhoneAcceptable),
  body('rcNumber').optional({ checkFalsy: true }).isString().isLength({ min: 6, max: 20 }), body('taxId').optional().isString(), body('address').optional().isString(),
], validate, c.apply);

// Accepting an invitation is done by a signed-in person who does not have a fleet yet, so it sits before loadMember.
const acceptLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => req.user?.id || req.ip, message: { success: false, message: 'Too many attempts. Please try again later.' } });
router.post('/invitations/accept', acceptLimiter, [body('token').isString().isLength({ min: 20, max: 100 })], validate, c.acceptInvitation);

router.use(loadMember);
const { need } = require('../services/fleetAccess');

router.get('/profile', c.profile);
router.put('/profile', need('manageSettings'), [
  body('email').optional().isEmail(), body('phone').optional().custom(isPhoneAcceptable), body('supportEmail').optional({ checkFalsy: true }).isEmail(),
  body('payoutAccountNumber').optional().matches(/^\d{10}$/).withMessage('Account number must be 10 digits'), body('payoutBankCode').optional().isString().isLength({ max: 10 }),
], validate, c.updateProfile);
router.get('/overview', c.overview);

router.get('/users', c.listUsers);
router.post('/users', [body('email').isEmail(), body('role').isIn(roles)], validate, c.addUser);
router.put('/users/:id', id, [body('role').optional().isIn(roles), body('isActive').optional().isBoolean()], validate, c.updateUser);

router.get('/vehicles', c.listVehicles);
router.get('/vehicles/:id', id, validate, c.getVehicle);
router.post('/vehicles', [
  body('vehicleType').isIn(types).bail().custom(enabledType).withMessage('That vehicle category is not available yet.'), body('make').trim().notEmpty(), body('model').trim().notEmpty(), body('registrationNumber').trim().isLength({ min: 4, max: 16 }),
  body('modelYear').optional().isInt({ min: 1990, max: 2100 }), body('seatingCapacity').optional().isInt({ min: 1, max: 60 }), body('payloadCapacityKg').optional().isFloat({ min: 0 }),
  date('insuranceExpiresAt'), date('roadworthyExpiresAt'), date('permitExpiresAt'),
], validate, c.createVehicle);
router.put('/vehicles/:id', id, [body('vehicleType').optional().isIn(types).bail().custom(enabledType).withMessage('That vehicle category is not available yet.'), date('insuranceExpiresAt'), date('roadworthyExpiresAt'), date('permitExpiresAt'), body('modelYear').optional().isInt({ min: 1990, max: 2100 })], validate, c.updateVehicle);

router.get('/documents', c.listDocuments);
// Step 1 of adding a document: store the file (JPEG/PNG/PDF, 5 MB). Step 2: POST /documents with the returned url.
router.post('/documents/upload', uploadLimiter, need('manageDocuments'), ...uploadService.uploadPrivateSingle('file', 'runserv/fleet/documents'), c.uploadDocumentFile);
router.post('/documents', [
  body('documentType').trim().notEmpty().isLength({ max: 60 }), body('fileUrl').custom((v) => isFleetDocumentRef(v)).withMessage('fileUrl must be a file uploaded through Runserv'),
  body('vehicleId').optional({ checkFalsy: true }).isString(), date('issuedAt'), date('expiresAt'),
], validate, c.addDocument);

router.get('/drivers', c.listDrivers);
router.post('/assignments', [body('vehicleId').isString().notEmpty(), body('driverUserId').optional().isString(), body('driverEmail').optional().isEmail()], validate, c.assign);
router.put('/assignments/:id/end', id, validate, c.endAssignment);

router.get('/trips', [query('status').optional().isIn(['OFFERED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'DISPUTED']), query('exceptions').optional().isBoolean()], validate, c.listTrips);
router.get('/invitations', c.listInvitations);
router.post('/invitations', need('manageUsers'), [body('email').isEmail(), body('role').isIn(roles)], validate, c.invite);
router.delete('/invitations/:id', need('manageUsers'), id, validate, c.revokeInvitation);
router.get('/shifts', [query('from').optional().isISO8601(), query('to').optional().isISO8601()], validate, c.listShifts);
router.post('/shifts', need('assignDrivers'), [body('vehicleId').isString().notEmpty(), body('driverUserId').isString().notEmpty(), body('startsAt').isISO8601(), body('endsAt').isISO8601(), body('note').optional({ nullable: true }).isString().isLength({ max: 300 })], validate, c.createShift);
router.delete('/shifts/:id', need('assignDrivers'), id, validate, c.cancelShift);
router.get('/settlements', c.listSettlements);
router.get('/settlements/:id', id, validate, c.getSettlement);
router.post('/settlements/:id/dispute', id, [body('note').isString().notEmpty().isLength({ max: 1000 })], validate, c.dispute);

module.exports = router;
