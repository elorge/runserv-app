// backend/src/routes/adminMaps.routes.js — mounted at /api/admin/maps (admin gate already applies). SUPER_ADMIN only.
'use strict';
const express = require('express');
const { body } = require('express-validator');
const { authorize } = require('../middleware/auth.middleware');
const validate = require('../middleware/validate');
const c = require('../controllers/maps.controller');

const router = express.Router();
router.use(authorize('SUPER_ADMIN'));
router.get('/config', c.adminGet);
router.put('/config', [body('renderer').optional().isString(), body('routing').optional().isString(), body('places').optional().isString(), body('styleUrl').optional({ nullable: true }).isString().isLength({ max: 500 }), body('routingFallback').optional().isBoolean(), body('acknowledgeTerms').optional().isBoolean()], validate, c.adminSet);
router.post('/test-route', [body('from.latitude').isFloat({ min: -90, max: 90 }), body('from.longitude').isFloat({ min: -180, max: 180 }), body('to.latitude').isFloat({ min: -90, max: 90 }), body('to.longitude').isFloat({ min: -180, max: 180 })], validate, c.adminTest);
module.exports = router;
