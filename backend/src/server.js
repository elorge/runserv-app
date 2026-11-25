// backend/src/server.js
require('dotenv').config();
const http = require('http');
require('./utils/envGuard').assertProductionEnv();
const app  = require('./app');
const { Server } = require('socket.io');
const { logger } = require('./utils/logger');
require('./utils/envGuard').productionWarnings().forEach((w) => logger.warn(`[config] ${w}`));
const { initializeSocketHandlers } = require('./services/socket.service');

// ─── Feature flags ────────────────────────────────────────────────────────────
const ENABLE_CORPORATE = process.env.ENABLE_CORPORATE !== 'false'; // core product — on unless explicitly disabled

// Organisation billing: monthly invoices + overdue marking. Both are idempotent, so running them
// more than once (restarts, several instances) is safe.
const orgBilling =
  ENABLE_CORPORATE && process.env.DISABLE_ORG_BILLING_SCHEDULER !== 'true'
    ? require('./services/orgBilling.service')
    : null;

const PORT   = parseInt(process.env.PORT) || 3000;
const HOST   = '0.0.0.0';
const IS_DEV = require('./utils/envGuard').isDevLike();

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (IS_DEV) return callback(null, true);
      if (!origin) return callback(null, true);

      const allowed = [
        process.env.CLIENT_URL,
        process.env.ADMIN_URL,
        process.env.ADMIN_URL_PREVIEW,
      ].filter(Boolean);

      if (allowed.includes(origin)) return callback(null, true);
      callback(new Error(`Socket CORS blocked: ${origin}`));
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['polling', 'websocket'],
});

// Make io accessible in controllers
app.set('io', io);

// Initialize socket handlers
initializeSocketHandlers(io);

// ─── Lightweight cron jobs ────────────────────────────────────────────────────
const HOUR_MS = 60 * 60 * 1000;

setInterval(async () => {
  const now     = new Date();
  const watHour = (now.getUTCHours() + 1) % 24;
  const watDay  = now.getUTCDate();

  // Organisation billing cron — daily at 01:00 WAT
  if (orgBilling && watHour === 1) runOrgBilling('daily');
  // Bank credits stuck in the exception queue or waiting for a second approver: tell the finance admins (each credit once).
  require('./services/bankReceipts.service').alertStaleExceptions().then((r) => r.alerted && logger.info(`[Cron] Bank exception alerts: ${r.alerted}`)).catch((e) => logger.error('[Cron] Bank alerts error:', e.message));
  if (orgBilling && watHour === 8) require('./services/orgWallet.service').runBalanceAlerts().then((r) => logger.info(`[Cron] Org alerts: ${r.sent} sent`)).catch((e) => logger.error('[Cron] Org alerts error:', e.message));
}, HOUR_MS);

function runOrgBilling(trigger) {
  logger.info(`[Cron] Organisation billing (${trigger})...`);
  orgBilling.generateMonthlyInvoices()
    .then(r => logger.info(`[Cron] Org invoices: ${r.issued} issued, ${r.skipped} skipped, ${r.failed} failed`))
    .then(() => orgBilling.markOverdueInvoices())
    .then(n => n && logger.info(`[Cron] Org invoices: ${n} marked overdue`))
    .catch(err => logger.error('[Cron] Org billing error:', err.message));
}
// Catch up shortly after boot in case the 01:00 slot was missed (e.g. the host was asleep).
if (orgBilling) setTimeout(() => runOrgBilling('startup'), 2 * 60 * 1000);

// Payment sweeper: re-checks pending provider (MTN MoMo) payments every few minutes. Disable with PAYMENT_SWEEPER_ENABLED=false.
if (require('./services/ledgerReconciliation.service').start(logger)) logger.info('[Cron] Daily ledger reconciliation scheduled'); // WP-01
if (require('./services/fleetTripMonitor.service').start(logger)) logger.info('[Cron] Fleet trip safety-net scan scheduled');
if (require('./services/payments/sweeper.job').start(logger)) logger.info('[Cron] Payment sweeper scheduled');

// ─── Graceful shutdown ────────────────────────────────────────────────────────
const shutdown = (signal) => {
  logger.info(`${signal} received — closing HTTP server`);
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled Promise Rejection:', err);
  server.close(() => process.exit(1));
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
  server.close(() => process.exit(1));
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, HOST, () => {
  require('./services/smsOutbox.service').startWorker(); // M16: guest SMS (tracking link, recipient code) with retry / dead-letter
  require('./services/emailOutbox.service').startWorker(); // M16.1: guest email OTP (Brevo -> Resend quota routing) with retry / dead-letter
  require('./services/opsAlert.service').startWorker(); // WP-08: durable ops-alert retry + escalation
  require('./services/outbox.service').startWorker(); // M13: trip-completed events -> fleet records, with retry / dead-letter
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();

  let lanIP = 'localhost';

  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        lanIP = iface.address;
        break;
      }
    }
    if (lanIP !== 'localhost') break;
  }

  logger.info(` Server running on port ${PORT}`);
  logger.info(` Environment : ${process.env.NODE_ENV || 'development'}`);
  logger.info(` Local       : http://localhost:${PORT}/api`);
  logger.info(` On network  : http://${lanIP}:${PORT}/api`);
  logger.info(` Health      : http://${lanIP}:${PORT}/health`);
  logger.info(` WebSockets  : Socket.io ready`);
  logger.info(` Payments    : Paystack + Flutterwave (NGN)`);

  if (ENABLE_CORPORATE) logger.info(` Corporate   : /api/corporate`);
});

module.exports = { server, io };