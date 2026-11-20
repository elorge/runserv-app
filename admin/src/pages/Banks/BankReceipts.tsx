// Runserv staff: Runserv's own account at each partner bank, money received from banks (matched automatically from the
// bank's signed notice), the exception queue, and what each bank has still to pay. Every bank pays into ITS OWN account.
import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Landmark, Plus, KeyRound, Copy } from 'lucide-react';
import { Button, Card, Modal, Spinner } from '@/components/common';
import { useAuth } from '@/hooks/useAuth';
import { bankAdminAPI, apiError } from '@/services/api/partnerships';
import type { BankAccount, BankPartner, BankPayment, BankSettlement, PaymentInstructions, ReceiptsSummary } from '@/types/partnerships';
import { PageHeader, StatusBadge, Field, fieldCls, selectCls, money, label } from '@/components/features/partnerships';

const REASONS: Record<string, string> = {
  NO_REFERENCE: 'No Runserv reference in the narration', UNKNOWN_REFERENCE: 'Reference not recognised', REFERENCE_BELONGS_TO_ANOTHER_BANK: 'Reference belongs to a different bank',
  ACCOUNT_NOT_RUNSERVS_AT_THIS_BANK: 'Credited account is not Runserv’s account at this bank', NO_ACCOUNT_IN_NOTICE: 'Notice did not name the credited account', CURRENCY_MISMATCH: 'Currency differs from the settlement',
};
const reasonText = (r?: string | null) => (!r ? '' : REASONS[r] ?? (r.startsWith('SETTLEMENT_') ? `Settlement is ${label(r.slice(11))}` : r.startsWith('OVERPAID_BY_') ? `Overpaid by ${r.slice(12)}` : r));
type Tab = 'receipts' | 'exceptions' | 'accounts' | 'instructions';

const BankReceipts: React.FC = () => {
  const { can } = useAuth(); const write = can.managePartnerships;
  const [tab, setTab] = useState<Tab>('receipts');
  const [sum, setSum] = useState<ReceiptsSummary | null>(null); const [banks, setBanks] = useState<BankPartner[]>([]);
  const [payments, setPayments] = useState<BankPayment[]>([]); const [accounts, setAccounts] = useState<BankAccount[]>([]); const [open, setOpen] = useState<BankSettlement[]>([]);
  const [loading, setLoading] = useState(true); const [bankFilter, setBankFilter] = useState('');
  const [acctModal, setAcctModal] = useState(false); const [af, setAf] = useState({ bankPartnerId: '', accountName: 'Runserv', accountNumber: '', label: '' });
  const [secret, setSecret] = useState<{ bank: string; secret: string } | null>(null);
  const [match, setMatch] = useState<BankPayment | null>(null); const [target, setTarget] = useState(''); const [note, setNote] = useState('');
  const [manual, setManual] = useState(false); const [mf, setMf] = useState({ bankPartnerId: '', bankTransactionRef: '', amount: '', reference: '', paidAt: '', confirm: false });
  const [instr, setInstr] = useState<PaymentInstructions | null>(null); const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([bankAdminAPI.receiptsSummary(), bankAdminAPI.payments({ bankPartnerId: bankFilter || undefined, limit: 100 }), bankAdminAPI.accounts(), bankAdminAPI.settlements({})])
      .then(([s, p, a, st]) => { setSum(s); setPayments(p); setAccounts(a); setOpen(st.filter((x) => ['PENDING', 'RECONCILING', 'APPROVED'].includes(x.status))); })
      .catch((e) => toast.error(apiError(e))).finally(() => setLoading(false));
  }, [bankFilter]);
  useEffect(() => { load(); bankAdminAPI.partners().then(setBanks).catch(() => undefined); }, [load]);

  const run = async (fn: () => Promise<unknown>, ok: string, done?: () => void) => { setBusy(true); try { await fn(); toast.success(ok); done?.(); load(); } catch (e) { toast.error(apiError(e)); } finally { setBusy(false); } };
  const exceptions = payments.filter((p) => p.status === 'UNMATCHED' || p.status === 'HELD');
  const staffEntered = payments.filter((p) => p.source === 'MANUAL' && p.status === 'MATCHED');
  const candidates = match ? open.filter((s) => s.bankPartnerId === match.bankPartnerId && s.currency === match.currency) : [];

  return (
    <div className="space-y-5">
      <PageHeader icon={Landmark} color="bg-emerald-100 text-emerald-600" title="Bank accounts & receipts"
        subtitle="Runserv keeps one account at each partner bank. Each bank pays into its own account through its own platform and the credit is matched to its settlement automatically."
        actions={write && <div className="flex gap-2"><Button variant="outline" onClick={() => setManual(true)}>Record statement credit</Button><Button onClick={() => setAcctModal(true)}><Plus className="h-4 w-4" />Add account</Button></div>} />

      {sum && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Card><div className="p-4"><p className="text-xs text-gray-500">Received this month</p><p className="text-xl font-bold">{money(sum.receivedThisMonth.amount)}</p><p className="text-xs text-gray-500">{sum.receivedThisMonth.count} credits</p></div></Card>
          <Card><div className="p-4"><p className="text-xs text-gray-500">Needs attention</p><p className="text-xl font-bold">{(sum.exceptions.UNMATCHED?.count ?? 0) + (sum.exceptions.HELD?.count ?? 0)}</p><p className="text-xs text-gray-500">{money((sum.exceptions.UNMATCHED?.amount ?? 0) + (sum.exceptions.HELD?.amount ?? 0))} unapplied</p></div></Card>
          <Card><div className="p-4"><p className="text-xs text-gray-500">Still owed by banks</p><p className="text-xl font-bold">{money(sum.outstandingByBank.reduce((a, b) => a + b.outstanding, 0))}</p><p className="text-xs text-gray-500">{sum.outstandingByBank.length} bank(s)</p></div></Card>
          <Card><div className="p-4"><p className="text-xs text-gray-500">Banks without a callback secret</p><p className="text-xl font-bold">{sum.banksWithoutSecret.length}</p><p className="text-xs text-gray-500">cannot send automatic notices</p></div></Card>
        </div>
      )}

      <div className="flex flex-wrap gap-2 items-center">
        {(['receipts', 'exceptions', 'accounts', 'instructions'] as Tab[]).map((t) => <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 rounded-lg text-sm ${tab === t ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700'}`}>{{ receipts: 'Receipts', exceptions: `Exceptions${exceptions.length ? ` (${exceptions.length})` : ''}`, accounts: 'Accounts & secrets', instructions: 'Payment instructions' }[t]}</button>)}
        <select className={`${selectCls} ml-auto`} value={bankFilter} onChange={(e) => setBankFilter(e.target.value)}><option value="">All banks</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.displayName}</option>)}</select>
      </div>

      {loading ? <div className="py-16 flex justify-center"><Spinner /></div> : (
        <Card>
          {tab === 'receipts' && (
            <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-gray-500 border-b"><th className="p-3">Received</th><th>Bank</th><th>Amount</th><th>Bank reference</th><th>Settlement</th><th>Status</th><th>Source</th>{write && <th />}</tr></thead>
              <tbody>{payments.map((p) => <tr key={p.id} className="border-b last:border-0"><td className="p-3">{new Date(p.receivedAt).toLocaleString()}</td><td>{p.bankPartner?.displayName}</td><td className="font-medium">{money(p.amount, p.currency)}</td><td className="font-mono text-xs">{p.bankTransactionRef}</td><td className="font-mono text-xs">{p.settlement?.paymentReference ?? '—'}</td><td><StatusBadge status={p.status} />{p.exceptionReason?.startsWith('OVERPAID') && <div className="text-xs text-amber-600">{reasonText(p.exceptionReason)}</div>}</td><td>{p.source === 'MANUAL' ? 'Entered by staff' : 'Bank notice'}</td>{write && <td>{p.status === 'MATCHED' && <button className="text-xs text-red-600" onClick={() => { const n = window.prompt('Why was this credit reversed? (required)'); if (n) run(async () => { const r: any = await bankAdminAPI.reversePayment(p.id, n); if (r?.reversalRequested) toast('Reversal requested. A different admin must approve it on the Approvals page.', { icon: 'ℹ️' }); }, 'Done'); }}>Reverse</button>}</td>}</tr>)}{!payments.length && <tr><td colSpan={8} className="p-10 text-center text-gray-500">No receipts yet.</td></tr>}</tbody></table>
              {staffEntered.length > 0 && <p className="p-3 text-xs text-amber-700 bg-amber-50">{staffEntered.length} credit(s) here were typed in by staff rather than reported by a bank. A second person should check them against the bank statement.</p>}</div>
          )}
          {tab === 'exceptions' && (
            <div className="divide-y">{exceptions.map((p) => <div key={p.id} className="p-4 flex flex-wrap items-center gap-3"><div className="flex-1 min-w-[220px]"><div className="font-medium">{money(p.amount, p.currency)} · {p.bankPartner?.displayName}</div><div className="text-xs text-gray-500 font-mono">{p.bankTransactionRef} · {p.payerName ?? 'payer unknown'}</div><div className="text-sm text-amber-700">{reasonText(p.exceptionReason)}</div></div>{write && <Button variant="outline" onClick={() => { setMatch(p); setTarget(''); setNote(''); }}>Match to a settlement</Button>}</div>)}{!exceptions.length && <p className="p-10 text-center text-gray-500">Nothing waiting. Every credit was matched.</p>}</div>
          )}
          {tab === 'accounts' && (
            <div className="p-4 space-y-5">
              {banks.map((b) => { const mine = accounts.filter((a) => a.bankPartnerId === b.id); return (
                <div key={b.id} className="border rounded-lg p-3"><div className="flex items-center justify-between"><div className="font-semibold">{b.displayName}</div>{write && <Button variant="outline" onClick={() => { if (window.confirm(`Generate a new callback secret for ${b.displayName}? The old one stops working immediately and the bank must be given the new one.`)) run(async () => { const r = await bankAdminAPI.rotateSecret(b.id); setSecret({ bank: b.displayName, secret: r.secret }); }, 'New secret generated'); }}><KeyRound className="h-4 w-4" />New callback secret</Button>}</div>
                  {mine.length ? mine.map((a) => <div key={a.id} className="flex flex-wrap items-center gap-3 text-sm py-1.5"><span className="font-mono">{a.accountNumber}</span><span>{a.accountName}</span><span className="text-gray-500">{a.currency}</span>{a.isPrimary && <span className="text-xs bg-emerald-100 text-emerald-700 px-2 rounded">Primary</span>}{!a.isActive && <span className="text-xs bg-gray-200 px-2 rounded">Inactive</span>}{write && <span className="ml-auto flex gap-3">{!a.isPrimary && a.isActive && <button className="text-xs text-blue-600" onClick={() => run(() => bankAdminAPI.updateAccount(a.id, { isPrimary: true }), 'Made primary')}>Make primary</button>}<button className="text-xs text-gray-600" onClick={() => run(() => bankAdminAPI.updateAccount(a.id, { isActive: !a.isActive }), a.isActive ? 'Deactivated' : 'Activated')}>{a.isActive ? 'Deactivate' : 'Activate'}</button></span>}</div>) : <p className="text-sm text-gray-500 py-1">No account yet. This bank cannot be given payment details until one is added.</p>}
                </div>); })}
            </div>
          )}
          {tab === 'instructions' && (
            <div className="divide-y">{open.filter((s) => !bankFilter || s.bankPartnerId === bankFilter).map((s) => <div key={s.id} className="p-4 flex flex-wrap items-center gap-3"><div className="flex-1"><div className="font-medium">{s.bankPartner?.displayName} · {money(Number(s.netAmount) - Number(s.receivedAmount ?? 0), s.currency)} due</div><div className="text-xs text-gray-500">{s.invoiceReference ?? s.id.slice(0, 8)} · <StatusBadge status={s.status} /></div></div><Button variant="outline" onClick={() => bankAdminAPI.instructions(s.id).then(setInstr).catch((e) => toast.error(apiError(e)))}>Payment details</Button></div>)}{!open.length && <p className="p-10 text-center text-gray-500">No open settlements.</p>}</div>
          )}
        </Card>
      )}

      <Modal isOpen={acctModal} onClose={() => setAcctModal(false)} size="md" title="Add Runserv’s account at a bank" footer={<><Button variant="outline" onClick={() => setAcctModal(false)}>Cancel</Button><Button loading={busy} disabled={!af.bankPartnerId || af.accountNumber.length < 10} onClick={() => run(() => bankAdminAPI.addAccount({ ...af, label: af.label || undefined }), 'Account added', () => setAcctModal(false))}>Save</Button></>}>
        <div className="space-y-3"><Field label="Bank"><select className={fieldCls} value={af.bankPartnerId} onChange={(e) => setAf({ ...af, bankPartnerId: e.target.value })}><option value="">Choose…</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.displayName}</option>)}</select></Field><Field label="Account name" hint="Exactly as the bank holds it."><input className={fieldCls} value={af.accountName} onChange={(e) => setAf({ ...af, accountName: e.target.value })} /></Field><Field label="Account number" hint="10 digits for naira. This must be Runserv’s account AT this same bank."><input className={fieldCls} inputMode="numeric" value={af.accountNumber} onChange={(e) => setAf({ ...af, accountNumber: e.target.value.replace(/\s/g, '') })} /></Field><Field label="Label (optional)"><input className={fieldCls} value={af.label} onChange={(e) => setAf({ ...af, label: e.target.value })} /></Field></div>
      </Modal>

      <Modal isOpen={!!secret} onClose={() => setSecret(null)} size="md" title={`Callback secret for ${secret?.bank}`} footer={<Button onClick={() => setSecret(null)}>I have copied it</Button>}>
        <p className="text-sm text-gray-600 mb-3">Send this to the bank through a secure channel. <b>It is shown only once</b> and cannot be recovered; generate a new one if it is lost.</p>
        <div className="flex items-center gap-2"><code className="flex-1 break-all bg-gray-100 rounded p-2 text-xs">{secret?.secret}</code><Button variant="outline" onClick={() => { navigator.clipboard?.writeText(secret?.secret ?? ''); toast.success('Copied'); }}><Copy className="h-4 w-4" /></Button></div>
      </Modal>

      <Modal isOpen={!!match} onClose={() => setMatch(null)} size="md" title="Match credit to a settlement" footer={<><Button variant="outline" onClick={() => setMatch(null)}>Cancel</Button><Button loading={busy} disabled={!target || note.trim().length < 3} onClick={() => match && run(() => bankAdminAPI.matchPayment(match.id, target, note), 'Matched', () => setMatch(null))}>Match</Button></>}>
        {match && <div className="space-y-3"><p className="text-sm">{money(match.amount, match.currency)} from {match.bankPartner?.displayName}. Only open settlements of the same bank are listed.</p><Field label="Settlement"><select className={fieldCls} value={target} onChange={(e) => setTarget(e.target.value)}><option value="">Choose…</option>{candidates.map((s) => <option key={s.id} value={s.id}>{s.invoiceReference ?? s.id.slice(0, 8)} · {money(Number(s.netAmount) - Number(s.receivedAmount ?? 0), s.currency)} due</option>)}</select></Field><Field label="Why does this match?" hint="Required. Kept in the audit log."><input className={fieldCls} value={note} onChange={(e) => setNote(e.target.value)} /></Field></div>}
      </Modal>

      <Modal isOpen={manual} onClose={() => setManual(false)} size="md" title="Record a credit seen on the bank statement" footer={<><Button variant="outline" onClick={() => setManual(false)}>Cancel</Button><Button loading={busy} disabled={!mf.bankPartnerId || mf.bankTransactionRef.length < 6 || !mf.amount || !mf.confirm} onClick={() => run(() => bankAdminAPI.recordPayment({ bankPartnerId: mf.bankPartnerId, bankTransactionRef: mf.bankTransactionRef, amount: Number(mf.amount), reference: mf.reference || undefined, paidAt: mf.paidAt ? new Date(mf.paidAt).toISOString() : undefined, confirmSeenOnStatement: true }), 'Recorded', () => setManual(false))}>Record</Button></>}>
        <div className="space-y-3"><p className="text-xs text-gray-500">For a bank that cannot send automatic notices. The same matching rules apply and a repeated bank reference is never counted twice.</p><Field label="Bank"><select className={fieldCls} value={mf.bankPartnerId} onChange={(e) => setMf({ ...mf, bankPartnerId: e.target.value })}><option value="">Choose…</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.displayName}</option>)}</select></Field><div className="grid grid-cols-2 gap-3"><Field label="Bank transaction reference"><input className={fieldCls} value={mf.bankTransactionRef} onChange={(e) => setMf({ ...mf, bankTransactionRef: e.target.value })} /></Field><Field label="Amount"><input type="number" min={0} step="0.01" className={fieldCls} value={mf.amount} onChange={(e) => setMf({ ...mf, amount: e.target.value })} /></Field></div><Field label="Narration (include the RSV- reference)"><input className={fieldCls} value={mf.reference} onChange={(e) => setMf({ ...mf, reference: e.target.value })} /></Field><Field label="Value date"><input type="date" className={fieldCls} value={mf.paidAt} onChange={(e) => setMf({ ...mf, paidAt: e.target.value })} /></Field><label className="flex gap-2 text-sm"><input type="checkbox" checked={mf.confirm} onChange={(e) => setMf({ ...mf, confirm: e.target.checked })} />I have seen this credit on the bank statement.</label></div>
      </Modal>

      <Modal isOpen={!!instr} onClose={() => setInstr(null)} size="md" title="Payment details to give the bank" footer={<Button onClick={() => setInstr(null)}>Close</Button>}>
        {instr && <div className="space-y-2 text-sm"><p>{instr.bank} pays <b>{money(instr.amountDue, instr.currency)}</b> into Runserv’s account <b>at {instr.bank}</b>:</p><div className="bg-gray-50 rounded p-3 font-mono text-xs space-y-1"><div>{instr.account.bank}</div><div>{instr.account.name}</div><div>{instr.account.number}</div><div>Reference: {instr.reference}</div></div><p className="text-gray-600">{instr.narration}</p></div>}
      </Modal>
    </div>
  );
};
export default BankReceipts;
