#!/usr/bin/env node
// scripts/ledger-check.js — run daily (and after any incident, and as a go-live gate). Exits 1 on ANY exception:
//   · an unbalanced ledger event                      · a wallet/company balance that differs from its ledger, by currency
//   · a non-zero balance with no ledger rows at all   · ledger entries in the wrong currency or on an account that does not exist
// It uses the same query set as the daily reconciliation job (ledgerReconciliation.service.findExceptions), so the two cannot disagree.
'use strict';
try { require('dotenv').config(); } catch { /* optional */ }
const prisma = require('../src/lib/prisma');
const { findExceptions } = require('../src/services/ledgerReconciliation.service');
(async () => {
  const { wallets, companies, exceptions } = await findExceptions();
  console.log(`Checked ${wallets.length} wallet(s) and ${companies.length} company wallet(s).`);
  if (!exceptions.length) { console.log('✔ ledger balanced; every balance equals its ledger; no stray entries'); await prisma.$disconnect(); process.exit(0); }
  const byType = exceptions.reduce((m, e) => ({ ...m, [e.type]: (m[e.type] || 0) + 1 }), {});
  console.error(`✖ ${exceptions.length} exception(s):`, byType);
  console.error(exceptions.slice(0, 20));
  await prisma.$disconnect();
  process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
