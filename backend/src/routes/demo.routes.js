// backend/src/routes/demo.routes.js — public "request a demo" form (mounted at /api/public/demo-requests) + staff inbox (admin.routes).
'use strict';
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { body, param } = require('express-validator');
const prisma = require('../lib/prisma');
const validate = require('../middleware/validate');
const { AppError } = require('../middleware/errorHandler');

const INTERESTS = ['RIDES', 'DELIVERIES', 'CORPORATE', 'FLEET', 'BANK_PARTNERSHIP', 'OTHER'];
const publicRouter = express.Router();
// Five requests per hour per address: enough for a real person, too slow for a form-spamming script.
const limiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Too many requests. Please try again later.' } });

publicRouter.post('/', limiter, [
  body('name').isString().trim().isLength({ min: 2, max: 120 }),
  body('email').isEmail().normalizeEmail(),
  body('phone').optional({ checkFalsy: true }).isString().isLength({ min: 6, max: 30 }),
  body('organisation').optional({ checkFalsy: true }).isString().trim().isLength({ max: 160 }),
  body('interest').isIn(INTERESTS),
  body('message').optional({ checkFalsy: true }).isString().isLength({ max: 1500 }),
], validate, async (req, res) => {
  // A hidden field real visitors never fill in: bots do. Pretend it worked so they learn nothing.
  if (req.body.website) return res.status(201).json({ success: true, message: 'Thank you. We will be in touch.' });
  const ipHash = crypto.createHash('sha256').update(`${req.ip}|${process.env.JWT_SECRET || ''}`).digest('hex').slice(0, 32);
  const dup = await prisma.demoRequest.findFirst({ where: { email: req.body.email, createdAt: { gte: new Date(Date.now() - 86400000) } }, select: { id: true } });
  if (!dup) {
    const row = await prisma.demoRequest.create({ data: { name: req.body.name, email: req.body.email, phone: req.body.phone || null, organisation: req.body.organisation || null, interest: req.body.interest, message: req.body.message || null, ipHash } });
    const to = process.env.DEMO_NOTIFY_EMAIL;
    if (to) {
      const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      require('../services/email.service').sendEmail({ to, subject: `New demo request: ${row.name} (${row.interest})`, html: `<p><b>${esc(row.name)}</b> · ${esc(row.email)} · ${esc(row.phone)}</p><p>${esc(row.organisation)} — ${esc(row.interest)}</p><p>${esc(row.message)}</p>`, text: `${row.name} <${row.email}> ${row.phone || ''}\n${row.organisation || ''} — ${row.interest}\n${row.message || ''}` }).catch(() => {});
    }
  }
  res.status(201).json({ success: true, message: 'Thank you. We will be in touch within one working day.' });
});

const staffRouter = express.Router();
staffRouter.get('/', async (req, res) => {
  const status = ['NEW', 'CONTACTED', 'DEMO_SCHEDULED', 'WON', 'LOST'].includes(req.query.status) ? { status: req.query.status } : {};
  res.json({ success: true, data: { requests: await prisma.demoRequest.findMany({ where: status, orderBy: { createdAt: 'desc' }, take: 200 }) } });
});
staffRouter.patch('/:id', param('id').isString().notEmpty(), [body('status').optional().isIn(['NEW', 'CONTACTED', 'DEMO_SCHEDULED', 'WON', 'LOST']), body('notes').optional().isString().isLength({ max: 1000 })], validate, async (req, res) => {
  const r = await prisma.demoRequest.updateMany({ where: { id: req.params.id }, data: { ...(req.body.status && { status: req.body.status }), ...(req.body.notes !== undefined && { notes: req.body.notes }), handledById: req.user.id } });
  if (r.count !== 1) throw new AppError('Request not found.', 404);
  res.json({ success: true });
});

module.exports = { publicRouter, staffRouter, INTERESTS };
