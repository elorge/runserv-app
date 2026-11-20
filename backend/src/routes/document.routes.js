// backend/src/routes/document.routes.js — M13: POST /api/documents/access  { source, id, field, reason? } -> { url, expiresAt }
'use strict';
const express = require('express');
const { body } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { authenticate } = require('../middleware/auth.middleware');
const validate = require('../middleware/validate');
const { requestDocumentAccess, SOURCES } = require('../services/documentAccess.service');

const router = express.Router();
router.use(authenticate);
const limiter = rateLimit({ windowMs: 60 * 1000, max: 60, keyGenerator: (req) => req.user?.id || req.ip, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Too many document requests. Slow down.' } });

router.post('/access', limiter, [
  body('source').isIn(Object.keys(SOURCES)), body('id').isString().notEmpty().isLength({ max: 64 }),
  body('field').isString().isLength({ max: 40 }), body('reason').optional({ nullable: true }).isString().isLength({ max: 200 }),
], validate, async (req, res) => {
  const r = await requestDocumentAccess({ user: req.user, source: req.body.source, id: req.body.id, field: req.body.field, reason: req.body.reason, req });
  res.set('Cache-Control', 'no-store').json({ success: true, data: r });
});

module.exports = router;
