// Runserv staff: amounts a bank owes Runserv under its agreement (sponsorship, subsidy, verified acquisition).
import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Receipt, Plus } from 'lucide-react';
import { Button, Card, Modal, Spinner } from '@/components/common';
import { useAuth } from '@/hooks/useAuth';
import { bankAdminAPI, apiError } from '@/services/api/partnerships';
import type { BankCampaign, BankPartner, BankSettlement, SettlementStatus } from '@/types/partnerships';
import { PageHeader, SettlementTable, Field, fieldCls, selectCls, lagosStart, lagosEndExclusive, money, label, type SettlementRow } from '@/components/features/partnerships';

const BankSettlements: React.FC = () => {
  const { can } = useAuth();
  const [rows, setRows] = useState<BankSettlement[]>([]); const [loading, setLoading] = useState(true); const [status, setStatus] = useState('');
  const [banks, setBanks] = useState<BankPartner[]>([]); const [campaigns, setCampaigns] = useState<BankCampaign[]>([]);
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [busyId, setBusyId] = useState<string | null>(null);
  const [f, setF] = useState({ bankPartnerId: '', campaignId: '', from: '', to: '', agreedAmount: '', adjustmentsAmount: '', invoiceReference: '' });

  const load = useCallback(() => { setLoading(true); bankAdminAPI.settlements({ status: status || undefined }).then(setRows).catch((e) => toast.error(apiError(e))).finally(() => setLoading(false)); }, [status]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (open && !banks.length) { bankAdminAPI.partners().then(setBanks).catch(() => undefined); bankAdminAPI.campaigns({}).then(setCampaigns).catch(() => undefined); } }, [open, banks.length]);

  const create = async () => {
    if (new Date(f.to) < new Date(f.from)) return toast.error('“To” must not be before “From”.');
    setBusy(true);
    try {
      await bankAdminAPI.createSettlement({ bankPartnerId: f.bankPartnerId, campaignId: f.campaignId || undefined, periodStart: lagosStart(f.from), periodEnd: lagosEndExclusive(f.to), agreedAmount: Number(f.agreedAmount), adjustmentsAmount: f.adjustmentsAmount ? Number(f.adjustmentsAmount) : undefined, invoiceReference: f.invoiceReference || undefined });
      toast.success('Settlement recorded'); setOpen(false); setF({ bankPartnerId: '', campaignId: '', from: '', to: '', agreedAmount: '', adjustmentsAmount: '', invoiceReference: '' }); load();
    } catch (e) { toast.error(apiError(e)); } finally { setBusy(false); }
  };
  const move = async (id: string, to: SettlementStatus) => {
    let ref: string | undefined;
    if (to === 'PAID') {
      const r = window.prompt('Enter the bank’s own transaction reference for this payment (from the bank statement). Banks that pay through their platform are matched automatically; use this only for a payment you have seen on the statement.');
      if (!r || r.trim().length < 6) return toast.error('A bank transaction reference (6+ characters) is required to mark a settlement paid.');
      ref = r.trim();
    }
    setBusyId(id);
    try { await bankAdminAPI.transitionSettlement(id, to, ref); toast.success(`Settlement ${label(to).toLowerCase()}`); load(); } catch (e) { toast.error(apiError(e)); } finally { setBusyId(null); }
  };
  const table: SettlementRow[] = rows.map((s) => ({
    id: s.id, party: s.bankPartner?.displayName ?? s.bankPartnerId, ref: s.invoiceReference ?? s.id.slice(0, 8), periodStart: s.periodStart, periodEnd: s.periodEnd,
    headline: s.netAmount, currency: s.currency, status: s.status, paidAt: s.paidAt,
    breakdown: `${money(s.agreedAmount, s.currency)} agreed${Number(s.adjustmentsAmount) ? ` ${Number(s.adjustmentsAmount) > 0 ? '+' : '−'} ${money(Math.abs(Number(s.adjustmentsAmount)), s.currency)} adj.` : ''}`,
  }));
  const bankCampaigns = campaigns.filter((c) => c.bankPartnerId === f.bankPartnerId);

  return (
    <div className="space-y-5">
      <PageHeader icon={Receipt} color="bg-teal-100 text-teal-600" title="Bank settlements" subtitle="What each bank owes Runserv for the period, per the signed agreement. Reconcile against campaign and referral references before approving."
        actions={can.managePartnerships && <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" />Record settlement</Button>} />
      <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{['PENDING', 'RECONCILING', 'APPROVED', 'PAID', 'DISPUTED', 'CANCELLED'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
      <Card>{loading ? <div className="py-16 flex justify-center"><Spinner /></div> : <SettlementTable rows={table} canWrite={can.managePartnerships} partyHeader="Bank" amountHeader="Net receivable" busyId={busyId} onMove={move} link={(h, t) => <Link to={h}>{t}</Link>} />}</Card>

      <Modal isOpen={open} onClose={() => setOpen(false)} size="md" title="Record bank settlement"
        footer={<><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button loading={busy} disabled={!f.bankPartnerId || !f.from || !f.to || f.agreedAmount === ''} onClick={create}>Save</Button></>}>
        <div className="space-y-3">
          <Field label="Bank"><select className={fieldCls} value={f.bankPartnerId} onChange={(e) => setF({ ...f, bankPartnerId: e.target.value, campaignId: '' })}><option value="">Choose a bank…</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.displayName}</option>)}</select></Field>
          <Field label="Campaign (optional)"><select className={fieldCls} value={f.campaignId} disabled={!f.bankPartnerId} onChange={(e) => setF({ ...f, campaignId: e.target.value })}><option value="">Whole bank / not campaign-specific</option>{bankCampaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="From (inclusive)"><input type="date" className={fieldCls} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field><Field label="To (inclusive)"><input type="date" className={fieldCls} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field></div>
          <div className="grid grid-cols-2 gap-3"><Field label="Agreed amount (₦)"><input type="number" min={0} step="0.01" className={fieldCls} value={f.agreedAmount} onChange={(e) => setF({ ...f, agreedAmount: e.target.value })} /></Field><Field label="Adjustments (₦)" hint="Negative to deduct."><input type="number" step="0.01" className={fieldCls} value={f.adjustmentsAmount} onChange={(e) => setF({ ...f, adjustmentsAmount: e.target.value })} /></Field></div>
          <Field label="Invoice reference"><input className={fieldCls} value={f.invoiceReference} onChange={(e) => setF({ ...f, invoiceReference: e.target.value })} /></Field>
        </div>
      </Modal>
    </div>
  );
};
export default BankSettlements;
