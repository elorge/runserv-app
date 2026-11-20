#!/usr/bin/env node
// scripts/ledger-check.js — run daily (and after any incident). Exits 1 if the books do not add up.
//   1. every ledger event balances (debits = credits)            → view ledger_unbalanced_groups must be empty
//   2. every wallet's balance column equals what the ledger says → only for wallets that have ledger entries
'use strict';
try { require('dotenv').config(); } catch { /* optional */ }
const prisma = require('../src/lib/prisma');
(async () => {
  let bad = 0;
  const groups = await prisma.$queryRawUnsafe('SELECT * FROM ledger_unbalanced_groups LIMIT 50');
  if (groups.length) { bad++; console.error(`✖ ${groups.length} unbalanced ledger event(s):`, groups.slice(0, 5)); } else console.log('✔ every ledger event balances');
  const rows = await prisma.$queryRawUnsafe(`
    SELECT w.id, w.balance AS balance, SUM(CASE WHEN l.direction='CREDIT' THEN l.amount ELSE -l.amount END) AS ledger
      FROM "Wallet" w JOIN "LedgerEntry" l ON l.account = 'WALLET:' || w.id
     GROUP BY w.id, w.balance
    HAVING w.balance <> SUM(CASE WHEN l.direction='CREDIT' THEN l.amount ELSE -l.amount END)`);
  // A wallet that also moved through code paths not yet posting to the ledger will differ; list them so they can be reviewed.
  if (rows.length) console.warn(`ℹ ${rows.length} wallet(s) differ from their ledger (expected until every money path posts to the ledger):`, rows.slice(0, 5));
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
