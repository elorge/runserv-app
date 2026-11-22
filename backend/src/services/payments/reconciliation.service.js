// backend/src/services/payments/reconciliation.service.js
// Compares Runserv payments with rows from a provider statement ({reference, amount, currency, status}). Never edits money:
// differences become visible exceptions + a run record.
'use strict';
const prisma = require('../../lib/prisma');
const { toMinor } = require('../../utils/money');
const { logActivity } = require('../../utils/auditLog');
const { raiseException } = require('./collection.service');

const OK = ['SUCCESSFUL', 'SUCCESS', 'COMPLETED', 'SUCCEEDED'];

const run = async ({ provider, periodFrom, periodTo, source, rows, actor, req }) => {
  const from = new Date(periodFrom); const to = new Date(periodTo);
  const ours = await prisma.payment.findMany({ where: { provider, createdAt: { gte: from, lte: to } } });
  const byRef = new Map(); for (const p of ours) { byRef.set(p.transactionId, p); if (p.providerRef) byRef.set(p.providerRef, p); }
  const seen = new Set(); const counts = { matched: 0, mismatched: 0, missingHere: 0, missingThere: 0 };
  for (const r of rows) {
    const ref = String(r.reference || ''); const p = byRef.get(ref);
    if (seen.has(ref)) { counts.mismatched += 1; await raiseException({ paymentId: p?.id, kind: 'RECONCILIATION_MISMATCH', detail: { reason: 'DUPLICATE_IN_STATEMENT', reference: ref }, dedupeKey: `rec:${provider}:dup:${ref}` }); continue; }
    seen.add(ref);
    if (!p) { counts.missingHere += 1; await raiseException({ kind: 'MISSING_INTERNALLY', detail: { reference: ref, amount: r.amount }, dedupeKey: `rec:${provider}:mi:${ref}` }); continue; }
    const theirOk = OK.includes(String(r.status || '').toUpperCase());
    const bad = toMinor(r.amount) !== toMinor(p.amount) || String(r.currency || p.currency) !== p.currency || theirOk !== (p.status === 'COMPLETED');
    if (bad) { counts.mismatched += 1; await raiseException({ paymentId: p.id, kind: 'RECONCILIATION_MISMATCH', detail: { ours: { amount: String(p.amount), status: p.status }, theirs: { amount: r.amount, status: r.status } }, dedupeKey: `rec:${provider}:${p.id}` }); }
    else counts.matched += 1;
  }
  for (const p of ours) if (p.status === 'COMPLETED' && !seen.has(p.transactionId) && !seen.has(p.providerRef)) { counts.missingThere += 1; await raiseException({ paymentId: p.id, kind: 'MISSING_AT_PROVIDER', detail: { reference: p.transactionId }, dedupeKey: `rec:${provider}:mt:${p.id}` }); }
  const runRow = await prisma.reconciliationRun.create({ data: { provider, periodFrom: from, periodTo: to, source, ...counts, createdById: actor, summary: { rows: rows.length } } });
  await logActivity({ userId: actor, action: 'reconciliation_run', entityType: 'ReconciliationRun', entityId: runRow.id, details: counts, req });
  return { id: runRow.id, ...counts };
};

module.exports = { run };
