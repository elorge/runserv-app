// backend/src/routes/adminAlerts.routes.js — WP-08: mounted at /api/admin/alerts
'use strict';
const express = require('express');
const c = require('../controllers/adminAlerts.controller');
const { authenticate, authorize, requireScope } = require('../middleware/auth.middleware');

const router = express.Router();
// Same audience as the alert notifications themselves (opsAlert.staffWhere): deliveries/support staff, general admins, super admins.
// Mounted BEFORE the generic admin router, so it must carry its own guards (no marketGuard there): the controller applies the country scope.
router.use(authenticate, authorize('ADMIN', 'SUPER_ADMIN', 'SUPPORT'), requireScope('DELIVERIES', 'SUPPORT'));
router.get('/', c.list);
router.get('/:id', c.getOne);
router.post('/:id/acknowledge', c.acknowledge);
router.post('/:id/resolve', c.resolve);
module.exports = router;
