// Runserv staff: bank partners — profile, signed-agreement record and partner status.
import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Landmark, Plus } from 'lucide-react';
import { Alert, Button, Card, Modal, Spinner } from '@/components/common';
import { useAuth } from '@/hooks/useAuth';
import { bankAdminAPI, apiError, type BankPartnerInput } from '@/services/api/partnerships';
import type { BankPartner, BankStatus } from '@/types/partnerships';
import { PageHeader, StatusBadge, EmptyRow, Th, Field, fieldCls, selectCls, fmtDate, label, PromptModal } from '@/components/features/partnerships';

const NEXT: Record<BankStatus, { to: BankStatus; text: string; danger?: boolean; reason?: boolean }[]> = {
  PROSPECT: [{ to: 'DUE_DILIGENCE', text: 'Start due diligence' }],
  DUE_DILIGENCE: [{ to: 'CONTRACT_PENDING', text: 'Contract stage' }],
  CONTRACT_PENDING: [{ to: 'ACTIVE', text: 'Activate' }],
  ACTIVE: [{ to: 'PAUSED', text: 'Pause', danger: true, reason: true }, { to: 'TERMINATED', text: 'Terminate', danger: true, reason: true }],
  PAUSED: [{ to: 'ACTIVE', text: 'Resume' }, { to: 'TERMINATED', text: 'Terminate', danger: true, reason: true }],
  TERMINATED: [],
};
const EMPTY = { legalName: '', displayName: '', countryCode: 'NG', logoUrl: '', websiteUrl: '', contactEmail: '', contactPhone: '', agreementReference: '', agreementStartAt: '', agreementEndAt: '' };
const day = (v?: string | null) => (v ? v.slice(0, 10) : '');

const BankList: React.FC = () => {
  const { can } = useAuth(); const canWrite = can.managePartnerships;
  const [rows, setRows] = useState<BankPartner[]>([]); const [loading, setLoading] = useState(true); const [status, setStatus] = useState('');
  const [edit, setEdit] = useState<BankPartner | 'new' | null>(null); const [f, setF] = useState(EMPTY); const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<{ bank: BankPartner; to: BankStatus } | null>(null);

  const load = useCallback(() => { setLoading(true); bankAdminAPI.partners(status).then(setRows).catch((e) => toast.error(apiError(e))).finally(() => setLoading(false)); }, [status]);
  useEffect(() => { load(); }, [load]);

  const openEdit = (b: BankPartner | 'new') => {
    setEdit(b);
    setF(b === 'new' ? EMPTY : { legalName: b.legalName, displayName: b.displayName, countryCode: b.countryCode, logoUrl: b.logoUrl ?? '', websiteUrl: b.websiteUrl ?? '', contactEmail: b.contactEmail ?? '', contactPhone: b.contactPhone ?? '', agreementReference: b.agreementReference ?? '', agreementStartAt: day(b.agreementStartAt), agreementEndAt: day(b.agreementEndAt) });
  };
  const save = async () => {
    const body: BankPartnerInput = { ...f, logoUrl: f.logoUrl || null, websiteUrl: f.websiteUrl || null, contactEmail: f.contactEmail || null, contactPhone: f.contactPhone || null, agreementReference: f.agreementReference || null, agreementStartAt: f.agreementStartAt || null, agreementEndAt: f.agreementEndAt || null };
    setBusy(true);
    try {
      if (edit === 'new') await bankAdminAPI.createPartner(body); else if (edit) await bankAdminAPI.updatePartner(edit.id, body);
      toast.success('Bank saved'); setEdit(null); load();
    } catch (e) { toast.error(apiError(e)); } finally { setBusy(false); }
  };
  const move = async (bank: BankPartner, to: BankStatus, reason?: string) => {
    try { await bankAdminAPI.setPartnerStatus(bank.id, to, reason); toast.success(`${bank.displayName} is now ${label(to).toLowerCase()}`); setAsk(null); load(); } catch (e) { toast.error(apiError(e)); }
  };
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <div className="space-y-5">
      <PageHeader icon={Landmark} color="bg-violet-100 text-violet-600" title="Bank partners" subtitle="Banks whose approved offers Runserv may show. Nothing is shown for a bank until it is Active with a recorded agreement."
        actions={canWrite && <Button onClick={() => openEdit('new')}><Plus className="h-4 w-4" />Add bank</Button>} />
      <Alert variant="warning">Do not publish a bank’s name, logo, product, rate or offer without its <b>written approval</b> of the creative and terms. Pausing or terminating a bank hides all of its offers immediately.</Alert>
      <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{['PROSPECT', 'DUE_DILIGENCE', 'CONTRACT_PENDING', 'ACTIVE', 'PAUSED', 'TERMINATED'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
      <Card>
        {loading ? <div className="py-16 flex justify-center"><Spinner /></div> : rows.length === 0 ? <EmptyRow text="No bank partners yet." /> : (
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr className="border-b border-gray-100"><Th>Bank</Th><Th>Agreement</Th><Th right>Campaigns</Th><Th>Status</Th><Th right>{canWrite ? 'Actions' : ''}</Th></tr></thead>
            <tbody className="divide-y divide-gray-50">{rows.map((b) => (
              <tr key={b.id} className="align-top">
                <td className="py-3 pr-4"><p className="font-medium text-gray-900">{b.displayName}</p><p className="text-xs text-gray-400">{b.legalName} · {b.countryCode}</p>{b.contactEmail && <p className="text-xs text-gray-400">{b.contactEmail}</p>}</td>
                <td className="py-3 pr-4 text-gray-600">{b.agreementReference ? <><p className="font-mono text-xs">{b.agreementReference}</p><p className="text-xs text-gray-400">{fmtDate(b.agreementStartAt)} → {fmtDate(b.agreementEndAt)}</p></> : <span className="text-amber-600 text-xs">No agreement recorded</span>}</td>
                <td className="py-3 pr-4 text-right"><Link className="text-blue-600 hover:underline" to={`/banks/campaigns?bankPartnerId=${b.id}`}>{b._count?.campaigns ?? 0}</Link></td>
                <td className="py-3 pr-4"><StatusBadge status={b.status} /></td>
                <td className="py-3"><div className="flex flex-wrap justify-end gap-1.5">{canWrite && <>
                  <Button size="sm" variant="outline" onClick={() => openEdit(b)}>Edit</Button>
                  {NEXT[b.status].map((a) => <Button key={a.to} size="sm" variant={a.danger ? 'outline' : 'success'} onClick={() => (a.reason ? setAsk({ bank: b, to: a.to }) : move(b, a.to))}>{a.text}</Button>)}</>}</div></td></tr>))}</tbody></table></div>)}
      </Card>

      <Modal isOpen={!!edit} onClose={() => setEdit(null)} size="xl" title={edit === 'new' ? 'Add bank partner' : 'Edit bank partner'}
        footer={<><Button variant="outline" onClick={() => setEdit(null)}>Cancel</Button><Button loading={busy} disabled={!f.legalName.trim() || !f.displayName.trim()} onClick={save}>Save</Button></>}>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Legal name"><input className={fieldCls} value={f.legalName} onChange={set('legalName')} /></Field>
          <Field label="Display name (shown to customers)"><input className={fieldCls} value={f.displayName} onChange={set('displayName')} /></Field>
          <Field label="Country (ISO code)"><input className={fieldCls} maxLength={2} value={f.countryCode} onChange={(e) => setF({ ...f, countryCode: e.target.value.toUpperCase() })} /></Field>
          <Field label="Website (https)"><input className={fieldCls} value={f.websiteUrl} onChange={set('websiteUrl')} placeholder="https://…" /></Field>
          <Field label="Approved logo URL (https)" hint="Only the logo the bank approved in writing."><input className={fieldCls} value={f.logoUrl} onChange={set('logoUrl')} placeholder="https://…" /></Field>
          <Field label="Bank contact email"><input type="email" className={fieldCls} value={f.contactEmail} onChange={set('contactEmail')} /></Field>
          <Field label="Bank contact phone"><input className={fieldCls} value={f.contactPhone} onChange={set('contactPhone')} /></Field>
          <Field label="Signed agreement reference" hint="Required before the bank can be activated."><input className={fieldCls} value={f.agreementReference} onChange={set('agreementReference')} /></Field>
          <Field label="Agreement start"><input type="date" className={fieldCls} value={f.agreementStartAt} onChange={set('agreementStartAt')} /></Field>
          <Field label="Agreement end"><input type="date" className={fieldCls} value={f.agreementEndAt} onChange={set('agreementEndAt')} /></Field>
        </div>
      </Modal>
      <PromptModal open={!!ask} title={`${ask ? label(ask.to) : ''} ${ask?.bank.displayName ?? ''}`} fieldLabel="Reason (kept in the audit log)" required confirmLabel="Confirm" danger onClose={() => setAsk(null)} onSubmit={(t) => move(ask!.bank, ask!.to, t)}
        description="All of this bank’s offers are hidden from customers immediately." />
    </div>
  );
};
export default BankList;
