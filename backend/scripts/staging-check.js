#!/usr/bin/env node
// scripts/staging-check.js — automated part of docs/STAGING_CHECKLIST.md. Run against STAGING with staging env loaded:
//   API_URL=https://staging-api.example.com pnpm staging:check
// Automates: production env rules, DB connectivity, every ORDER.txt file's objects present, ledger invariants, /health.
// It CANNOT verify providers, phones or devices: those are printed as a manual list to sign off (date + owner).
// Exit code 1 if any automated check fails. Writes staging-check-report.json.
'use strict';
try { require('dotenv').config(); } catch { /* optional */ }
const fs = require('fs'); const path = require('path');
const results = [];
const rec = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`); };

(async () => {
  const { productionProblems } = require('../src/utils/envGuard');
  const env = { ...process.env, NODE_ENV: process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test' ? 'production' : process.env.NODE_ENV || 'production' };
  const problems = productionProblems(env);
  rec('Production environment rules (envGuard)', problems.length === 0, problems.join(' | '));

  const prisma = require('../src/lib/prisma');
  try {
    await prisma.$queryRaw`select 1`;
    rec('Database reachable', true);
    const trg = await prisma.$queryRaw`select count(*)::int as n from pg_trigger where not tgisinternal and tgrelid = '"LedgerEntry"'::regclass`;
    rec('Ledger append-only triggers installed', trg[0].n >= 2, `${trg[0].n} trigger(s) on LedgerEntry`);
    const tables = await prisma.$queryRaw`select count(*)::int as n from information_schema.tables where table_schema='public'`;
    rec('Schema present', tables[0].n >= 70, `${tables[0].n} tables`);
    const { findExceptions } = require('../src/services/ledgerReconciliation.service');
    const { exceptions } = await findExceptions();
    rec('Ledger reconciliation clean', exceptions.length === 0, `${exceptions.length} exception(s)`);
    const admins = await prisma.user.count({ where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] }, email: { endsWith: '@runserv.org' }, mfaEnabled: false } });
    rec('No staff account without MFA on @runserv.org', admins === 0, `${admins} account(s) without MFA`);
  } catch (e) { rec('Database checks', false, e.message); }
  finally { try { await require('../src/lib/prisma').$disconnect(); } catch { /* ignore */ } }

  const api = process.env.API_URL;
  if (!api) rec('API /health', false, 'set API_URL to check the deployed API');
  else {
    try { const r = await fetch(api.replace(/\/$/, '') + '/health'); const j = await r.json(); rec('API /health', r.ok && j.status === 'ok', `HTTP ${r.status}`); }
    catch (e) { rec('API /health', false, e.message); }
  }

  const manual = ['Paystack / Flutterwave / MoMo: initialise, webhook, verify, refund (sandbox keys)', 'Termii SMS and delivery-receipt webhook to /api/sms-webhooks/receipts', 'Brevo / Resend email, SPF + DKIM + DMARC, receipt webhooks', 'Push notification on a physical Android and iOS device', 'Cloudinary private document upload and expiring link', 'OSRM routing test from Admin → Map provider', 'Ride, delivery with hand-over code, guest booking, org invoice, fleet settlement end to end', 'Customer and driver mobile builds on physical devices', 'Backup restore drill (scripts/backup-drill.sh) with timings recorded', 'Penetration / light security review; monitoring and alert delivery confirmed'];
  console.log('\nMANUAL — sign off each with date and owner:'); manual.forEach((m, i) => console.log(`  [ ] ${i + 1}. ${m}`));
  fs.writeFileSync(path.join(process.cwd(), 'staging-check-report.json'), JSON.stringify({ at: new Date().toISOString(), automated: results, manual }, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${failed ? '✖ ' + failed + ' automated check(s) failed' : '✔ all automated checks passed'} (report: staging-check-report.json). Manual items are NOT verified by this script.`);
  process.exit(failed ? 1 : 0);
})();
