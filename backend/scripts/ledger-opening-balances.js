#!/usr/bin/env node
// scripts/ledger-opening-balances.js — WP-01 one-off for balances that existed BEFORE mandatory ledger posting (wallets AND company wallets).
// A brand-new database has none: the dry run says "0" and nothing needs posting.
//   node scripts/ledger-opening-balances.js [--out=opening.csv]                      dry run (lists everything; optional CSV for Finance sign-off)
//   node scripts/ledger-opening-balances.js --apply --approved-by="Name" --approval-ref="FIN-123"   posts once, idempotently
'use strict';
try { require('dotenv').config(); } catch { /* optional */ }
const fs = require('fs');
const prisma = require('../src/lib/prisma');
const svc = require('../src/services/openingBalances.service');
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || null;
(async () => {
  const rows = await svc.findCandidates();
  console.log(`${rows.length} account(s) hold a balance with no ledger history.`, rows.length ? svc.totalsByCurrency(rows) : '');
  rows.forEach((r) => console.log(`  ${r.kind}  ${r.id}  ${r.currency}  ${r.balance}`));
  if (arg('out')) { fs.writeFileSync(arg('out'), ['kind,id,currency,balance', ...rows.map((r) => `${r.kind},${r.id},${r.currency},${r.balance}`)].join('\n') + '\n'); console.log(`Wrote ${arg('out')} for Finance review.`); }
  if (!process.argv.includes('--apply')) { console.log('Dry run only. Finance must approve the list, then re-run with --apply --approved-by=… --approval-ref=…'); await prisma.$disconnect(); return; }
  const r = await svc.post(rows, { approvedBy: arg('approved-by'), approvalRef: arg('approval-ref') });
  console.log(`Posted ${r.posted} opening balance(s).`, r.totals);
  await prisma.$disconnect();
})().catch((e) => { console.error(e.message || e); process.exit(1); });
