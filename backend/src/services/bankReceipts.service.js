// backend/src/services/bankReceipts.service.js
// Runserv holds one account AT EACH partner bank. A bank pays what it owes (a settlement) into Runserv's account at that same
// bank, through its own platform, quoting the settlement's payment reference. The bank then tells Runserv (signed callback),
// and Runserv matches the credit to the settlement automatically. Rules that make this leak-proof:
//   • a credit is unique per (bank, bank transaction id): the same notice twice is counted once;
//   • a credit can only settle a settlement of THE SAME bank (bank A can never pay off bank B's invoice);
//   • it must have landed in one of Runserv's own accounts at that bank, in the settlement's currency;
//   • anything uncertain (wrong/missing reference, closed settlement, unknown account) goes to an exception queue — never guessed;
//   • all arithmetic is in integer minor units; every state change is audit-logged;
//   • a credit that a PERSON typed in, imported from a statement file, or matched by hand does nothing until a DIFFERENT admin
//     approves it (two-person rule); only a bank's own signed notice is applied straight away;
//   • every status change is a compare-and-set, so two staff acting on the same credit cannot both apply it.
'use strict';

const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { logActivity } = require('../utils/auditLog');
const { toMinor, fromMinor } = require('../utils/money');

const OPEN = ['PENDING', 'RECONCILING', 'APPROVED'];
// RSV = a bank's settlement to Runserv · RSC = a company topping up its wallet · RSI = a company paying an invoice
const REF_RE = /RS[VCI]-[0-9A-F]{8}/;

// ── Secret storage (AES-256-GCM) ────────────────────────────────────────────────────────────────
const keyFrom = (env = process.env) => {
  const k = String(env.BANK_SECRETS_KEY || '');
  if (k.length < 32) throw new AppError('BANK_SECRETS_KEY (32+ characters) is not configured on the server.', 500);
  return crypto.createHash('sha256').update(k).digest();
};
const encryptSecret = (plain, env = process.env) => {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', keyFrom(env), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
};
const decryptSecret = (blob, env = process.env) => {
  const [v, iv, tag, ct] = String(blob || '').split(':'); if (v !== 'v1') return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(env), Buffer.from(iv, 'base64')); d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
};

/** The signing secret for a bank: the one generated in the console (encrypted in the DB), else the environment map. */
const resolveBankSecret = async (bankPartnerId, env = process.env) => {
  const bank = await prisma.bankPartner.findUnique({ where: { id: bankPartnerId }, select: { webhookSecretEnc: true } });
  if (bank?.webhookSecretEnc) return decryptSecret(bank.webhookSecretEnc, env);
  try { return JSON.parse(env.BANK_WEBHOOK_SECRETS || '{}')[bankPartnerId] || null; } catch { return null; }
};

/** Generates a new secret. The plain value is returned ONCE and never stored in readable form. */
const rotateSecret = async ({ bankPartnerId, actor, req, env = process.env }) => {
  const bank = await prisma.bankPartner.findUnique({ where: { id: bankPartnerId }, select: { id: true, webhookSecretVersion: true } });
  if (!bank) throw new AppError('Bank partner not found.', 404);
  const secret = crypto.randomBytes(32).toString('hex');
  const enc = encryptSecret(secret, env);
  const version = (bank.webhookSecretVersion || 0) + 1;
  await prisma.bankPartner.update({ where: { id: bankPartnerId }, data: { webhookSecretEnc: enc, webhookSecretVersion: version, webhookSecretRotatedAt: new Date() } });
  await logActivity({ userId: actor, action: 'bank_webhook_secret_rotated', entityType: 'BankPartner', entityId: bankPartnerId, details: { version }, req });
  return { secret, version, note: 'Copy this now and send it to the bank through a secure channel. It cannot be shown again.' };
};

// ── Runserv's receiving accounts ────────────────────────────────────────────────────────────────
const mask = (n) => (n ? `••••${String(n).slice(-4)}` : null);

const createAccount = async ({ bankPartnerId, accountName, accountNumber, bankName, currency = 'NGN', label = null, isPrimary = false, actor, req }) => {
  const bank = await prisma.bankPartner.findUnique({ where: { id: bankPartnerId }, select: { id: true, displayName: true } });
  if (!bank) throw new AppError('Bank partner not found.', 404);
  const num = String(accountNumber || '').replace(/\s+/g, '');
  const cur = String(currency).toUpperCase();
  if (!/^[A-Za-z0-9-]{6,34}$/.test(num)) throw new AppError('Enter a valid account number.', 400);
  if (cur === 'NGN' && !/^\d{10}$/.test(num)) throw new AppError('A naira account number has 10 digits.', 400);
  if (!/^[A-Z]{3}$/.test(cur)) throw new AppError('Currency must be a 3-letter code.', 400);
  if (String(accountName || '').trim().length < 3) throw new AppError('Enter the account name exactly as the bank holds it.', 400);
  const dup = await prisma.bankReceivingAccount.findFirst({ where: { bankPartnerId, accountNumber: num }, select: { id: true } });
  if (dup) throw new AppError('This account is already registered for this bank.', 409);
  const first = !(await prisma.bankReceivingAccount.findFirst({ where: { bankPartnerId, currency: cur, isActive: true }, select: { id: true } }));
  const primary = isPrimary || first;
  const row = await prisma.$transaction(async (tx) => {
    if (primary) await tx.bankReceivingAccount.updateMany({ where: { bankPartnerId, currency: cur, isPrimary: true }, data: { isPrimary: false } });
    return tx.bankReceivingAccount.create({ data: { bankPartnerId, accountName: String(accountName).trim(), accountNumber: num, bankName: String(bankName || bank.displayName).trim(), currency: cur, label, isPrimary: primary, createdById: actor } });
  });
  await logActivity({ userId: actor, action: 'bank_receiving_account_added', entityType: 'BankReceivingAccount', entityId: row.id, details: { bankPartnerId, account: mask(num), currency: cur, isPrimary: primary }, req });
  return row;
};

const updateAccount = async ({ id, isActive, isPrimary, label, actor, req }) => {
  const a = await prisma.bankReceivingAccount.findUnique({ where: { id } });
  if (!a) throw new AppError('Account not found.', 404);
  if (isActive === false && a.isPrimary) {
    const other = await prisma.bankReceivingAccount.findFirst({ where: { bankPartnerId: a.bankPartnerId, currency: a.currency, isActive: true, id: { not: id } }, select: { id: true } });
    if (!other && (await prisma.bankSettlement.findFirst({ where: { bankPartnerId: a.bankPartnerId, status: { in: OPEN } }, select: { id: true } })))
      throw new AppError('This is the only active account and open settlements still depend on it. Add another account first.', 409);
  }
  const row = await prisma.$transaction(async (tx) => {
    if (isPrimary === true) await tx.bankReceivingAccount.updateMany({ where: { bankPartnerId: a.bankPartnerId, currency: a.currency, isPrimary: true, id: { not: id } }, data: { isPrimary: false } });
    return tx.bankReceivingAccount.update({ where: { id }, data: { ...(isActive !== undefined && { isActive, ...(isActive === false && { isPrimary: false }) }), ...(isPrimary === true && { isPrimary: true, isActive: true }), ...(label !== undefined && { label }) } });
  });
  await logActivity({ userId: actor, action: 'bank_receiving_account_updated', entityType: 'BankReceivingAccount', entityId: id, details: { isActive, isPrimary }, req });
  return row;
};

/** The ONLY payment details a bank is ever shown for a settlement: Runserv's account at that same bank. */
const paymentInstructions = async (settlementId) => {
  const s = await prisma.bankSettlement.findUnique({ where: { id: settlementId }, include: { bankPartner: { select: { id: true, displayName: true } } } });
  if (!s) throw new AppError('Settlement not found.', 404);
  const acct = await prisma.bankReceivingAccount.findFirst({ where: { bankPartnerId: s.bankPartnerId, currency: s.currency, isActive: true }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] });
  if (!acct) throw new AppError(`No active ${s.currency} receiving account is set up for ${s.bankPartner.displayName}. Add one first.`, 409);
  let ref = s.paymentReference;
  if (!ref) { ref = `RSV-${crypto.randomBytes(4).toString('hex').toUpperCase()}`; await prisma.bankSettlement.update({ where: { id: s.id }, data: { paymentReference: ref } }); }
  const due = Math.max(toMinor(s.netAmount) - toMinor(s.receivedAmount), 0);
  return { settlementId: s.id, bank: s.bankPartner.displayName, currency: s.currency, amountDue: fromMinor(due), reference: ref,
    account: { name: acct.accountName, number: acct.accountNumber, bank: acct.bankName }, narration: `Put ${ref} in the transfer narration/description so it is matched automatically.` };
};

// ── Company payments (a company pays Runserv from ITS bank into one of OUR accounts) ───────────────
const newRef = (prefix) => `${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

const ensureCompanyReference = async (companyId) => {
  const c = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true, payReference: true } });
  if (!c) throw new AppError('Company not found.', 404);
  if (c.payReference) return c.payReference;
  for (let i = 0; i < 5; i++) {
    const ref = newRef('RSC');
    try { await prisma.company.update({ where: { id: companyId }, data: { payReference: ref } }); return ref; }
    catch (e) { if (e.code !== 'P2002') throw e; }
  }
  throw new AppError('Could not create a payment reference. Try again.', 500);
};
const ensureInvoiceReference = async (invoiceId) => {
  const i = await prisma.companyInvoice.findUnique({ where: { id: invoiceId }, select: { id: true, paymentReference: true } });
  if (!i) throw new AppError('Invoice not found.', 404);
  if (i.paymentReference) return i.paymentReference;
  for (let k = 0; k < 5; k++) {
    const ref = newRef('RSI');
    try { await prisma.companyInvoice.update({ where: { id: invoiceId }, data: { paymentReference: ref } }); return ref; }
    catch (e) { if (e.code !== 'P2002') throw e; }
  }
  throw new AppError('Could not create a payment reference. Try again.', 500);
};

/** What a company sees on its Billing page: every active Runserv account it can pay into (Wema, Fidelity, FirstBank…) + its references. */
const companyPaymentInstructions = async ({ companyId }) => {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, currency: true } });
  if (!company) throw new AppError('Company not found.', 404);
  const walletReference = await ensureCompanyReference(companyId);
  const [accounts, invoices] = await Promise.all([
    prisma.bankReceivingAccount.findMany({ where: { isActive: true, currency: company.currency }, include: { bankPartner: { select: { displayName: true } } }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] }),
    prisma.companyInvoice.findMany({ where: { companyId, status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] } }, orderBy: { dueDate: 'asc' }, take: 24 }),
  ]);
  const open = [];
  for (const inv of invoices) open.push({ invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, reference: await ensureInvoiceReference(inv.id), outstanding: fromMinor(Math.max(toMinor(inv.subtotal) - toMinor(inv.amountPaid), 0)), dueDate: inv.dueDate });
  return {
    currency: company.currency, walletReference,
    accounts: accounts.map((a) => ({ id: a.id, bank: a.bankPartner?.displayName || a.bankName, accountName: a.accountName, accountNumber: a.accountNumber, isPrimary: a.isPrimary })),
    openInvoices: open,
    narration: 'Put the reference in the transfer narration/description. Your payment is matched automatically, usually within minutes of the bank reporting it.',
  };
};

/** The company's own view: credits that reached Runserv for it, newest first. */
const companyReceipts = ({ companyId, take = 50 }) => prisma.bankPayment.findMany({
  where: { companyId, status: { in: ['MATCHED', 'PENDING_REVIEW', 'HELD'] } }, orderBy: { receivedAt: 'desc' }, take,
  select: { id: true, amount: true, currency: true, paidAt: true, receivedAt: true, status: true, paymentReference: true, invoiceId: true, bankPartner: { select: { displayName: true } } },
});

// ── The matching engine ─────────────────────────────────────────────────────────────────────────
const parseDate = (v, now) => { const d = new Date(v); if (!v || Number.isNaN(d.getTime())) return null; if (d.getTime() > now.getTime() + 86400000) return null; return d; };

const validatePayload = (p, now) => {
  const ref = String(p.bankTransactionRef ?? p.transactionId ?? '').trim();
  if (ref.length < 6 || ref.length > 80) throw new AppError('bankTransactionRef (the bank\'s own unique transaction id, 6–80 chars) is required.', 400);
  const amount = Number(p.amount);
  if (!Number.isFinite(amount) || amount <= 0 || toMinor(amount) <= 0 || amount > 1e12) throw new AppError('amount must be a positive number.', 400);
  const currency = String(p.currency || 'NGN').toUpperCase(); if (!/^[A-Z]{3}$/.test(currency)) throw new AppError('currency must be a 3-letter code.', 400);
  const paidAt = parseDate(p.paidAt || now.toISOString(), now); if (!paidAt) throw new AppError('paidAt must be a valid date that is not in the future.', 400);
  const narration = String(p.reference ?? p.narration ?? '').toUpperCase();
  const m = narration.match(REF_RE);
  return { ref, amount, currency, paidAt, paymentReference: m ? m[0] : null, payerName: p.payerName ? String(p.payerName).slice(0, 120) : null, creditedAccount: p.creditedAccountNumber ? String(p.creditedAccountNumber).replace(/\s+/g, '').slice(0, 34) : null };
};

/**
 * Works out what a reference points at. Never guesses: anything unclear is an exception for a person to look at.
 * @returns {{kind:'SETTLEMENT'|'WALLET'|'INVOICE'|null, row?:object, reason?:string, held?:boolean}}
 */
const resolveTarget = async (reference, bankPartnerId, currency) => {
  if (!reference) return { kind: null, reason: 'NO_REFERENCE' };
  const type = reference.slice(0, 3);
  if (type === 'RSV') {
    const s = await prisma.bankSettlement.findUnique({ where: { paymentReference: reference } });
    if (!s) return { kind: null, reason: 'UNKNOWN_REFERENCE' };
    if (s.bankPartnerId !== bankPartnerId) return { kind: null, reason: 'REFERENCE_BELONGS_TO_ANOTHER_BANK' };
    if (s.currency !== currency) return { kind: null, reason: 'CURRENCY_MISMATCH' };
    if (!OPEN.includes(s.status)) return { kind: 'SETTLEMENT', row: s, reason: `SETTLEMENT_${s.status}`, held: true };
    return { kind: 'SETTLEMENT', row: s };
  }
  if (type === 'RSC') {
    const c = await prisma.company.findUnique({ where: { payReference: reference }, select: { id: true, currency: true, status: true } });
    if (!c) return { kind: null, reason: 'UNKNOWN_REFERENCE' };
    if (c.currency !== currency) return { kind: null, reason: 'CURRENCY_MISMATCH' };
    if (c.status !== 'ACTIVE') return { kind: 'WALLET', row: c, reason: `COMPANY_${c.status}`, held: true };
    return { kind: 'WALLET', row: c };
  }
  if (type === 'RSI') {
    const i = await prisma.companyInvoice.findUnique({ where: { paymentReference: reference } });
    if (!i) return { kind: null, reason: 'UNKNOWN_REFERENCE' };
    if (i.currency !== currency) return { kind: null, reason: 'CURRENCY_MISMATCH' };
    if (['PAID', 'VOID'].includes(i.status)) return { kind: 'INVOICE', row: i, reason: `INVOICE_${i.status}`, held: true };
    if (toMinor(i.amount ?? 0) < 0) return { kind: null, reason: 'INVALID' };
    if (toMinor(i.subtotal) - toMinor(i.amountPaid) < 1) return { kind: 'INVOICE', row: i, reason: 'INVOICE_PAID', held: true };
    return { kind: 'INVOICE', row: i };
  }
  return { kind: null, reason: 'UNKNOWN_REFERENCE' };
};

/** Credits a company wallet from a bank credit, inside the caller's transaction. The reference makes it once-only. */
const applyToWallet = async (tx, { companyId, amountMinor, paymentId, actor, bankAccountId = null, currency = 'NGN' }) => {
  const amount = fromMinor(amountMinor);
  const co = await tx.company.update({ where: { id: companyId }, data: { walletBalance: { increment: amount } }, select: { walletBalance: true } });
  await tx.orgWalletTx.create({ data: { companyId, type: 'TOPUP', amount, balanceAfter: co.walletBalance, description: 'Bank transfer received', reference: `BANKPAY-${paymentId}`, createdById: actor || null } });
  // The real bank account the money reached on one side, the company's wallet on the other.
  await require('./ledger.service').move(tx, { account: `COMPANY_WALLET:${companyId}`, counter: `BANK:${bankAccountId || 'unknown'}`, direction: 'CREDIT', amount, currency, refType: 'BANK_PAYMENT', refId: paymentId, memo: 'Bank transfer received', actor });
  return { status: 'CREDITED' };
};

/**
 * Applies a resolved target inside `tx`. Returns { applied, status?, overMinor?, after? } or { applied:false, reason }.
 * `after` is a function to run once the transaction has committed (notifications, paying drivers).
 */
const applyResolved = async (tx, { kind, row }, payment, { actor, now }) => {
  const amountMinor = toMinor(payment.amount);
  if (kind === 'SETTLEMENT') {
    const a = await applyToSettlement(tx, row.id, amountMinor, now);
    return a ? { applied: true, settlementId: row.id, status: a.status, overMinor: a.overMinor } : { applied: false, reason: 'SETTLEMENT_CLOSED_DURING_PROCESSING' };
  }
  if (kind === 'WALLET') {
    await applyToWallet(tx, { companyId: row.id, amountMinor, paymentId: payment.id, actor, bankAccountId: payment.receivingAccountId, currency: payment.currency });
    return { applied: true, companyId: row.id };
  }
  if (kind === 'INVOICE') {
    const outstanding = toMinor(row.subtotal) - toMinor(row.amountPaid);
    // A credit larger than what is owed is never split by a program: a person decides where the rest goes.
    if (amountMinor > outstanding) return { applied: false, reason: `EXCEEDS_INVOICE_OUTSTANDING_BY_${fromMinor(amountMinor - outstanding)}` };
    const billing = require('./orgBilling.service');
    const r = await billing.recordPayment({ tx, invoiceId: row.id, amount: payment.amount, method: 'BANK_TRANSFER', reference: payment.bankTransactionRef, receivedAt: payment.paidAt, recordedById: actor || null, note: 'Matched from a bank credit' });
    return { applied: true, invoiceId: row.id, companyId: row.companyId, after: r.after };
  }
  return { applied: false, reason: 'NO_TARGET' };
};

const proposalOf = (t) => (t.kind ? { kind: t.kind, id: t.row.id } : null);
const fieldsOf = (t, applied) => ({
  settlementId: t.kind === 'SETTLEMENT' ? t.row.id : null,
  companyId: t.kind === 'WALLET' ? t.row.id : t.kind === 'INVOICE' ? t.row.companyId : null,
  invoiceId: t.kind === 'INVOICE' ? t.row.id : null,
  ...(applied ? {} : {}),
});

/**
 * Records one credit. A bank's signed WEBHOOK notice is applied straight away when it matches with certainty.
 * A credit typed in by staff (MANUAL) or read from a statement file (STATEMENT) is only RECORDED, as PENDING_REVIEW with the
 * match it would make; a different admin must approve it. Safe to call twice with the same notice.
 * @returns {{duplicate:boolean, payment:object, settlementStatus?:string}}
 */
const recordInboundPayment = async ({ bankPartnerId, payload, source = 'WEBHOOK', actor = null, req, now = new Date(), receivingAccountNumber = null }) => {
  const v = validatePayload(payload || {}, now);
  const existing = await prisma.bankPayment.findUnique({ where: { bankPartnerId_bankTransactionRef: { bankPartnerId, bankTransactionRef: v.ref } } });
  if (existing) return { duplicate: true, payment: existing };

  const creditedAccount = v.creditedAccount || (receivingAccountNumber ? String(receivingAccountNumber) : null);
  const account = creditedAccount ? await prisma.bankReceivingAccount.findFirst({ where: { bankPartnerId, accountNumber: creditedAccount } }) : null;
  const target = await resolveTarget(v.paymentReference, bankPartnerId, v.currency);

  let status = 'MATCHED'; let reason = null;
  if (source === 'WEBHOOK' && !account) { status = 'UNMATCHED'; reason = v.creditedAccount ? 'ACCOUNT_NOT_RUNSERVS_AT_THIS_BANK' : 'NO_ACCOUNT_IN_NOTICE'; }
  else if (!target.kind) { status = 'UNMATCHED'; reason = target.reason; }
  else if (target.held) { status = 'HELD'; reason = target.reason; }

  const manual = source !== 'WEBHOOK';
  const base = {
    bankPartnerId, receivingAccountId: account?.id ?? null, source, bankTransactionRef: v.ref, paymentReference: v.paymentReference,
    amount: v.amount, currency: v.currency, payerName: v.payerName, creditedAccount, paidAt: v.paidAt,
    ...(status === 'UNMATCHED' ? { settlementId: null } : fieldsOf(target)),
  };
  // Typed-in and imported credits wait for a second person; nothing has been applied.
  if (manual) Object.assign(base, { status: 'PENDING_REVIEW', reviewFrom: status === 'MATCHED' ? null : status, exceptionReason: reason, enteredById: actor, proposal: status === 'MATCHED' ? proposalOf(target) : null });
  else Object.assign(base, { status, exceptionReason: reason });

  let payment; let settlementStatus = null; const afters = [];
  try {
    payment = await prisma.$transaction(async (tx) => {
      const row = await tx.bankPayment.create({ data: base });
      if (manual || status !== 'MATCHED') return row;
      const r = await applyResolved(tx, target, row, { actor, now });
      if (!r.applied) return tx.bankPayment.update({ where: { id: row.id }, data: { status: 'HELD', exceptionReason: r.reason } });
      settlementStatus = r.status ?? null;
      if (r.after) afters.push(r.after);
      if (r.overMinor > 0) return tx.bankPayment.update({ where: { id: row.id }, data: { exceptionReason: `OVERPAID_BY_${fromMinor(r.overMinor)}` } });
      return row;
    });
  } catch (e) {
    if (e.code === 'P2002') { const dup = await prisma.bankPayment.findUnique({ where: { bankPartnerId_bankTransactionRef: { bankPartnerId, bankTransactionRef: v.ref } } }); if (dup) return { duplicate: true, payment: dup }; }
    throw e;
  }
  for (const f of afters) await Promise.resolve(f()).catch((e) => console.error('[bankReceipts] after-commit step failed:', e.message));
  await logActivity({ userId: actor, action: `bank_payment_${payment.status.toLowerCase()}`, entityType: 'BankPayment', entityId: payment.id, details: { bankPartnerId, amount: v.amount, currency: v.currency, target: target.kind, reason: payment.exceptionReason, source }, req });
  return { duplicate: false, payment, settlementStatus };
};

/** Adds money to an open settlement. Conditional on it still being open; returns null if it closed meanwhile. */
const applyToSettlement = async (tx, settlementId, addMinor, now) => {
  const s = await tx.bankSettlement.findUnique({ where: { id: settlementId } });
  if (!s || !OPEN.includes(s.status)) return null;
  const newReceived = toMinor(s.receivedAmount) + addMinor; const net = toMinor(s.netAmount);
  const paid = newReceived >= net;
  const res = await tx.bankSettlement.updateMany({ where: { id: settlementId, status: { in: OPEN }, receivedAmount: s.receivedAmount }, data: { receivedAmount: fromMinor(newReceived), ...(paid && { status: 'PAID', paidAt: now }) } });
  if (res.count !== 1) throw Object.assign(new Error('Settlement changed concurrently; retry.'), { code: 'P2034' }); // the bank's retry will apply it
  return { status: paid ? 'PAID' : s.status, overMinor: Math.max(newReceived - net, 0), remainingMinor: Math.max(net - newReceived, 0) };
};

const loadTarget = async (kind, id) => {
  if (kind === 'SETTLEMENT') { const row = await prisma.bankSettlement.findUnique({ where: { id } }); return row && { kind, row, held: !OPEN.includes(row.status), reason: `SETTLEMENT_${row.status}` }; }
  if (kind === 'WALLET') { const row = await prisma.company.findUnique({ where: { id }, select: { id: true, currency: true, status: true } }); return row && { kind, row, held: row.status !== 'ACTIVE', reason: `COMPANY_${row.status}` }; }
  if (kind === 'INVOICE') { const row = await prisma.companyInvoice.findUnique({ where: { id } }); return row && { kind, row, held: ['PAID', 'VOID'].includes(row.status), reason: `INVOICE_${row.status}` }; }
  return null;
};

/** Staff PROPOSE attaching an exception-queue credit to a settlement, a company wallet or an invoice. A second admin approves. */
const matchPayment = async ({ paymentId, settlementId, companyId, invoiceId, actor, note, req, now = new Date() }) => {
  if (!String(note || '').trim()) throw new AppError('A note explaining the match is required.', 400);
  const p = await prisma.bankPayment.findUnique({ where: { id: paymentId } });
  if (!p) throw new AppError('Payment not found.', 404);
  if (!['UNMATCHED', 'HELD'].includes(p.status)) throw new AppError(`A ${p.status} payment cannot be matched.`, 400);
  const kind = settlementId ? 'SETTLEMENT' : invoiceId ? 'INVOICE' : companyId ? 'WALLET' : null;
  if (!kind) throw new AppError('Choose a settlement, an invoice or a company wallet.', 400);
  const t = await loadTarget(kind, settlementId || invoiceId || companyId);
  if (!t) throw new AppError('That target was not found.', 404);
  if (kind === 'SETTLEMENT' && t.row.bankPartnerId !== p.bankPartnerId) throw new AppError('A credit can only settle an invoice of the bank that paid it.', 403);
  if (t.row.currency !== p.currency) throw new AppError('Currency does not match.', 400);
  if (t.held) throw new AppError(`That target is not open (${t.reason}).`, 409);
  const ok = await prisma.bankPayment.updateMany({ where: { id: p.id, status: p.status }, data: { status: 'PENDING_REVIEW', reviewFrom: p.status, proposal: { kind, id: t.row.id }, enteredById: actor, resolutionNote: String(note).slice(0, 500) } });
  if (ok.count !== 1) throw new AppError('Someone else just changed this credit. Refresh.', 409);
  await logActivity({ userId: actor, action: 'bank_payment_match_proposed', entityType: 'BankPayment', entityId: p.id, details: { kind, targetId: t.row.id, note: String(note).slice(0, 200) }, req });
  return prisma.bankPayment.findUnique({ where: { id: p.id } });
};

/** The second person. Cannot be the one who entered/proposed it. Only now does money move. */
const approveReview = async ({ paymentId, actor, note, req, now = new Date() }) => {
  const p = await prisma.bankPayment.findUnique({ where: { id: paymentId } });
  if (!p) throw new AppError('Payment not found.', 404);
  if (p.status !== 'PENDING_REVIEW') throw new AppError('This credit is not waiting for review.', 409);
  if (p.enteredById && p.enteredById === actor) throw new AppError('A different admin must approve a credit you entered or matched.', 403);
  const afters = [];
  const out = await prisma.$transaction(async (tx) => {
    const won = await tx.bankPayment.updateMany({ where: { id: p.id, status: 'PENDING_REVIEW' }, data: { reviewedById: actor, reviewedAt: now, reviewNote: note ? String(note).slice(0, 500) : null } });
    if (won.count !== 1) throw new AppError('Someone else just reviewed this credit.', 409);
    const prop = p.proposal;
    const target = prop?.kind ? await loadTarget(prop.kind, prop.id) : null;
    if (!target || target.held) {
      return tx.bankPayment.update({ where: { id: p.id }, data: { status: target?.held ? 'HELD' : 'UNMATCHED', exceptionReason: target?.held ? target.reason : (p.exceptionReason || 'NO_REFERENCE') } });
    }
    const r = await applyResolved(tx, target, p, { actor, now });
    if (!r.applied) return tx.bankPayment.update({ where: { id: p.id }, data: { status: 'HELD', exceptionReason: r.reason } });
    if (r.after) afters.push(r.after);
    return tx.bankPayment.update({ where: { id: p.id }, data: { status: 'MATCHED', ...fieldsOf(target), resolvedById: actor, resolvedAt: now, exceptionReason: r.overMinor > 0 ? `OVERPAID_BY_${fromMinor(r.overMinor)}` : null } });
  });
  for (const f of afters) await Promise.resolve(f()).catch((e) => console.error('[bankReceipts] after-commit step failed:', e.message));
  await logActivity({ userId: actor, action: 'bank_payment_review_approved', entityType: 'BankPayment', entityId: p.id, details: { enteredBy: p.enteredById, result: out.status }, req });
  return out;
};

const rejectReview = async ({ paymentId, actor, note, req, now = new Date() }) => {
  if (!String(note || '').trim()) throw new AppError('A reason is required to reject.', 400);
  const p = await prisma.bankPayment.findUnique({ where: { id: paymentId } });
  if (!p) throw new AppError('Payment not found.', 404);
  if (p.status !== 'PENDING_REVIEW') throw new AppError('This credit is not waiting for review.', 409);
  // An entry nobody confirmed is closed as REJECTED; a real bank credit someone proposed a match for goes back to the exception queue.
  const back = p.reviewFrom || 'REJECTED';
  const ok = await prisma.bankPayment.updateMany({ where: { id: p.id, status: 'PENDING_REVIEW' }, data: { status: back, proposal: null, reviewFrom: null, reviewedById: actor, reviewedAt: now, reviewNote: String(note).slice(0, 500) } });
  if (ok.count !== 1) throw new AppError('Someone else just reviewed this credit.', 409);
  await logActivity({ userId: actor, action: 'bank_payment_review_rejected', entityType: 'BankPayment', entityId: p.id, details: { note: String(note).slice(0, 200), backTo: back }, req });
  return prisma.bankPayment.findUnique({ where: { id: p.id } });
};

/** The bank reversed/recalled a credit. A settlement reopens; nothing is silently deleted. */
const reversePayment = async ({ paymentId, actor, note, req, now = new Date() }) => {
  if (!String(note || '').trim()) throw new AppError('A note is required.', 400);
  const p = await prisma.bankPayment.findUnique({ where: { id: paymentId } });
  if (!p) throw new AppError('Payment not found.', 404);
  if (p.status === 'REVERSED') throw new AppError('Already reversed.', 409);
  if (p.status === 'MATCHED' && (p.companyId || p.invoiceId)) {
    // Company money may already have been spent: this becomes a request that a DIFFERENT admin approves (claw back, invoice the rest).
    const r = await require('./moneyApprovals.service').request({ kind: 'BANK_CREDIT_REVERSAL', targetId: p.id, amount: p.amount, reason: String(note).trim().length >= 5 ? note : `${note} (bank reversal)`, actor, req });
    return { ...p, reversalRequested: true, requestId: r.id };
  }
  const row = await prisma.$transaction(async (tx) => {
    // Only one reversal can win this; before, two staff clicking together both subtracted from the settlement.
    const won = await tx.bankPayment.updateMany({ where: { id: p.id, status: p.status }, data: { status: 'REVERSED', resolvedById: actor, resolvedAt: now, resolutionNote: String(note).slice(0, 500) } });
    if (won.count !== 1) throw new AppError('Someone else just changed this credit. Refresh.', 409);
    if (p.status === 'MATCHED' && p.settlementId) {
      const s = await tx.bankSettlement.findUnique({ where: { id: p.settlementId } });
      const left = Math.max(toMinor(s.receivedAmount) - toMinor(p.amount), 0);
      await tx.bankSettlement.update({ where: { id: s.id }, data: { receivedAmount: fromMinor(left), ...(s.status === 'PAID' && left < toMinor(s.netAmount) && { status: 'RECONCILING', paidAt: null }) } });
    }
    return tx.bankPayment.findUnique({ where: { id: p.id } });
  });
  await logActivity({ userId: actor, action: 'bank_payment_reversed', entityType: 'BankPayment', entityId: p.id, details: { settlementId: p.settlementId, note: String(note).slice(0, 200) }, req });
  return row;
};

// ── Statement-file import ───────────────────────────────────────────────────────────────────────
const MAX_STATEMENT_BYTES = 2 * 1024 * 1024; const MAX_STATEMENT_ROWS = 2000;

/** A small, strict CSV reader (quotes, commas inside quotes, CRLF). No dependency, no formulas, nothing is evaluated. */
const parseCsv = (text) => {
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((x) => x.trim() !== '')) rows.push(row); row = []; }
    else cur += c;
  }
  row.push(cur); if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
};
const num = (v) => { const n = Number(String(v ?? '').replace(/[,\s₦]/g, '')); return Number.isFinite(n) ? n : NaN; };
const HEAD = {
  date: /^(value\s*date|trans(action)?\s*date|date|posted)/i, narration: /(narration|description|details|remark|particulars)/i,
  credit: /^(credit|credits|cr|deposit|money\s*in|amount\s*credited)/i, ref: /(trans(action)?\s*(id|ref(erence)?)|reference\s*(no|number)|\bref\b|session)/i, payer: /(sender|payer|originator|from|beneficiary)/i,
};

/**
 * Reads a bank statement CSV and records every CREDIT as PENDING_REVIEW (a second admin approves). Idempotent twice over: the
 * same file (by SHA-256) is refused, and each credit is unique per (bank, transaction id) anyway.
 */
const importStatement = async ({ bankPartnerId, receivingAccountId, fileName, csvText, actor, req, now = new Date() }) => {
  const bank = await prisma.bankPartner.findUnique({ where: { id: bankPartnerId }, select: { id: true } });
  if (!bank) throw new AppError('Bank partner not found.', 404);
  const acct = receivingAccountId ? await prisma.bankReceivingAccount.findFirst({ where: { id: receivingAccountId, bankPartnerId } }) : null;
  if (!acct) throw new AppError('Choose the Runserv account this statement is for.', 400);
  const text = String(csvText || '');
  if (!text.trim()) throw new AppError('The file is empty.', 400);
  if (Buffer.byteLength(text) > MAX_STATEMENT_BYTES) throw new AppError('The file is larger than 2 MB. Split it by month.', 413);
  const sha = crypto.createHash('sha256').update(text).digest('hex');
  if (await prisma.statementImport.findUnique({ where: { bankPartnerId_sha256: { bankPartnerId, sha256: sha } } })) throw new AppError('This exact file was already imported.', 409);

  const rows = parseCsv(text);
  const head = rows[0] || []; const col = {};
  for (const [k, re] of Object.entries(HEAD)) col[k] = head.findIndex((h) => re.test(String(h).trim()));
  if (col.credit < 0 || col.date < 0) throw new AppError('Could not find a Date and a Credit column in the first row of the file.', 400);
  const body = rows.slice(1);
  if (body.length > MAX_STATEMENT_ROWS) throw new AppError(`More than ${MAX_STATEMENT_ROWS} rows. Split the file.`, 413);

  let created = 0; let duplicates = 0; const errors = [];
  for (let i = 0; i < body.length; i++) {
    const r = body[i]; const amount = num(r[col.credit]);
    if (!(amount > 0)) continue;                                        // debits and blank credits are not our concern
    const narration = col.narration >= 0 ? String(r[col.narration] || '') : '';
    const date = new Date(r[col.date]);
    const ref = (col.ref >= 0 && String(r[col.ref] || '').trim().length >= 6) ? String(r[col.ref]).trim()
      : `STMT-${crypto.createHash('sha256').update([acct.id, r[col.date], amount, narration].join('|')).digest('hex').slice(0, 24)}`;
    try {
      const out = await recordInboundPayment({ bankPartnerId, source: 'STATEMENT', actor, req, now, receivingAccountNumber: acct.accountNumber,
        payload: { bankTransactionRef: ref, amount, currency: acct.currency, paidAt: Number.isNaN(date.getTime()) ? now.toISOString() : date.toISOString(), narration, payerName: col.payer >= 0 ? r[col.payer] : null } });
      if (out.duplicate) duplicates++; else created++;
    } catch (e) { errors.push({ row: i + 2, error: String(e.message).slice(0, 120) }); }
  }
  const rec = await prisma.statementImport.create({ data: { bankPartnerId, fileName: String(fileName || 'statement.csv').slice(0, 200), sha256: sha, rowCount: body.length, createdCount: created, duplicateCount: duplicates, errorCount: errors.length, errors: errors.slice(0, 50), importedById: actor } });
  await logActivity({ userId: actor, action: 'bank_statement_imported', entityType: 'StatementImport', entityId: rec.id, details: { bankPartnerId, rows: body.length, created, duplicates, errors: errors.length }, req });
  return rec;
};

// ── Exception-queue alerts ──────────────────────────────────────────────────────────────────────
/**
 * Tells the finance admins about credits that have sat in the exception queue (or waiting for a second approval) longer than
 * `olderThanHours`. Each credit alerts once (alertedAt), so a daily run never nags about the same item.
 */
const alertStaleExceptions = async ({ now = new Date(), olderThanHours = 24 } = {}) => {
  const cutoff = new Date(now.getTime() - olderThanHours * 3600000);
  const stale = await prisma.bankPayment.findMany({ where: { status: { in: ['UNMATCHED', 'HELD', 'PENDING_REVIEW'] }, receivedAt: { lt: cutoff }, alertedAt: null }, select: { id: true, status: true, amount: true, currency: true, bankPartner: { select: { displayName: true } } }, take: 200 });
  if (!stale.length) return { alerted: 0 };
  const staff = await prisma.user.findMany({ where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] }, isActive: true, isSuspended: false }, select: { id: true } });
  const by = {}; for (const p of stale) { const k = `${p.bankPartner?.displayName || 'bank'} · ${p.currency}`; by[k] = by[k] || { n: 0, minor: 0, review: 0 }; by[k].n++; by[k].minor += toMinor(p.amount); if (p.status === 'PENDING_REVIEW') by[k].review++; }
  const lines = Object.entries(by).map(([k, v]) => `${k}: ${v.n} credit(s), ${fromMinor(v.minor)} total${v.review ? ` (${v.review} waiting for a second approver)` : ''}`);
  const notifications = require('./notification.service');
  const message = `${stale.length} bank credit(s) have waited more than ${olderThanHours}h: ${lines.join(' · ')}. Open Banks → Receipts.`;
  for (const u of staff) { try { await notifications.notify({ userId: u.id, title: '⚠️ Bank credits need attention', message, type: 'bank_exceptions', data: { count: stale.length } }); } catch (e) { console.error('[bankReceipts] alert failed:', e.message); } }
  await prisma.bankPayment.updateMany({ where: { id: { in: stale.map((p) => p.id) }, alertedAt: null }, data: { alertedAt: now } });
  return { alerted: stale.length, recipients: staff.length };
};

/** One row per Runserv receiving account (Wema, Fidelity, FirstBank…): what reached it this month and what is still waiting. */
const perAccountSummary = async ({ now = new Date() } = {}) => {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [accounts, matched, waiting] = await Promise.all([
    prisma.bankReceivingAccount.findMany({ where: { isActive: true }, include: { bankPartner: { select: { displayName: true } } } }),
    prisma.bankPayment.groupBy({ by: ['receivingAccountId'], where: { status: 'MATCHED', receivedAt: { gte: monthStart } }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.bankPayment.groupBy({ by: ['receivingAccountId'], where: { status: { in: ['UNMATCHED', 'HELD', 'PENDING_REVIEW'] } }, _count: { _all: true } }),
  ]);
  const m = Object.fromEntries(matched.map((x) => [x.receivingAccountId, x])); const w = Object.fromEntries(waiting.map((x) => [x.receivingAccountId, x]));
  return accounts.map((a) => ({ id: a.id, bank: a.bankPartner?.displayName || a.bankName, account: mask(a.accountNumber), currency: a.currency, receivedThisMonth: Number(m[a.id]?._sum.amount ?? 0), credits: m[a.id]?._count._all ?? 0, waiting: w[a.id]?._count._all ?? 0 }));
};

const summary = async ({ now = new Date() } = {}) => {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [matchedMonth, exceptions, open, banks] = await Promise.all([
    prisma.bankPayment.aggregate({ where: { status: 'MATCHED', receivedAt: { gte: monthStart } }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.bankPayment.groupBy({ by: ['status'], where: { status: { in: ['UNMATCHED', 'HELD', 'PENDING_REVIEW'] } }, _count: { _all: true }, _sum: { amount: true } }),
    prisma.bankSettlement.findMany({ where: { status: { in: OPEN } }, select: { bankPartnerId: true, netAmount: true, receivedAmount: true, currency: true } }),
    prisma.bankPartner.findMany({ select: { id: true, displayName: true, webhookSecretVersion: true } }),
  ]);
  const outstanding = {}; for (const s of open) { const k = `${s.bankPartnerId}|${s.currency}`; outstanding[k] = (outstanding[k] || 0) + Math.max(toMinor(s.netAmount) - toMinor(s.receivedAmount), 0); }
  const name = Object.fromEntries(banks.map((b) => [b.id, b.displayName]));
  return {
    receivedThisMonth: { count: matchedMonth._count._all, amount: Number(matchedMonth._sum.amount ?? 0) },
    exceptions: Object.fromEntries(exceptions.map((e) => [e.status, { count: e._count._all, amount: Number(e._sum.amount ?? 0) }])),
    outstandingByBank: Object.entries(outstanding).map(([k, v]) => { const [id, currency] = k.split('|'); return { bankPartnerId: id, bank: name[id] || id, currency, outstanding: fromMinor(v) }; }),
    banksWithoutSecret: banks.filter((b) => !b.webhookSecretVersion).map((b) => ({ id: b.id, displayName: b.displayName })),
  };
};

module.exports = { OPEN, REF_RE, parseCsv, ensureCompanyReference, ensureInvoiceReference, companyPaymentInstructions, companyReceipts, resolveTarget, approveReview, rejectReview, importStatement, alertStaleExceptions, perAccountSummary, encryptSecret, decryptSecret, resolveBankSecret, rotateSecret, createAccount, updateAccount, paymentInstructions, validatePayload, recordInboundPayment, matchPayment, reversePayment, summary, mask };
