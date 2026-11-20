// backend/src/routes/maps.routes.js — M14: POST /api/maps/route (authenticated, rate-limited)
'use strict';
const express = require('express');
const { body } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { authenticate } = require('../middleware/auth.middleware');
const validate = require('../middleware/validate');
const c = require('../controllers/maps.controller');

const router = express.Router();
router.use(authenticate);
const limiter = rateLimit({ windowMs: 60 * 1000, max: 120, keyGenerator: (req) => req.user?.id || req.ip, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Too many route requests.' } });
router.post('/route', limiter, [body('from').isObject(), body('to').isObject(), body('from.latitude').isFloat({ min: -90, max: 90 }), body('from.longitude').isFloat({ min: -180, max: 180 }), body('to.latitude').isFloat({ min: -90, max: 90 }), body('to.longitude').isFloat({ min: -180, max: 180 })], validate, c.route);
module.exports = router;
