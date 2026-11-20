// Second-person approval queue. Nothing here moves money until a DIFFERENT admin approves it:
//  1. money staff typed in about a company (wallet credit / adjustment / invoice receipt), and
//  2. bank credits staff typed in, read from a statement file, or matched by hand.
import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { ShieldCheck } from 'lucide-react';
import { Button, Card, Spinner } from '@/components/common';
import { useAuthStore } from '@/store/authStore';
import { bankAdminAPI, moneyApprovalsAPI, apiError } from '@/services/api/partnerships';
import type { BankPayment } from '@/types/partnerships';
import type { PendingMoneyAction } from '@/services/api/partnerships';
import { PageHeader, StatusBadge, money, label } from '@/components/features/partnerships';

const KIND: Record<string, string> = { ORG_WALLET_CREDIT: 'Company wallet credit', ORG_WALLET_ADJUST: 'Company wallet adjustment', INVOICE_RECEIPT: 'Invoice receipt', BANK_CREDIT_REVERSAL: 'Reverse a bank credit already applied to a company' };

const Approvals: React.FC = () => {
  const me = useAuthStore((s) => s.user?.id);
  const [acts, setActs] = useState<PendingMoneyAction[]>([]); const [credits, setCredits] = useState<BankPayment[]>([]);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([moneyApprovalsAPI.list('PENDING'), bankAdminAPI.payments({ status: 'PENDING_REVIEW', limit: 200 })])
      .then(([a, c]) => { setActs(a); setCredits(c); }).catch((e) => toast.error(apiError(e))).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key); try { await fn(); toast.success(ok); load(); } catch (e) { toast.error(apiError(e)); load(); } finally { setBusy(''); }
  };
  const reject = (key: string, fn: (n: string) => Promise<unknown>) => { const n = window.prompt('Reason for rejecting (required)'); if (n && n.trim().length >= 3) run(key, () => fn(n.trim()), 'Rejected'); };
  const confirmApprove = (text: string) => window.confirm(`${text}\n\nThis applies the money straight away.`);

  return (
    <div className="space-y-5">
      <PageHeader icon={ShieldCheck} color="bg-amber-100 text-amber-600" title="Approvals"
        subtitle="Money entered by hand needs a second person. You cannot approve what you entered yourself." />
      {loading ? <div className="py-16 flex justify-center"><Spinner /></div> : (<>
        <Card>
          <div className="px-5 pt-4 pb-2"><h3 className="font-semibold">Company money requests ({acts.length})</h3></div>
          <div className="divide-y">
            {acts.map((a) => { const mine = a.requestedById === me; return (
              <div key={a.id} className="p-4 flex flex-wrap items-center gap-3">
                <div className="flex-1 min-w-[240px]">
                  <div className="font-medium">{KIND[a.kind] ?? label(a.kind)} · {money(a.amount, a.currency)}</div>
                  <div className="text-sm text-gray-600">{a.reason}</div>
                  {a.kind === 'BANK_CREDIT_REVERSAL' && <div className="text-xs text-amber-700">Approving takes back what is still in the company wallet (never below zero) and sends the company a debit note for the rest. A credit that paid an invoice reopens that invoice.</div>}
                  <div className="text-xs text-gray-400 font-mono">target {a.targetId.slice(0, 8)} · {new Date(a.createdAt).toLocaleString()}</div>
                </div>
                {mine ? <span className="text-xs text-gray-500">You requested this. Another admin must decide.</span> : (
                  <div className="flex gap-2">
                    <Button disabled={busy === a.id} onClick={() => confirmApprove(`Approve ${KIND[a.kind] ?? a.kind} of ${money(a.amount, a.currency)}?`) && run(a.id, () => moneyApprovalsAPI.approve(a.id), 'Approved and applied')}>Approve</Button>
                    <Button variant="outline" disabled={busy === a.id} onClick={() => reject(a.id, (n) => moneyApprovalsAPI.reject(a.id, n))}>Reject</Button>
                  </div>)}
              </div>); })}
            {!acts.length && <p className="p-8 text-center text-gray-500">No company requests waiting.</p>}
          </div>
        </Card>

        <Card>
          <div className="px-5 pt-4 pb-2"><h3 className="font-semibold">Bank credits to check ({credits.length})</h3><p className="text-xs text-gray-500">Check each against the bank statement before approving.</p></div>
          <div className="divide-y">
            {credits.map((p) => { const mine = p.enteredById === me; return (
              <div key={p.id} className="p-4 flex flex-wrap items-center gap-3">
                <div className="flex-1 min-w-[260px]">
                  <div className="font-medium">{money(p.amount, p.currency)} · {p.bankPartner?.displayName} <StatusBadge status={p.status} /></div>
                  <div className="text-xs text-gray-500 font-mono">{p.bankTransactionRef} · {p.payerName ?? 'payer unknown'} · {p.source === 'STATEMENT' ? 'from statement file' : 'typed in or matched by staff'}</div>
                  <div className="text-sm text-gray-600">{p.proposal ? `Proposed: apply to ${label(p.proposal.kind)} ${p.proposal.id.slice(0, 8)}` : `Proposed: record only (${label(p.reviewFrom ?? 'unmatched')})`}{p.exceptionReason ? ` · ${p.exceptionReason}` : ''}</div>
                </div>
                {mine ? <span className="text-xs text-gray-500">You entered this. Another admin must decide.</span> : (
                  <div className="flex gap-2">
                    <Button disabled={busy === p.id} onClick={() => confirmApprove(`Approve credit of ${money(p.amount, p.currency)} (${p.bankTransactionRef})?`) && run(p.id, () => bankAdminAPI.approveReview(p.id), 'Approved')}>Approve</Button>
                    <Button variant="outline" disabled={busy === p.id} onClick={() => reject(p.id, (n) => bankAdminAPI.rejectReview(p.id, n))}>Reject</Button>
                  </div>)}
              </div>); })}
            {!credits.length && <p className="p-8 text-center text-gray-500">No bank credits waiting.</p>}
          </div>
        </Card>
      </>)}
    </div>
  );
};
export default Approvals;
