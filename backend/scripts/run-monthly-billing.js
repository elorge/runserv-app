// backend/scripts/run-monthly-billing.js
// Issue last month's invoice for every company and mark overdue ones. Safe to run repeatedly.
//   node scripts/run-monthly-billing.js
// Use from cron if you set DISABLE_ORG_BILLING_SCHEDULER=true.
require('dotenv').config();
const billing = require('../src/services/orgBilling.service');
const prisma = require('../src/lib/prisma');

(async () => {
  const r = await billing.generateMonthlyInvoices();
  const overdue = await billing.markOverdueInvoices();
  console.log(`Invoices: ${r.issued} issued, ${r.skipped} skipped, ${r.failed} failed; ${overdue} marked overdue`);
  await prisma.$disconnect();
  process.exit(r.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
