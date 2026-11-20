// Runserv staff: bank campaigns — create, track status, jump into approval.
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Megaphone, Plus } from 'lucide-react';
import { Button, Card, Modal, Spinner } from '@/components/common';
import { useAuth } from '@/hooks/useAuth';
import { bankAdminAPI, apiError } from '@/services/api/partnerships';
import type { BankCampaign, BankPartner } from '@/types/partnerships';
import { PageHeader, StatusBadge, EmptyRow, Th, Field, fieldCls, selectCls, fmtDate, money, label } from '@/components/features/partnerships';

const CampaignList: React.FC = () => {
  const nav = useNavigate(); const { can } = useAuth();
  const [sp, setSp] = useSearchParams(); const bankPartnerId = sp.get('bankPartnerId') || '';
  const [rows, setRows] = useState<BankCampaign[]>([]); const [banks, setBanks] = useState<BankPartner[]>([]); const [status, setStatus] = useState(''); const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ bankPartnerId: '', name: '', description: '', startsAt: '', endsAt: '', budgetAmount: '', landingPageUrl: '', attributionWindowDays: '30' });

  useEffect(() => { bankAdminAPI.partners().then(setBanks).catch(() => undefined); }, []);
  const load = useCallback(() => { setLoading(true); bankAdminAPI.campaigns({ status: status || undefined, bankPartnerId: bankPartnerId || undefined }).then(setRows).catch((e) => toast.error(apiError(e))).finally(() => setLoading(false)); }, [status, bankPartnerId]);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setBusy(true);
    try {
      const r = await bankAdminAPI.createCampaign({
        bankPartnerId: f.bankPartnerId, name: f.name.trim(), description: f.description.trim() || undefined,
        startsAt: f.startsAt ? new Date(f.startsAt).toISOString() : null, endsAt: f.endsAt ? new Date(f.endsAt).toISOString() : null,
        budgetAmount: f.budgetAmount ? Number(f.budgetAmount) : null, landingPageUrl: f.landingPageUrl.trim() || null, attributionWindowDays: Number(f.attributionWindowDays) || 30,
      });
      toast.success('Draft campaign created — add its offers next'); nav(`/banks/campaigns/${r.campaign.id}`);
    } catch (e) { toast.error(apiError(e)); } finally { setBusy(false); }
  };
  const setK = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <div className="space-y-5">
      <PageHeader icon={Megaphone} color="bg-fuchsia-100 text-fuchsia-600" title="Bank campaigns" subtitle="Draft → Pending approval → Scheduled / Active. Only approved campaigns inside their dates are shown to customers."
        actions={can.managePartnerships && <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" />New campaign</Button>} />
      <div className="flex flex-wrap gap-3">
        <select className={selectCls} value={bankPartnerId} onChange={(e) => setSp(e.target.value ? { bankPartnerId: e.target.value } : {})}><option value="">All banks</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.displayName}</option>)}</select>
        <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{['DRAFT', 'PENDING_APPROVAL', 'SCHEDULED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'EXPIRED', 'CANCELLED'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
      </div>
      <Card>
        {loading ? <div className="py-16 flex justify-center"><Spinner /></div> : rows.length === 0 ? <EmptyRow text="No campaigns yet." /> : (
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr className="border-b border-gray-100"><Th>Campaign</Th><Th>Bank</Th><Th>Runs</Th><Th right>Budget used</Th><Th right>Offers</Th><Th>Status</Th></tr></thead>
            <tbody className="divide-y divide-gray-50">{rows.map((c) => (
              <tr key={c.id} onClick={() => nav(`/banks/campaigns/${c.id}`)} className="cursor-pointer hover:bg-gray-50">
                <td className="py-3 pr-4"><p className="font-medium text-gray-900">{c.name}</p><p className="font-mono text-xs text-gray-400">{c.campaignCode}</p></td>
                <td className="py-3 pr-4">{c.bankPartner?.displayName}</td>
                <td className="py-3 pr-4 text-gray-600 whitespace-nowrap">{fmtDate(c.startsAt)} → {fmtDate(c.endsAt)}</td>
                <td className="py-3 pr-4 text-right">{c.budgetAmount === null ? <span className="text-gray-400">No cap</span> : `${money(c.spentAmount, c.currency)} / ${money(c.budgetAmount, c.currency)}`}</td>
                <td className="py-3 pr-4 text-right">{c._count?.offers ?? 0}</td>
                <td className="py-3"><StatusBadge status={c.status} /></td></tr>))}</tbody></table></div>)}
      </Card>

      <Modal isOpen={open} onClose={() => setOpen(false)} size="lg" title="New campaign"
        footer={<><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button loading={busy} disabled={!f.bankPartnerId || !f.name.trim()} onClick={create}>Create draft</Button></>}>
        <div className="space-y-3">
          <Field label="Bank"><select className={fieldCls} value={f.bankPartnerId} onChange={setK('bankPartnerId')}><option value="">Choose a bank…</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.displayName} ({label(b.status)})</option>)}</select></Field>
          <Field label="Campaign name"><input className={fieldCls} value={f.name} maxLength={200} onChange={setK('name')} /></Field>
          <Field label="Internal description"><textarea className={fieldCls} rows={2} value={f.description} onChange={setK('description')} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="Starts"><input type="datetime-local" className={fieldCls} value={f.startsAt} onChange={setK('startsAt')} /></Field><Field label="Ends"><input type="datetime-local" className={fieldCls} value={f.endsAt} onChange={setK('endsAt')} /></Field></div>
          <div className="grid grid-cols-2 gap-3"><Field label="Budget cap (₦)" hint="Blank = no cap. Redemption stops when reached."><input type="number" min={0} className={fieldCls} value={f.budgetAmount} onChange={setK('budgetAmount')} /></Field><Field label="Attribution window (days)"><input type="number" min={1} max={365} className={fieldCls} value={f.attributionWindowDays} onChange={setK('attributionWindowDays')} /></Field></div>
          <Field label="Bank-approved landing page (https)"><input className={fieldCls} value={f.landingPageUrl} onChange={setK('landingPageUrl')} placeholder="https://…" /></Field>
        </div>
      </Modal>
    </div>
  );
};
export default CampaignList;
