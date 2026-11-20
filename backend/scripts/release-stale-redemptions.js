// Releases bank-offer benefits that were reserved but never used (app closed, payment abandoned), giving the budget back.
// Run every 15 minutes from the scheduler of your host (cron, Render cron job, etc.):  node scripts/release-stale-redemptions.js [minutes]
'use strict';
require('dotenv').config();
const { releaseStaleReservations } = require('../src/services/bankOffers.service');
const prisma = require('../src/lib/prisma');

(async () => {
  const minutes = Number(process.argv[2]) || 60;
  const out = await releaseStaleReservations({ olderThanMinutes: minutes });
  console.log(`Checked ${out.checked} reservation(s) older than ${minutes} min; released ${out.released}.`);
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect?.());
