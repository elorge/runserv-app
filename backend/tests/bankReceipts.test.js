'use strict';
// In-memory stand-in for the tables the receipts engine touches, so the real matching logic runs end to end.
const db = { settlements: [], payments: [], accounts: [], banks: [] };
const clone = (o) => (o ? { ...o } : o);
const matchWhere = (row, where = {}) => Object.entries(where).every(([k, v]) => {
  if (k === 'bankPartnerId_bankTransactionRef') return row.bankPartnerId === v.bankPartnerId && row.bankTransactionRef === v.bankTransactionRef;
  if (v && typeof v === 'object' && !(v instanceof Date)) { if (v.in) return v.in.includes(row[k]); if ('not' in v) return row[k] !== v.not; if ('gte' in v) return Number(row[k]) >= v.gte; return true; }
  return String(row[k]) === String(v);
});
let n = 0;
const table = (name) => ({
  findUnique: async ({ where, include }) => { const r = clone(db[name].find((x) => matchWhere(x, where))) ?? null; if (r && include?.bankPartner) r.bankPartner = db.banks.find((b) => b.id === r.bankPartnerId); return r; },
  findFirst: async ({ where }) => clone(db[name].find((r) => matchWhere(r, where))) ?? null,
  create: async ({ data }) => { if (name === 'payments' && db.payments.some((p) => p.bankPartnerId === data.bankPartnerId && p.bankTransactionRef === data.bankTransactionRef)) { const e = new Error('dup'); e.code = 'P2002'; throw e; } const row = { id: `${name}${++n}`, resolvedById: null, ...data }; db[name].push(row); return clone(row); },
  update: async ({ where, data }) => { const r = db[name].find((x) => x.id === where.id); Object.assign(r, data); return clone(r); },
  updateMany: async ({ where, data }) => { const rows = db[name].filter((r) => matchWhere(r, where)); rows.forEach((r) => Object.assign(r, data)); return { count: rows.length }; },
});
const mockDb = { bankSettlement: table('settlements'), bankPayment: table('payments'), bankReceivingAccount: table('accounts'), bankPartner: table('banks'), activityLog: { create: async () => ({}) }, $transaction: async (fn) => (typeof fn === 'function' ? fn(mockDb) : Promise.all(fn)) };
jest.mock('../src/lib/prisma', () => mockDb);
const svc = require('../src/services/bankReceipts.service');

const NOW = new Date('2026-11-17T12:00:00Z');
const settle = (o = {}) => ({ id: 's1', bankPartnerId: 'A', currency: 'NGN', status: 'APPROVED', netAmount: 100000, receivedAmount: 0, paymentReference: 'RSV-AAAA1111', ...o });
const note = (o = {}) => ({ bankTransactionRef: 'TXN-000001', amount: 100000, currency: 'NGN', paidAt: '2026-11-17T11:00:00Z', reference: 'Runserv RSV-AAAA1111 campaign fee', creditedAccountNumber: '0123456789', ...o });
const pay = (o = {}, bank = 'A') => svc.recordInboundPayment({ bankPartnerId: bank, payload: note(o), now: NOW });

beforeEach(() => {
  for (const k of Object.keys(db)) db[k] = [];
  db.banks.push({ id: 'A', displayName: 'Bank A' }, { id: 'B', displayName: 'Bank B' });
  db.accounts.push({ id: 'acA', bankPartnerId: 'A', accountNumber: '0123456789', currency: 'NGN', isActive: true }, { id: 'acB', bankPartnerId: 'B', accountNumber: '0999999999', currency: 'NGN', isActive: true });
  db.settlements.push(settle(), settle({ id: 's2', bankPartnerId: 'B', paymentReference: 'RSV-BBBB2222' }));
});

describe('automatic matching', () => {
  test('an exact credit with the right reference pays the settlement', async () => {
    const r = await pay();
    expect(r.payment.status).toBe('MATCHED'); expect(r.settlementStatus).toBe('PAID');
    expect(db.settlements[0]).toMatchObject({ status: 'PAID', receivedAmount: 100000 });
  });
  test('the reference is found inside free-text narration, any case', async () => {
    const r = await pay({ reference: 'trf from acme plc rsv-aaaa1111 thanks' }); expect(r.payment.status).toBe('MATCHED');
  });
  test('a part payment keeps the settlement open and accumulates', async () => {
    await pay({ amount: 40000 }); expect(db.settlements[0]).toMatchObject({ status: 'APPROVED', receivedAmount: 40000 });
    const r = await pay({ bankTransactionRef: 'TXN-000002', amount: 60000 }); expect(r.settlementStatus).toBe('PAID'); expect(db.settlements[0].receivedAmount).toBe(100000);
  });
  test('an overpayment pays it off and flags the excess', async () => {
    const r = await pay({ amount: 105000.5 }); expect(r.payment.exceptionReason).toBe('OVERPAID_BY_5000.5'); expect(db.settlements[0].status).toBe('PAID');
  });
  test('kobo arithmetic is exact (0.1 + 0.2 style errors cannot leave a settlement unpaid)', async () => {
    db.settlements[0].netAmount = 0.3; await pay({ amount: 0.1 }); const r = await pay({ bankTransactionRef: 'TXN-000002', amount: 0.2 }); expect(r.settlementStatus).toBe('PAID');
  });
});

describe('no leak: the same notice, wrong bank, wrong account', () => {
  test('the same bank transaction id twice is counted once', async () => {
    await pay({ amount: 40000 }); const again = await pay({ amount: 40000 });
    expect(again.duplicate).toBe(true); expect(db.payments).toHaveLength(1); expect(db.settlements[0].receivedAmount).toBe(40000);
  });
  test('bank A quoting bank B\'s reference cannot pay bank B\'s settlement', async () => {
    const r = await pay({ reference: 'RSV-BBBB2222' }, 'A');
    expect(r.payment).toMatchObject({ status: 'UNMATCHED', exceptionReason: 'REFERENCE_BELONGS_TO_ANOTHER_BANK', settlementId: null });
    expect(db.settlements[1]).toMatchObject({ status: 'APPROVED', receivedAmount: 0 });
  });
  test('a credit to an account that is not Runserv\'s account at that bank is not applied', async () => {
    const r = await pay({ creditedAccountNumber: '0999999999' }, 'A'); // that is bank B's account
    expect(r.payment).toMatchObject({ status: 'UNMATCHED', exceptionReason: 'ACCOUNT_NOT_RUNSERVS_AT_THIS_BANK' });
    expect(db.settlements[0].receivedAmount).toBe(0);
  });
  test('missing or unknown reference goes to the exception queue', async () => {
    expect((await pay({ reference: 'rent' })).payment.exceptionReason).toBe('NO_REFERENCE');
    expect((await pay({ bankTransactionRef: 'TXN-000003', reference: 'RSV-DEADBEEF' })).payment.exceptionReason).toBe('UNKNOWN_REFERENCE');
  });
  test('currency mismatch is never applied', async () => {
    expect((await pay({ currency: 'USD' })).payment.exceptionReason).toBe('CURRENCY_MISMATCH');
  });
  test('a closed, cancelled or already-paid settlement holds the money instead of changing it', async () => {
    for (const st of ['CANCELLED', 'PAID', 'DISPUTED']) { db.settlements[0].status = st; db.payments = []; const r = await pay(); expect(r.payment).toMatchObject({ status: 'HELD', exceptionReason: `SETTLEMENT_${st}` }); }
    expect(db.settlements[0].receivedAmount).toBe(0);
  });
  test('bad payloads are rejected before anything is stored', async () => {
    for (const bad of [{ amount: 0 }, { amount: -5 }, { amount: 'abc' }, { bankTransactionRef: 'x' }, { paidAt: '2030-01-01' }, { currency: 'naira' }]) await expect(pay(bad)).rejects.toMatchObject({ statusCode: 400 });
    expect(db.payments).toHaveLength(0);
  });
});

describe('exception queue', () => {
  test('staff can PROPOSE a match only to the SAME bank\'s settlement, with a note; a second admin makes it real', async () => {
    const { payment } = await pay({ reference: 'no ref' });
    await expect(svc.matchPayment({ paymentId: payment.id, settlementId: 's1', note: '', actor: 'u', now: NOW })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.matchPayment({ paymentId: payment.id, settlementId: 's2', note: 'x ok', actor: 'u', now: NOW })).rejects.toMatchObject({ statusCode: 403 });
    const m = await svc.matchPayment({ paymentId: payment.id, settlementId: 's1', note: 'Bank confirmed by phone', actor: 'u', now: NOW });
    expect(m.status).toBe('PENDING_REVIEW'); expect(db.settlements[0]).toMatchObject({ status: 'APPROVED', receivedAmount: 0 });
    await expect(svc.approveReview({ paymentId: payment.id, actor: 'u', now: NOW })).rejects.toMatchObject({ statusCode: 403 });
    const done = await svc.approveReview({ paymentId: payment.id, actor: 'v', now: NOW });
    expect(done.status).toBe('MATCHED'); expect(db.settlements[0].status).toBe('PAID');
    await expect(svc.approveReview({ paymentId: payment.id, actor: 'w', now: NOW })).rejects.toMatchObject({ statusCode: 409 });
    await expect(svc.matchPayment({ paymentId: payment.id, settlementId: 's1', note: 'again', actor: 'u', now: NOW })).rejects.toMatchObject({ statusCode: 400 });
  });
  test('rejecting a proposed match returns the real bank credit to the exception queue', async () => {
    const { payment } = await pay({ reference: 'no ref' });
    await svc.matchPayment({ paymentId: payment.id, settlementId: 's1', note: 'looks like it', actor: 'u', now: NOW });
    await svc.rejectReview({ paymentId: payment.id, actor: 'v', note: 'wrong payer', now: NOW });
    expect(db.payments[0].status).toBe('UNMATCHED'); expect(db.settlements[0].receivedAmount).toBe(0);
  });
  test('a reversed credit reopens the settlement', async () => {
    const { payment } = await pay(); await svc.reversePayment({ paymentId: payment.id, note: 'bank recall', actor: 'u', now: NOW });
    expect(db.settlements[0]).toMatchObject({ status: 'RECONCILING', receivedAmount: 0, paidAt: null });
    await expect(svc.reversePayment({ paymentId: payment.id, note: 'again', actor: 'u' })).rejects.toMatchObject({ statusCode: 409 });
  });
  test('a credit typed in by staff does NOTHING until a different admin approves it', async () => {
    const a = await svc.recordInboundPayment({ bankPartnerId: 'A', payload: note({ creditedAccountNumber: undefined }), source: 'MANUAL', actor: 'u', now: NOW });
    expect(a.payment).toMatchObject({ status: 'PENDING_REVIEW', source: 'MANUAL', enteredById: 'u' });
    expect(db.settlements[0]).toMatchObject({ status: 'APPROVED', receivedAmount: 0 });
    expect((await svc.recordInboundPayment({ bankPartnerId: 'A', payload: note(), source: 'MANUAL', actor: 'u', now: NOW })).duplicate).toBe(true);
    await expect(svc.approveReview({ paymentId: a.payment.id, actor: 'u', now: NOW })).rejects.toMatchObject({ statusCode: 403 });
    expect((await svc.approveReview({ paymentId: a.payment.id, actor: 'v', now: NOW })).status).toBe('MATCHED');
    expect(db.settlements[0]).toMatchObject({ status: 'PAID', receivedAmount: 100000 });
  });
  test('two staff reversing the same credit cannot both subtract it', async () => {
    const { payment } = await pay();
    await svc.reversePayment({ paymentId: payment.id, note: 'recall', actor: 'u', now: NOW });
    await expect(svc.reversePayment({ paymentId: payment.id, note: 'recall too', actor: 'v', now: NOW })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('statement import', () => {
  const csv = 'Date,Narration,Debit,Credit,Reference\n2026-11-16,Transfer RSV-AAAA1111 fee,,100000,TXN-ST-0001\n2026-11-16,Charges,50,,TXN-ST-0002\n2026-11-17,Salary,,2500.50,TXN-ST-0003\n';
  beforeEach(() => { mockDb.statementImport = { findUnique: async () => null, create: async ({ data }) => ({ id: 'imp1', ...data }) }; });
  test('every credit becomes a pending-review item; debits are skipped; nothing is applied', async () => {
    const r = await svc.importStatement({ bankPartnerId: 'A', receivingAccountId: 'acA', fileName: 'nov.csv', csvText: csv, actor: 'u', now: NOW });
    expect(r).toMatchObject({ rowCount: 3, createdCount: 2, errorCount: 0 });
    expect(db.payments.every((p) => p.status === 'PENDING_REVIEW' && p.source === 'STATEMENT')).toBe(true);
    expect(db.settlements[0].receivedAmount).toBe(0);
  });
  test('a file without Date and Credit columns is refused; the same file twice is refused', async () => {
    await expect(svc.importStatement({ bankPartnerId: 'A', receivingAccountId: 'acA', csvText: 'a,b\n1,2', actor: 'u' })).rejects.toMatchObject({ statusCode: 400 });
    mockDb.statementImport.findUnique = async () => ({ id: 'x' });
    await expect(svc.importStatement({ bankPartnerId: 'A', receivingAccountId: 'acA', csvText: csv, actor: 'u' })).rejects.toMatchObject({ statusCode: 409 });
  });
  test('the CSV reader handles quotes and commas inside quotes', () => {
    const text = 'a,"b,c",d\r\n"x ""y""",2,3';
    expect(svc.parseCsv(text)).toEqual([['a', 'b,c', 'd'], ['x "y"', '2', '3']]);
  });
});

describe('company bank transfers', () => {
  beforeEach(() => {
    db.companies = []; db.invoices = [];
    mockDb.company = { ...table('companies'), update: async ({ where, data }) => { const r = db.companies.find((x) => x.id === where.id); if (data.walletBalance?.increment) r.walletBalance += data.walletBalance.increment; else Object.assign(r, data); return clone(r); } };
    mockDb.companyInvoice = table('invoices'); mockDb.orgWalletTx = { create: async ({ data }) => data };
    db.companies.push({ id: 'c1', currency: 'NGN', status: 'ACTIVE', payReference: 'RSC-C0C0C0C0', walletBalance: 0 });
  });
  test('a bank credit quoting the company reference tops up the company wallet by itself', async () => {
    const r = await pay({ reference: 'Acme top up RSC-C0C0C0C0', amount: 250000 });
    expect(r.payment).toMatchObject({ status: 'MATCHED', companyId: 'c1' });
    expect(db.companies[0].walletBalance).toBe(250000);
  });
  test('the same notice twice credits the wallet once', async () => {
    await pay({ reference: 'RSC-C0C0C0C0', amount: 1000 }); await pay({ reference: 'RSC-C0C0C0C0', amount: 1000 });
    expect(db.companies[0].walletBalance).toBe(1000);
  });
  test('a typed-in company credit does not touch the wallet until approved by someone else', async () => {
    const a = await svc.recordInboundPayment({ bankPartnerId: 'A', payload: note({ reference: 'RSC-C0C0C0C0', amount: 5000, creditedAccountNumber: undefined }), source: 'MANUAL', actor: 'u', now: NOW });
    expect(db.companies[0].walletBalance).toBe(0);
    await svc.approveReview({ paymentId: a.payment.id, actor: 'v', now: NOW });
    expect(db.companies[0].walletBalance).toBe(5000);
  });
  test('a company reference with the wrong currency is never applied', async () => {
    const r = await pay({ reference: 'RSC-C0C0C0C0', currency: 'XOF' });
    expect(r.payment).toMatchObject({ status: 'UNMATCHED', exceptionReason: 'CURRENCY_MISMATCH' }); expect(db.companies[0].walletBalance).toBe(0);
  });
});

describe('receiving accounts and instructions', () => {
  test('instructions show ONLY that bank\'s own account and the settlement reference', async () => {
    const i = await svc.paymentInstructions('s1'); expect(i).toMatchObject({ reference: 'RSV-AAAA1111', amountDue: 100000, account: { number: '0123456789' } });
    expect(JSON.stringify(i)).not.toContain('0999999999');
  });
  test('no account for the bank means no instructions (never another bank\'s account)', async () => {
    db.accounts = db.accounts.filter((a) => a.bankPartnerId !== 'A'); await expect(svc.paymentInstructions('s1')).rejects.toMatchObject({ statusCode: 409 });
  });
  test('naira accounts need 10 digits; duplicates refused; first account becomes primary', async () => {
    db.accounts = [];
    await expect(svc.createAccount({ bankPartnerId: 'A', accountName: 'Runserv Ltd', accountNumber: '123', actor: 'u' })).rejects.toMatchObject({ statusCode: 400 });
    const a = await svc.createAccount({ bankPartnerId: 'A', accountName: 'Runserv Ltd', accountNumber: '0123456789', actor: 'u' }); expect(a.isPrimary).toBe(true);
    await expect(svc.createAccount({ bankPartnerId: 'A', accountName: 'Runserv Ltd', accountNumber: '0123456789', actor: 'u' })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('bank secrets', () => {
  const env = { BANK_SECRETS_KEY: 'k'.repeat(40) };
  test('encrypt/decrypt round-trips and a tampered blob is rejected', () => {
    const blob = svc.encryptSecret('s3cret', env); expect(blob).not.toContain('s3cret'); expect(svc.decryptSecret(blob, env)).toBe('s3cret');
    expect(svc.decryptSecret(blob.slice(0, -4) + 'AAAA', env)).toBeNull();
    expect(svc.decryptSecret(blob, { BANK_SECRETS_KEY: 'z'.repeat(40) })).toBeNull();
  });
  test('rotation stores only the encrypted value and returns the plain secret once', async () => {
    const out = await svc.rotateSecret({ bankPartnerId: 'A', actor: 'u', env });
    expect(out.secret).toHaveLength(64); expect(db.banks[0].webhookSecretEnc).not.toContain(out.secret); expect(db.banks[0].webhookSecretVersion).toBe(1);
    expect(await svc.resolveBankSecret('A', env)).toBe(out.secret);
  });
  test('falls back to the environment map; refuses to run without a key', async () => {
    expect(await svc.resolveBankSecret('B', { BANK_WEBHOOK_SECRETS: '{"B":"envsecret"}' })).toBe('envsecret');
    await expect(svc.rotateSecret({ bankPartnerId: 'B', actor: 'u', env: {} })).rejects.toMatchObject({ statusCode: 500 });
  });
});
