// backend/src/routes/delivery.routes.js
const express  = require('express');
const { body, param, query } = require('express-validator'); // ← added query
const deliveryController = require('../controllers/delivery.controller');
const { authenticate, authorize, requirePhone } = require('../middleware/auth.middleware');

const router = express.Router();
router.use(authenticate);

router.get('/estimate', deliveryController.getFeeEstimate);

// ── nearby-partners MUST be before /:id ──────────────────────────────────────
router.get(
  '/nearby-partners',
  authorize('CUSTOMER'),
  [
    query('pickupLat').isFloat({ min: -90, max: 90 }),
    query('pickupLng').isFloat({ min: -180, max: 180 }),
    query('dropoffLat').optional().isFloat({ min: -90, max: 90 }),
    query('dropoffLng').optional().isFloat({ min: -180, max: 180 }),
    query('radiusKm').optional().isFloat({ min: 0.5, max: 50 }),
  ],
  deliveryController.getNearbyPartners
);

router.get('/active',   deliveryController.getActiveDelivery);
router.get('/history',  deliveryController.getDeliveryHistory);

router.post(
  '/request',
  authorize('CUSTOMER'),
  requirePhone,
  [
    body('pickupAddress').notEmpty(),
    body('pickupLat').isFloat({ min: -90, max: 90 }),
    body('pickupLng').isFloat({ min: -180, max: 180 }),
    body('pickupContact').notEmpty(),
    body('dropoffAddress').notEmpty(),
    body('dropoffLat').isFloat({ min: -90, max: 90 }),
    body('dropoffLng').isFloat({ min: -180, max: 180 }),
    body('dropoffContact').notEmpty(),
    body('recipientEmail').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ max: 254 }).isEmail().withMessage('Enter a valid recipient email address.'),   // WP-07: shape here; the required rule is enforced in the controller (deliveryComms.recipientEmailRequired)
    body('packageDescription').notEmpty(),
    body('packageWeight').optional().isFloat({ min: 0 }),
    body('packageValue').optional().isFloat({ min: 0 }),
    body('notes').optional().isString(),
    body('promoCode').optional().isString(),
    body('payer').optional().isIn(['SELF', 'ORGANIZATION']),
    body('purpose').optional({ nullable: true }).isString().isLength({ max: 300 }),
    body('purposeCategory').optional({ nullable: true }).isString().isLength({ max: 30 }),
  ],
  deliveryController.requestDelivery
);

// ── Parameterised routes (after all statics) ──────────────────────────────────
router.get('/:id',  param('id').isUUID(), deliveryController.getDeliveryById);

router.put('/:id/accept',
  authorize('DELIVERY_PARTNER'), param('id').isUUID(), deliveryController.acceptDelivery);

router.put('/:id/pickup',
  authorize('DELIVERY_PARTNER'), param('id').isUUID(), deliveryController.pickupDelivery);

router.put('/:id/transit',
  authorize('DELIVERY_PARTNER'), param('id').isUUID(), deliveryController.startTransit);

router.put(
  '/:id/complete',
  authorize('DELIVERY_PARTNER'),
  param('id').isUUID(),
  [
    body('actualFee').optional().isFloat({ min: 0 }),
    body('recipientName').notEmpty(),
    body('deliveryImageUrl').optional().isURL(),
    body('paymentMethod').optional().isIn(['CASH', 'CARD', 'WALLET']),
  ],
  deliveryController.completeDelivery
);

// M15 proof of delivery: the recipient's code (guest parcels), optional photo, and the failed-delivery / return flow.
router.post('/:id/proof',
  authorize('DELIVERY_PARTNER'), param('id').isUUID(),
  [body('code').isString().matches(/^\d{6}$/), body('photoUrl').optional({ nullable: true }).isString().isLength({ max: 2048 })],
  deliveryController.verifyProof);
router.post('/:id/failed',
  authorize('DELIVERY_PARTNER'), param('id').isUUID(),
  [body('reason').isIn(['RECIPIENT_UNAVAILABLE', 'WRONG_ADDRESS', 'RECIPIENT_REFUSED', 'PARCEL_DAMAGED', 'OTHER']), body('note').optional({ nullable: true }).isString().isLength({ max: 300 }), body('photoUrl').optional({ nullable: true }).isString().isLength({ max: 2048 })],
  deliveryController.failDelivery);
router.post('/:id/returned',
  authorize('DELIVERY_PARTNER'), param('id').isUUID(), deliveryController.confirmReturned);

router.put('/:id/cancel',
  param('id').isUUID(),
  [body('reason').optional().isString()],
  deliveryController.cancelDelivery);

router.post(
  '/:id/rate',
  param('id').isUUID(),
  [body('rating').isInt({ min: 1, max: 5 }), body('comment').optional().isString()],
  deliveryController.rateDelivery
);

module.exports = router;