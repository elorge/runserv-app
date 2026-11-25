// backend/src/services/ledgerReconciliation.service.js
// WP-01: daily reconciliation of balances against the append-only ledger.
//   1. every ledger event balances (view ledger_unbalanced_groups must be empty)
//   2. every customer/driver/partner Wallet.balance == credits - debits on account WALLET:<id>
//        (a wallet with a balance but NO ledger rows is reported as UNLEDGERED_BALANCE: pre-ledger money that needs an opening-balance entry,
//         see scripts/ledger-opening-balances.js)
//   3. every Company.walletBalance == credits - debits on account COMPANY_WALLET:<id>
//   4. liabilities (informational): wallet balances, pending payouts per currency
// Every run is stored in LedgerReconciliationRun; variances are listed as exceptions (never hidden), and ops are alerted.
'use strict';
const prisma = require('../lib/prisma');
const { toMinor, fromMinor } = require('../utils/money');
const { logger } = require('../utils/logger');

const MAX_EXCEPTIONS = 200;
const TOLERANCE_MINOR = 0;      // money is integer minor units: any difference is a real difference

/** Pure comparison, unit-testable: rows = [{ id, currency, balance, ledger (null if no ledger rows) }] */
const compareBalances = (rows, kind) => {
  const out = [];
  for (const r of rows) {
    const bal = toMinor(r.balance);
    if (r.ledger === null || r.ledger === undefined) {
      if (bal !== 0) out.push({ type: 'UNLEDGERED_BALANCE', kind, id: r.id, currency: r.currency, balance: fromMinor(bal), ledger: null, variance: fromMinor(bal) });
      continue;
    }
    const led = toMinor(r.ledger);
    if (Math.abs(bal - led) > TOLERANCE_MINOR) out.push({ type: 'VARIANCE', kind, id: r.id, currency: r.currency, balance: fromMinor(bal), ledger: fromMinor(led), variance: fromMinor(bal - led) });
  }
  return out;
};

// The ledger side is summed ONLY in the wallet's own currency; entries in any other currency are reported separately (never netted in).
const walletRows = () => prisma.$queryRawUnsafe(`
  SELECT w.id, w.currency, w.balance::text AS balance,
         (SELECT SUM(CASE WHEN l.direction='CREDIT' THEN l.amount ELSE -l.amount END)::text FROM "LedgerEntry" l WHERE l.account = 'WALLET:' || w.id AND l.currency = w.currency) AS ledger
    FROM "Wallet" w`);
const companyRows = () => prisma.$queryRawUnsafe(`
  SELECT c.id, c.currency, c."walletBalance"::text AS balance,
         (SELECT SUM(CASE WHEN l.direction='CREDIT' THEN l.amount ELSE -l.amount END)::text FROM "LedgerEntry" l WHERE l.account = 'COMPANY_WALLET:' || c.id AND l.currency = c.currency) AS ledger
    FROM "Company" c`);
/** Ledger entries on a wallet/company account that are in a different currency than the account's own, or on an account that does not exist. */
const strayEntryRows = () => prisma.$queryRawUnsafe(`
  SELECT 'CURRENCY_MISMATCH_ENTRY' AS type, 'WALLET' AS kind, w.id, w.currency AS "accountCurrency", l.currency AS "entryCurrency", COUNT(*)::int AS entries
    FROM "LedgerEntry" l JOIN "Wallet" w ON l.account = 'WALLET:' || w.id WHERE l.currency <> w.currency GROUP BY w.id, w.currency, l.currency
  UNION ALL
  SELECT 'CURRENCY_MISMATCH_ENTRY', 'COMPANY_WALLET', c.id, c.currency, l.currency, COUNT(*)::int
    FROM "LedgerEntry" l JOIN "Company" c ON l.account = 'COMPANY_WALLET:' || c.id WHERE l.currency <> c.currency GROUP BY c.id, c.currency, l.currency
  UNION ALL
  SELECT 'ORPHAN_ACCOUNT_ENTRY', 'WALLET', substr(l.account, 8), NULL, l.currency, COUNT(*)::int
    FROM "LedgerEntry" l WHERE l.account LIKE 'WALLET:%' AND NOT EXISTS (SELECT 1 FROM "Wallet" w WHERE l.account = 'WALLET:' || w.id) GROUP BY l.account, l.currency
  UNION ALL
  SELECT 'ORPHAN_ACCOUNT_ENTRY', 'COMPANY_WALLET', substr(l.account, 16), NULL, l.currency, COUNT(*)::int
    FROM "LedgerEntry" l WHERE l.account LIKE 'COMPANY_WALLET:%' AND NOT EXISTS (SELECT 1 FROM "Company" c WHERE l.account = 'COMPANY_WALLET:' || c.id) GROUP BY l.account, l.currency
  LIMIT 100`);

/** Gathers every exception WITHOUT storing a run (shared by the daily job and scripts/ledger-check.js so the two can never disagree). */
const findExceptions = async () => {
  const unbalanced = await prisma.$queryRawUnsafe('SELECT "entryGroup", currency FROM ledger_unbalanced_groups LIMIT 50');
  const wallets = await walletRows();
  const companies = await companyRows();
  const stray = await strayEntryRows();
  const exceptions = [
    ...unbalanced.map((g) => ({ type: 'UNBALANCED_EVENT', kind: 'LEDGER', id: g.entryGroup, currency: g.currency })),
    ...compareBalances(wallets, 'WALLET'),
    ...compareBalances(companies, 'COMPANY_WALLET'),
    ...stray.map((x) => ({ type: x.type, kind: x.kind, id: x.id, currency: x.entryCurrency, accountCurrency: x.accountCurrency, entries: x.entries })),
  ];
  return { unbalanced, wallets, companies, exceptions };
};

const run = async ({ trigger = 'SCHEDULED', actorId = null } = {}) => {
  const rec = await prisma.ledgerReconciliationRun.create({ data: { trigger, status: 'RUNNING', startedById: actorId } });
  try {
    const { unbalanced, wallets, companies, exceptions } = await findExceptions();
    const liab = {};
    for (const w of wallets) { const c = w.currency || 'NGN'; liab[c] = liab[c] || { walletBalances: 0, pendingPayouts: 0 }; liab[c].walletBalances += toMinor(w.balance); }
    const pend = await prisma.payout.groupBy({ by: ['currency'], where: { status: { in: ['PENDING', 'PROCESSING'] } }, _sum: { amount: true } }).catch(() => []);
    for (const p of pend) { const c = p.currency || 'NGN'; liab[c] = liab[c] || { walletBalances: 0, pendingPayouts: 0 }; liab[c].pendingPayouts += toMinor(p._sum.amount || 0); }
    for (const c of Object.keys(liab)) { liab[c].walletBalances = fromMinor(liab[c].walletBalances); liab[c].pendingPayouts = fromMinor(liab[c].pendingPayouts); }
    const summary = { walletsChecked: wallets.length, companiesChecked: companies.length, unbalancedEvents: unbalanced.length, exceptionCount: exceptions.length, liabilitiesByCurrency: liab };
    const status = exceptions.length ? 'EXCEPTIONS' : 'OK';
    const done = await prisma.ledgerReconciliationRun.update({ where: { id: rec.id }, data: { status, finishedAt: new Date(), summary, exceptions: exceptions.slice(0, MAX_EXCEPTIONS) } });
    if (exceptions.length) {
      logger.error(`[Reconciliation] ${exceptions.length} exception(s) in run ${rec.id}`);
      try { await require('./opsAlert.service').raiseAndDeliver({ kind: 'LEDGER_RECONCILIATION', severity: 'CRITICAL', dedupeKey: 'ledger-reconciliation', title: 'Ledger reconciliation found exceptions', message: `${exceptions.length} wallet/ledger exception(s). Open Finance > Reconciliation run ${rec.id}.`, data: { runId: rec.id } }); } catch (e) { logger.error('[Reconciliation] alert failed: ' + e.message); }
    }
    return done;
  } catch (e) {
    await prisma.ledgerReconciliationRun.update({ where: { id: rec.id }, data: { status: 'FAILED', finishedAt: new Date(), error: String(e.message).slice(0, 500) } }).catch(() => {});
    throw e;
  }
};

/** Daily scheduler: runs once per day at LEDGER_RECON_HOUR_WAT (default 02). Disable with LEDGER_RECON_ENABLED=false. */
const start = (log = logger, env = process.env) => {
  if (String(env.LEDGER_RECON_ENABLED || 'true').toLowerCase() === 'false') return false;
  const hour = Number.isFinite(Number(env.LEDGER_RECON_HOUR_WAT)) ? Number(env.LEDGER_RECON_HOUR_WAT) : 2;
  let lastDay = null;
  const tick = () => {
    const now = new Date(); const wat = new Date(now.getTime() + 3600 * 1000);
    const day = wat.toISOString().slice(0, 10);
    if (wat.getUTCHours() === hour && lastDay !== day) { lastDay = day; run({ trigger: 'SCHEDULED' }).then((r) => log.info(`[Cron] Reconciliation ${r.status}`)).catch((e) => log.error('[Cron] Reconciliation failed: ' + e.message)); }
  };
  const t = setInterval(tick, 10 * 60 * 1000); if (t.unref) t.unref();
  return true;
};

module.exports = { compareBalances, findExceptions, run, start };
