// backend/src/app.js
const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const morgan   = require('morgan');
const path     = require('path');
const fs       = require('fs');
const rateLimit = require('express-rate-limit');
require('express-async-errors');

// ─── Routes ──────────────────────────────────────────────────────────────────
const authRoutes         = require('./routes/auth.routes');
const userRoutes         = require('./routes/user.routes');
const rideRoutes         = require('./routes/ride.routes');
const deliveryRoutes     = require('./routes/delivery.routes');
const driverRoutes       = require('./routes/driver.routes');
const partnerRoutes      = require('./routes/partner.routes');
const paymentRoutes      = require('./routes/payment.routes');
const uploadRoutes       = require('./routes/upload.routes');
const adminRoutes        = require('./routes/admin.routes');
const notificationRoutes = require('./routes/notification.routes');
const walletRoutes       = require('./routes/wallet.routes');
const callRoutes         = require('./routes/call.routes');
const publicRoutes       = require('./routes/public.routes');
const placesRoutes       = require('./routes/places.routes'); // ← ADDED
const countriesRoutes    = require('./routes/country.routes');

// ─── Feature-flagged routes (only imported when enabled) ──────────────────────
const ENABLE_CORPORATE = process.env.ENABLE_CORPORATE !== 'false'; // core product — on unless explicitly disabled

// Fleet Partner Portal — staged activation (blueprint §2): API is on by default but can be switched off.
const ENABLE_FLEET = process.env.ENABLE_FLEET !== 'false';
// Bank Offers — nothing is ever shown to customers until a campaign is approved; credit offers need BANK_CREDIT_OFFERS_ENABLED=true.
const ENABLE_BANK_OFFERS = process.env.ENABLE_BANK_OFFERS !== 'false';

const corporateRoutes = ENABLE_CORPORATE ? require('./routes/corporate.routes') : null;

// ─── Middleware ───────────────────────────────────────────────────────────────
const { errorHandler } = require('./middleware/errorHandler');
const { isDevLike } = require('./utils/envGuard');
const { logger }       = require('./utils/logger');
const { maintenanceMiddleware } = require('./middleware/maintenance.middleware'); // ← ADD THIS

const app = express();

// The app runs behind Render's reverse proxy. Without this, req.ip is the PROXY's address
// for every client, so each rate limiter below treated the whole user base as one person
// (e.g. 100 requests per 15 minutes in total, shared by everyone — webhooks included) and
// express-rate-limit logged ERR_ERL_UNEXPECTED_X_FORWARDED_FOR. 1 = trust one proxy hop.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));

const crypto = require('crypto'); // add near your other requires at the top of the file instead if you prefer
app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
});

// Request log with recursive redaction of sensitive fields (credentials, OTPs, tokens,
// bank/card details, identity documents). Bodies are logged only outside production.
const SENSITIVE_KEY_PATTERN =
  /pass(word)?|pin|otp|code|token|secret|authorization|api[-_]?key|card|cvv|cvc|account[-_]?(number|no)|iban|bvn|nin|ssn|document|licen[cs]e|signature|credential/i;

function redactBody(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 5) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactBody(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY_PATTERN.test(k) ? '***' : redactBody(v, depth + 1);
  }
  return out;
}

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    if (!isDevLike()) {
      console.log(`[REQ] ${req.method} ${req.path}`);
    } else {
      console.log(`[REQ] ${req.method} ${req.path}`, JSON.stringify(redactBody(req.body)));
    }
  }
  next();
});

// ─── Security headers ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  return helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'script-src':      ["'self'", `'nonce-${res.locals.cspNonce}'`],
      'script-src-attr': ["'none'"],
    },
  },
})(req, res, next);
});

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  'http://localhost:3001',
  'http://localhost:5173',
  'http://localhost:3000',
  'https://runserv.onrender.com',
  process.env.CLIENT_URL,
  process.env.ADMIN_URL,
  process.env.ADMIN_URL_PREVIEW,
].filter(Boolean);

// Vercel preview deploy pattern — covers all auto-generated preview URLs.
// M12: anyone can create a Vercel project whose name starts with "ride-delivery-", so in production this wildcard let a
// stranger's site call the API from a browser. It is now honoured only in development/test, or when ALLOW_VERCEL_PREVIEW_ORIGINS=true
// is set deliberately (e.g. on a staging API). Production should list its real admin origin in ADMIN_URL instead.
const vercelPreviewPattern = /^https:\/\/ride-delivery-.*\.vercel\.app$/;
const allowVercelPreviews = () => process.env.ALLOW_VERCEL_PREVIEW_ORIGINS === 'true';

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (isDevLike()) return callback(null, true); // only an explicit NODE_ENV=development|test; a missing NODE_ENV is treated as production
    if (allowedOrigins.includes(origin)) return callback(null, true);
    if (allowVercelPreviews() && vercelPreviewPattern.test(origin)) return callback(null, true);
    // White-label portals: <slug>.business.runserv.org and organisations' own domains
    require('./utils/brandHosts').isPortalOrigin(origin)
      .then((ok) => (ok ? callback(null, true) : callback(new Error(`CORS: origin ${origin} not allowed`))))
      .catch(() => callback(new Error(`CORS: origin ${origin} not allowed`)));
    return undefined;
  },
  credentials: true,
}));

// ─── Global rate limit ────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message:  'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders:   false,
});
// Bank callbacks come from a bank's few server addresses and are protected by HMAC + their own limiter, so they are not
// counted in the shared per-IP budget (a busy bank must never be throttled into missing a payment notice).
app.use('/api/', (req, res, next) => ((req.path.startsWith('/bank-webhooks/') || req.path.startsWith('/email-webhooks/') || req.path.startsWith('/payments/momo/webhook/')) ? next() : globalLimiter(req, res, next)));

const statusLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max:      30,
  message:  'Too many status requests, please try again shortly.',
  standardHeaders: true,
  legacyHeaders:   false,
});
app.use('/api/status/', statusLimiter);
  
// ─── Stricter limit on auth endpoints ────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: 'Too many auth attempts, please try again later.',
});
app.use('/api/auth/login',           authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/register',        authLimiter);

// ─── Webhook raw body (MUST be before express.json) ──────────────────────────
app.use(
  '/api/payments/paystack/webhook',
  express.raw({ type: 'application/json' }),
  (req, _res, next) => { req.rawBody = req.body; next(); }
);
app.use(
  '/api/payments/flutterwave/webhook',
  express.raw({ type: 'application/json' }),
  (req, _res, next) => { req.rawBody = req.body; next(); }
);
if (ENABLE_BANK_OFFERS) {
  // Bank callbacks are HMAC-signed over the raw body, so it must not be re-parsed.
  app.use('/api/bank-webhooks', express.raw({ type: '*/*', limit: '256kb' }), (req, _res, next) => { req.rawBody = req.body; next(); });
}
// M16.1: email provider webhooks (Brevo token, Resend/Svix signature over the exact bytes).
app.use('/api/sms-webhooks', express.raw({ type: '*/*', limit: '256kb' }), (req, _res, next) => { req.rawBody = req.body; next(); });
app.use('/api/email-webhooks', express.raw({ type: '*/*', limit: '256kb' }), (req, _res, next) => { req.rawBody = req.body; next(); });
app.use(
  '/api/wallet/topup/verify',
  express.raw({ type: 'application/json' }),
  (req, _res, next) => { req.rawBody = req.body; next(); }
);
app.use(
  '/api/wallet/topup/flutterwave/webhook',
  express.raw({ type: 'application/json' }),
  (req, _res, next) => { req.rawBody = req.body; next(); }
);

// ─── Body parsing ─────────────────────────────────────────────────────────────
// Skip JSON/urlencoded parsing on routes that already consumed the raw body
// above — running express.json() a second time on an already-drained stream
// silently overwrites req.body and can break signature verification.
const RAW_BODY_ROUTES = [
  '/api/payments/paystack/webhook',
  '/api/payments/flutterwave/webhook',
  '/api/wallet/topup/verify',
  '/api/wallet/topup/flutterwave/webhook',
];

app.use((req, res, next) => {
  if (RAW_BODY_ROUTES.includes(req.path) || req.path.startsWith('/api/bank-webhooks/') || req.path.startsWith('/api/email-webhooks/')) return next();
  express.json({ limit: '10mb' })(req, res, next);
});
app.use((req, res, next) => {
  if (RAW_BODY_ROUTES.includes(req.path) || req.path.startsWith('/api/bank-webhooks/') || req.path.startsWith('/api/email-webhooks/')) return next();
  express.urlencoded({ extended: true, limit: '10mb' })(req, res, next);
});

// ─── Request logging ──────────────────────────────────────────────────────────
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined', {
    stream: { write: (msg) => logger.info(msg.trim()) },
  }));
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.status(200).json({
    status:      'ok',
    timestamp:   new Date().toISOString(),
    uptime:      process.uptime(),
    environment: process.env.NODE_ENV || 'development',
  });
});

// ─── Deep-link redirect for email CTAs (e.g. "Go online now") ───────────────
const APP_SCHEME    = process.env.APP_SCHEME    || 'runserv://';
const APP_STORE_URL  = process.env.APP_STORE_URL  || 'https://apps.apple.com/app/idXXXXXXXXX';
const PLAY_STORE_URL = process.env.PLAY_STORE_URL || 'https://play.google.com/store/apps/details?id=org.runserv.app';

app.get('/go-online', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Opening Runserv…</title>
</head>
<body style="font-family:Arial,sans-serif;text-align:center;padding:60px 24px;color:#111;">
  <h2>Opening the Runserv app…</h2>
  <p style="color:#666">If nothing happens, tap the button below.</p>
  <a href="${APP_SCHEME}home?action=online"
     style="display:inline-block;background:#111;color:#fff;text-decoration:none;
            padding:14px 30px;border-radius:11px;font-weight:800;margin-top:16px;">
    Open Runserv
  </a>
  <script nonce="${res.locals.cspNonce}">
    window.location.href = "${APP_SCHEME}home?action=online";
    setTimeout(function () {
      var ua = navigator.userAgent || '';
      if (/android/i.test(ua)) window.location.href = "${PLAY_STORE_URL}";
      else if (/iphone|ipad|ipod/i.test(ua)) window.location.href = "${APP_STORE_URL}";
    }, 1500);
  </script>
</body>
</html>`);
});

app.use('/api/status', publicRoutes);
app.use('/api/public', require('./routes/brand.routes'));
app.use('/api/public/demo-requests', require('./routes/demo.routes').publicRouter);
// ─── Maintenance gate
app.use(maintenanceMiddleware);

// ─── API Routes ───────────────────────────────────────────────────────────────
// M13: no response ever carries a raw document link (see middleware/scrubDocumentUrls.js)
app.use('/api', require('./middleware/scrubDocumentUrls').scrubDocumentUrls);
app.use('/api/documents',     require('./routes/document.routes'));
app.use('/t',                 require('./routes/guestTrackPage.routes')); // M15: page behind the SMS tracking link (set GUEST_TRACKING_BASE_URL=https://<api-host>/t)
app.use('/api/guest',         require('./routes/guest.routes')); // public PREVIEW quotes (GUEST_PLANNING_ENABLED) + verified guest booking (GUEST_BOOKING_ENABLED); authenticated routes unchanged
app.use('/api/maps',          require('./routes/maps.routes')); // M14: provider-neutral routing
app.use('/api/auth',          authRoutes);
app.use('/api/users',         userRoutes);
app.use('/api/rides',         rideRoutes);
app.use('/api/deliveries',    deliveryRoutes);
app.use('/api/drivers',       driverRoutes);
app.use('/api/partners',      partnerRoutes);
app.use('/api/payments',      paymentRoutes);
app.use('/api/upload',        uploadRoutes);
app.use('/api/admin/audit-logs', require('./routes/adminAudit.routes')); // WP-09 audit viewer
app.use('/api/admin/finance', require('./routes/adminFinance.routes')); // WP-01 reconciliation + ledger viewer
app.use('/api/admin/alerts',  require('./routes/adminAlerts.routes')); // WP-08 (before the generic admin router)
app.use('/api/admin',         adminRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/wallet',        walletRoutes);
app.use('/api/calls',         callRoutes);
app.use('/api/places',        placesRoutes); 
app.use('/api/countries',     countriesRoutes);

app.use('/api/sms-webhooks', require('./routes/smsWebhook.routes'));       // WP-07: SMS delivery receipts -> smsOutbox.applyReceipt (authenticated inside)
app.use('/api/email-webhooks', require('./routes/emailWebhook.routes'));   // M16.1: Brevo / Resend delivery events (authenticated inside)
if (ENABLE_CORPORATE) app.use('/api/corporate', corporateRoutes);
if (ENABLE_FLEET)     app.use('/api/fleet', require('./routes/fleet.routes'));
if (ENABLE_BANK_OFFERS) {
  const bank = require('./routes/bankOffers.routes');
  app.use('/api/offers', bank.offers);
  app.use('/api/bank-webhooks', bank.webhooks);
}

// ─── API index ────────────────────────────────────────────────────────────────
app.get('/api', (_req, res) => {
  res.status(200).json({
    message: 'Runserv API v1.0',
    endpoints: {
      auth:          '/api/auth',
      users:         '/api/users',
      rides:         '/api/rides',
      deliveries:    '/api/deliveries',
      drivers:       '/api/drivers',
      partners:      '/api/partners',
      payments:      '/api/payments',
      wallet:        '/api/wallet',
      notifications: '/api/notifications',
      upload:        '/api/upload',
      admin:         '/api/admin',
      calls:         '/api/calls',
      ...(ENABLE_CORPORATE && { corporate: '/api/corporate' }),
      ...(ENABLE_FLEET && { fleet: '/api/fleet' }),
      ...(ENABLE_BANK_OFFERS && { offers: '/api/offers' }),
    },
  });
});

// ─── Orange Money hosted-checkout landing pages (no auth, no side effects) ───
app.use('/payment/orange', require('./routes/paymentReturn.routes'));

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.path} not found`,
  });
});

// ─── Global error handler ─────────────────────────────────────────────────────
app.use(errorHandler);

module.exports = app;