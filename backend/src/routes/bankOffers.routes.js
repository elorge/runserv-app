// backend/src/routes/bankOffers.routes.js — mounted at /api/offers (customers) and /api/bank-webhooks (banks)
'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const { body, param } = require('express-validator');
const { authenticate } = require('../middleware/auth.middleware');
const validate = require('../middleware/validate');
const c = require('../controllers/bankOffers.controller');

const limiter = (max) => rateLimit({ windowMs: 60 * 1000, max, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Too many requests, please try again shortly.' } });
const svc = require('../services/bankOffers.service');
// Quote / redeem stay closed until the fare-application rule is decided (BANK_TRIP_BENEFITS_ENABLED). Release is never blocked: it only gives budget back.
const tripBenefitsOn = (_req, res, next) => (svc.tripBenefitsEnabled() ? next() : res.status(404).json({ success: false, message: 'This feature is not available yet.' }));
const id = param('id').isString().notEmpty();

const offers = express.Router();
offers.use(authenticate);
offers.get('/', c.list);
offers.post('/impressions', limiter(30), [body('offerIds').isArray({ min: 1, max: 20 }), body('offerIds.*').isString()], validate, c.impressions);
offers.get('/:id', id, validate, c.get);
offers.post('/:id/click', limiter(10), id, validate, c.click);
offers.post('/:id/quote', tripBenefitsOn, limiter(30), id, [body('amount').isFloat({ gt: 0 })], validate, c.quote);
offers.post('/:id/redeem', tripBenefitsOn, limiter(10), id, [body('idempotencyKey').isString().isLength({ min: 8, max: 80 }), body('rideId').optional().isString(), body('deliveryId').optional().isString()], validate, c.redeem);
offers.post('/redemptions/:id/release', limiter(10), id, validate, c.release);

const webhooks = express.Router();
webhooks.post('/:bankPartnerId', limiter(120), c.callback); // body is raw (see app.js)

module.exports = { offers, webhooks };
