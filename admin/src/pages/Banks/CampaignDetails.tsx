// Runserv staff: one bank campaign — approval workflow, offers, and an honest performance funnel.
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Megaphone, Plus } from 'lucide-react';
import { Alert, Button, Modal, Spinner } from '@/components/common';
import { useAuth } from '@/hooks/useAuth';
import { bankAdminAPI, apiError, type CampaignAction, type OfferInput } from '@/services/api/partnerships';
import type { BankCampaign, BankOffer, CampaignReport, EligibilityType, OfferType } from '@/types/partnerships';
import { PageHeader, StatusBadge, InfoCard, Field, fieldCls, EmptyRow, fmtDate, money, label, toLocalInput, PromptModal } from '@/components/features/partnerships';

const OFFER_TYPES: OfferType[] = ['DISCOUNT', 'CASHBACK', 'SPONSORED_RIDE', 'SPONSORED_DELIVERY', 'ACCOUNT_OPENING', 'DEFERRED_PAYMENT', 'CREDIT'];
const ELIGIBILITY: EligibilityType[] = ['PUBLIC', 'EXISTING_BANK_CUSTOMERS', 'NEW_BANK_CUSTOMERS', 'INVITATION_ONLY', 'BANK_APPROVAL_REQUIRED'];
const isCredit = (t: OfferType) => t === 'CREDIT' || t === 'DEFERRED_PAYMENT';

type OfferForm = { title: string; shortDescription: string; termsAndConditions: string; offerType: OfferType; eligibilityType: EligibilityType; discountPercent: string; discountAmount: string; maxBenefitAmount: string; minTripAmount: string; redemptionLimit: string; perCustomerLimit: string; accountOpeningUrl: string; displayPriority: string; requiresBankApproval: boolean };
const blankOffer: OfferForm = { title: '', shortDescription: '', termsAndConditions: '', offerType: 'DISCOUNT', eligibilityType: 'BANK_APPROVAL_REQUIRED', discountPercent: '', discountAmount: '', maxBenefitAmount: '', minTripAmount: '', redemptionLimit: '', perCustomerLimit: '', accountOpeningUrl: '', displayPriority: '0', requiresBankApproval: true };
const fromOffer = (o: BankOffer): OfferForm => ({ title: o.title, shortDescription: o.shortDescription ?? '', termsAndConditions: o.termsAndConditions, offerType: o.offerType, eligibilityType: o.eligibilityType, discountPercent: o.discountPercent == null ? '' : String(Number(o.discountPercent)), discountAmount: o.discountAmount == null ? '' : String(Number(o.discountAmount)), maxBenefitAmount: o.maxBenefitAmount == null ? '' : String(Number(o.maxBenefitAmount)), minTripAmount: o.minTripAmount == null ? '' : String(Number(o.minTripAmount)), redemptionLimit: o.redemptionLimit == null ? '' : String(o.redemptionLimit), perCustomerLimit: o.perCustomerLimit == null ? '' : String(o.perCustomerLimit), accountOpeningUrl: o.accountOpeningUrl ?? '', displayPriority: String(o.displayPriority), requiresBankApproval: o.requiresBankApproval });
const n = (s: string) => (s.trim() === '' ? null : Number(s));
const toInput = (f: OfferForm): OfferInput => ({ title: f.title.trim(), shortDescription: f.shortDescription.trim() || null, termsAndConditions: f.termsAndConditions.trim(), offerType: f.offerType, eligibilityType: f.eligibilityType, discountPercent: n(f.discountPercent), discountAmount: n(f.discountAmount), maxBenefitAmount: n(f.maxBenefitAmount), minTripAmount: n(f.minTripAmount), redemptionLimit: n(f.redemptionLimit), perCustomerLimit: n(f.perCustomerLimit), accountOpeningUrl: f.accountOpeningUrl.trim() || null, displayPriority: Number(f.displayPriority) || 0, requiresBankApproval: f.requiresBankApproval });

const REAPPROVE_OFFER_FIELDS = ['title', 'shortDescription', 'termsAndConditions', 'offerType', 'discountPercent', 'discountAmount', 'maxBenefitAmount', 'accountOpeningUrl'];
/** Only the keys whose value differs — so an unchanged field never triggers re-approval on the server. */
const diff = <T extends Record<string, unknown>>(before: T, after: T): Partial<T> => {
  const out: Partial<T> = {};
  for (const k of Object.keys(after) as (keyof T)[]) if (before[k] !== after[k]) out[k] = after[k];
  return out;
};

const offerValue = (o: BankOffer, cur: string) => {
  if (o.discountPercent != null) return `${Number(o.discountPercent)}% off${o.maxBenefitAmount != null ? `, up to ${money(o.maxBenefitAmount, cur)}` : ''}`;
  if (o.discountAmount != null) return `${money(o.discountAmount, cur)} off`;
  return o.offerType === 'ACCOUNT_OPENING' ? 'Account-opening link' : '—';
};

const CampaignDetails: React.FC = () => {
  const { id = '' } = useParams(); const { can } = useAuth(); const canWrite = can.managePartnerships;
  const [c, setC] = useState<BankCampaign | null>(null); const [problems, setProblems] = useState<string[]>([]); const [report, setReport] = useState<CampaignReport | null>(null); const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<'reject' | 'pause' | 'cancel' | null>(null);
  const [approve, setApprove] = useState(false); const [confirmed, setConfirmed] = useState(false); const [aNote, setANote] = useState('');
  const [offerEdit, setOfferEdit] = useState<BankOffer | 'new' | null>(null); const [of, setOf] = useState<OfferForm>(blankOffer);
  const [editC, setEditC] = useState(false); const [cf, setCf] = useState({ name: '', description: '', startsAt: '', endsAt: '', budgetAmount: '', landingPageUrl: '', attributionWindowDays: '30' });

  const load = useCallback(() => {
    Promise.all([bankAdminAPI.campaign(id), bankAdminAPI.report(id).catch(() => null)])
      .then(([d, r]) => { setC(d.campaign); setProblems(d.problems); setReport(r); }).catch((e) => toast.error(apiError(e))).finally(() => setLoading(false));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="py-24 flex justify-center"><Spinner /></div>;
  if (!c) return <EmptyRow text="Campaign not found." />;
  const cur = c.currency; const offers = c.offers ?? []; const draft = c.status === 'DRAFT'; const closed = ['COMPLETED', 'EXPIRED', 'CANCELLED'].includes(c.status);
  const reapprovalWarning = 'This campaign is not a draft. Changing customer-facing wording, value or dates will UNPUBLISH it and send it back for approval. Continue?';

  const act = async (action: CampaignAction, body: { confirmWrittenApproval?: boolean; note?: string; reason?: string } = {}) => {
    setBusy(true);
    try { await bankAdminAPI.act(c.id, action, body); toast.success({ submit: 'Submitted for approval', approve: 'Campaign approved', reject: 'Returned to draft', pause: 'Campaign paused', resume: 'Campaign resumed', cancel: 'Campaign cancelled' }[action]); setAsk(null); setApprove(false); setConfirmed(false); setANote(''); load(); }
    catch (e) { toast.error(apiError(e)); } finally { setBusy(false); }
  };

  const openOffer = (o: BankOffer | 'new') => { setOfferEdit(o); setOf(o === 'new' ? blankOffer : fromOffer(o)); };
  const saveOffer = async () => {
    setBusy(true);
    try {
      if (offerEdit === 'new') await bankAdminAPI.addOffer(c.id, toInput(of));
      else if (offerEdit) {
        const patch = diff(toInput(fromOffer(offerEdit)) as Record<string, unknown>, toInput(of) as Record<string, unknown>) as OfferInput;
        if (!Object.keys(patch).length) { toast('Nothing changed'); setOfferEdit(null); return; }
        if (!draft && Object.keys(patch).some((k) => REAPPROVE_OFFER_FIELDS.includes(k)) && !window.confirm(reapprovalWarning)) return;
        const r = await bankAdminAPI.updateOffer(offerEdit.id, patch);
        if (r.campaignReturnedToDraft) toast('Campaign returned to draft — re-submit for approval', { icon: 'ℹ️' });
      }
      toast.success('Offer saved'); setOfferEdit(null); load();
    } catch (e) { toast.error(apiError(e)); } finally { setBusy(false); }
  };
  const removeOffer = async (o: BankOffer) => {
    if (!window.confirm(`Delete offer “${o.title}”?`)) return;
    try { await bankAdminAPI.deleteOffer(o.id); toast.success('Offer deleted'); load(); } catch (e) { toast.error(apiError(e)); }
  };

  const formOf = (x: BankCampaign) => ({ name: x.name, description: x.description ?? '', startsAt: toLocalInput(x.startsAt), endsAt: toLocalInput(x.endsAt), budgetAmount: x.budgetAmount == null ? '' : String(Number(x.budgetAmount)), landingPageUrl: x.landingPageUrl ?? '', attributionWindowDays: String(x.attributionWindowDays) });
  const campaignPayload = (f: typeof cf) => ({ name: f.name.trim(), description: f.description.trim(), startsAt: f.startsAt ? new Date(f.startsAt).toISOString() : null, endsAt: f.endsAt ? new Date(f.endsAt).toISOString() : null, budgetAmount: n(f.budgetAmount), landingPageUrl: f.landingPageUrl.trim() || null, attributionWindowDays: Number(f.attributionWindowDays) || 30 });
  const openEditC = () => { setCf(formOf(c)); setEditC(true); };
  const saveC = async () => {
    const patch = diff(campaignPayload(formOf(c)) as Record<string, unknown>, campaignPayload(cf) as Record<string, unknown>);
    if (!Object.keys(patch).length) { toast('Nothing changed'); setEditC(false); return; }
    if (!draft && !window.confirm(reapprovalWarning)) return;
    setBusy(true);
    try {
      const r = await bankAdminAPI.updateCampaign(c.id, patch);
      toast.success(r.returnedToDraft ? 'Saved — campaign returned to draft for re-approval' : 'Campaign saved'); setEditC(false); load();
    } catch (e) { toast.error(apiError(e)); } finally { setBusy(false); }
  };
  const so = (k: keyof OfferForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setOf({ ...of, [k]: e.target.value });
  const t = report?.totals;

  return (
    <div className="space-y-5">
      <Link to="/banks/campaigns" className="text-sm text-gray-500 hover:text-gray-800">← All campaigns</Link>
      <PageHeader icon={Megaphone} color="bg-fuchsia-100 text-fuchsia-600" title={c.name} subtitle={`${c.bankPartner?.displayName ?? ''} · ${c.campaignCode} · ${fmtDate(c.startsAt)} → ${fmtDate(c.endsAt)}`} actions={<StatusBadge status={c.status} />} />

      {canWrite && !closed && (
        <div className="flex flex-wrap items-center gap-2">
          {draft && <Button loading={busy} disabled={problems.length > 0 || offers.length === 0} onClick={() => act('submit')}>Submit for approval</Button>}
          {c.status === 'PENDING_APPROVAL' && <><Button variant="success" onClick={() => setApprove(true)}>Approve…</Button><Button variant="outline" onClick={() => setAsk('reject')}>Send back</Button></>}
          {['ACTIVE', 'SCHEDULED'].includes(c.status) && <Button variant="outline" onClick={() => setAsk('pause')}>Pause</Button>}
          {c.status === 'PAUSED' && <Button variant="success" loading={busy} onClick={() => act('resume')}>Resume</Button>}
          <Button variant="outline" onClick={openEditC}>Edit campaign</Button>
          <Button variant="danger" onClick={() => setAsk('cancel')}>Cancel campaign</Button>
        </div>)}

      {draft && problems.length > 0 && <Alert variant="warning" title="Not ready to submit"><ul className="list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul></Alert>}
      {c.status === 'PENDING_APPROVAL' && <Alert variant="info">Approval needs a <b>different admin</b> from the creator, an Active bank with a recorded agreement, and confirmation that the bank approved the creative, copy, links and terms <b>in writing</b>.</Alert>}
      {['ACTIVE', 'SCHEDULED', 'PAUSED'].includes(c.status) && <Alert variant="info">Live campaign. Editing customer-facing wording, value or dates returns it to draft and hides it until re-approved.</Alert>}

      <InfoCard title="Performance">
        {!t ? <EmptyRow text="Report unavailable." /> : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 text-center">
              {([['Impressions', t.impressions], ['Offer views', t.views], ['Clicks out', t.clicks], ['Applications started', t.applicationsStarted], ['Submitted to bank', t.submitted], ['Verified by bank', t.verifiedConversions], ['Redemptions', t.redemptions]] as [string, number][]).map(([l, v], i) => (
                <div key={l} className={`rounded-lg p-3 ${i === 5 ? 'bg-emerald-50 border border-emerald-200' : 'bg-gray-50'}`}><p className="text-xs text-gray-500">{l}</p><p className="text-xl font-bold">{v.toLocaleString()}</p></div>))}
            </div>
            <p className="text-xs text-gray-500 mt-3">{report!.funnelNote} Declined by bank: {t.declined}.</p>
            {report!.budget.amount !== null && (
              <div className="mt-4"><div className="flex justify-between text-xs text-gray-500 mb-1"><span>Budget used</span><span>{money(report!.budget.spent, cur)} of {money(report!.budget.amount, cur)} · {money(report!.budget.remaining, cur)} left</span></div>
                <div className="h-2 rounded-full bg-gray-100 overflow-hidden"><div className="h-full bg-blue-500" style={{ width: `${Math.min(100, report!.budget.amount ? (report!.budget.spent / report!.budget.amount) * 100 : 0)}%` }} /></div></div>)}
          </>)}
      </InfoCard>

      <InfoCard title={`Offers (${offers.length})`}>
        {canWrite && draft && <div className="mb-3"><Button size="sm" onClick={() => openOffer('new')}><Plus className="h-4 w-4" />Add offer</Button></div>}
        {offers.length === 0 ? <EmptyRow text="No offers yet. A campaign needs at least one before it can be submitted." /> : (
          <ul className="divide-y divide-gray-100">{offers.map((o) => (
            <li key={o.id} className="py-3 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0"><p className="font-medium text-gray-900">{o.title} <span className="ml-1 text-xs font-normal text-gray-400">{label(o.offerType)} · {label(o.eligibilityType)}</span></p>
                <p className="text-sm text-gray-600">{offerValue(o, cur)}{o.minTripAmount != null ? ` · min trip ${money(o.minTripAmount, cur)}` : ''}{o.redemptionLimit ? ` · ${o.redemptionLimit} redemptions max` : ''}{o.perCustomerLimit ? ` · ${o.perCustomerLimit} per customer` : ''}</p>
                {isCredit(o.offerType) && <p className="text-xs text-amber-600 mt-0.5">Credit / deferred-payment offer — hidden from customers unless credit offers are enabled after legal sign-off.</p>}
                <p className="text-xs text-gray-400 mt-0.5">{o.isPublished ? 'Published to customers' : 'Not published'}</p></div>
              {canWrite && !closed && <div className="flex gap-1.5"><Button size="sm" variant="outline" onClick={() => openOffer(o)}>Edit</Button>{draft && <Button size="sm" variant="outline" onClick={() => removeOffer(o)}>Delete</Button>}</div>}
            </li>))}</ul>)}
      </InfoCard>

      <PromptModal open={ask === 'reject'} title="Send back to draft" fieldLabel="What needs to change?" required confirmLabel="Send back" onClose={() => setAsk(null)} onSubmit={(note) => act('reject', { note })} />
      <PromptModal open={ask === 'pause'} title="Pause campaign" fieldLabel="Reason" confirmLabel="Pause" danger onClose={() => setAsk(null)} onSubmit={(reason) => act('pause', { reason })} description="Customers stop seeing its offers immediately." />
      <PromptModal open={ask === 'cancel'} title="Cancel campaign" fieldLabel="Reason" required confirmLabel="Cancel campaign" danger onClose={() => setAsk(null)} onSubmit={(reason) => act('cancel', { reason })} description="This cannot be undone. Offers are unpublished." />

      <Modal isOpen={approve} onClose={() => setApprove(false)} title="Approve campaign" size="md"
        footer={<><Button variant="outline" onClick={() => setApprove(false)}>Cancel</Button><Button variant="success" loading={busy} disabled={!confirmed} onClick={() => act('approve', { confirmWrittenApproval: true, note: aNote || undefined })}>Approve & publish</Button></>}>
        <div className="space-y-3 text-sm">
          <p>Approving publishes {offers.length} offer(s) to customers {new Date(c.startsAt ?? 0) <= new Date() ? 'now' : `from ${fmtDate(c.startsAt)}`}.</p>
          <label className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200"><input type="checkbox" className="mt-1" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /><span>I confirm that <b>{c.bankPartner?.displayName}</b> has approved the creative, copy, links and terms of this campaign <b>in writing</b>.</span></label>
          <Field label="Reference to the written approval (optional)"><input className={fieldCls} value={aNote} onChange={(e) => setANote(e.target.value)} placeholder="e.g. email from bank, 12 Nov" /></Field>
        </div>
      </Modal>

      <Modal isOpen={!!offerEdit} onClose={() => setOfferEdit(null)} size="xl" title={offerEdit === 'new' ? 'Add offer' : 'Edit offer'}
        footer={<><Button variant="outline" onClick={() => setOfferEdit(null)}>Cancel</Button><Button loading={busy} disabled={!of.title.trim() || !of.termsAndConditions.trim()} onClick={saveOffer}>Save offer</Button></>}>
        <div className="space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Title (customer-facing)"><input className={fieldCls} maxLength={200} value={of.title} onChange={so('title')} /></Field>
            <Field label="Offer type"><select className={fieldCls} value={of.offerType} onChange={so('offerType')}>{OFFER_TYPES.map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></Field>
          </div>
          {isCredit(of.offerType) && <Alert variant="warning">Credit and deferred-payment offers are bank-led and hidden from customers until credit offers are switched on after legal review. Never describe them as guaranteed approval.</Alert>}
          <Field label="Short description"><input className={fieldCls} value={of.shortDescription} onChange={so('shortDescription')} /></Field>
          <Field label="Terms and conditions (bank-approved wording)"><textarea className={fieldCls} rows={4} value={of.termsAndConditions} onChange={so('termsAndConditions')} /></Field>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Who can use it"><select className={fieldCls} value={of.eligibilityType} onChange={so('eligibilityType')}>{ELIGIBILITY.map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></Field>
            <Field label="Display priority" hint="Higher shows first."><input type="number" className={fieldCls} value={of.displayPriority} onChange={so('displayPriority')} /></Field>
          </div>
          {of.offerType === 'ACCOUNT_OPENING'
            ? <Field label="Bank-approved account-opening link (https)"><input className={fieldCls} value={of.accountOpeningUrl} onChange={so('accountOpeningUrl')} placeholder="https://…" /></Field>
            : <div className="grid sm:grid-cols-4 gap-3">
                <Field label="Discount %"><input type="number" min={0} max={100} step="0.01" className={fieldCls} value={of.discountPercent} onChange={so('discountPercent')} /></Field>
                <Field label="or fixed amount"><input type="number" min={0} step="0.01" className={fieldCls} value={of.discountAmount} onChange={so('discountAmount')} /></Field>
                <Field label="Max benefit"><input type="number" min={0} step="0.01" className={fieldCls} value={of.maxBenefitAmount} onChange={so('maxBenefitAmount')} /></Field>
                <Field label="Min trip amount"><input type="number" min={0} step="0.01" className={fieldCls} value={of.minTripAmount} onChange={so('minTripAmount')} /></Field>
              </div>}
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Total redemption limit" hint="Blank = no limit"><input type="number" min={1} className={fieldCls} value={of.redemptionLimit} onChange={so('redemptionLimit')} /></Field>
            <Field label="Limit per customer" hint="Blank = no limit"><input type="number" min={1} className={fieldCls} value={of.perCustomerLimit} onChange={so('perCustomerLimit')} /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={of.requiresBankApproval} onChange={(e) => setOf({ ...of, requiresBankApproval: e.target.checked })} />Bank must confirm eligibility before the benefit applies</label>
        </div>
      </Modal>

      <Modal isOpen={editC} onClose={() => setEditC(false)} size="lg" title="Edit campaign"
        footer={<><Button variant="outline" onClick={() => setEditC(false)}>Cancel</Button><Button loading={busy} disabled={!cf.name.trim()} onClick={saveC}>Save</Button></>}>
        <div className="space-y-3">
          {!draft && <Alert variant="warning">Saving changes to a live or approved campaign sends it back to draft and hides it until it is approved again.</Alert>}
          <Field label="Name"><input className={fieldCls} value={cf.name} onChange={(e) => setCf({ ...cf, name: e.target.value })} /></Field>
          <Field label="Description"><textarea className={fieldCls} rows={2} value={cf.description} onChange={(e) => setCf({ ...cf, description: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="Starts"><input type="datetime-local" className={fieldCls} value={cf.startsAt} onChange={(e) => setCf({ ...cf, startsAt: e.target.value })} /></Field><Field label="Ends"><input type="datetime-local" className={fieldCls} value={cf.endsAt} onChange={(e) => setCf({ ...cf, endsAt: e.target.value })} /></Field></div>
          <div className="grid grid-cols-2 gap-3"><Field label="Budget cap"><input type="number" min={0} className={fieldCls} value={cf.budgetAmount} onChange={(e) => setCf({ ...cf, budgetAmount: e.target.value })} /></Field><Field label="Attribution window (days)"><input type="number" min={1} max={365} className={fieldCls} value={cf.attributionWindowDays} onChange={(e) => setCf({ ...cf, attributionWindowDays: e.target.value })} /></Field></div>
          <Field label="Landing page (https)"><input className={fieldCls} value={cf.landingPageUrl} onChange={(e) => setCf({ ...cf, landingPageUrl: e.target.value })} /></Field>
        </div>
      </Modal>
    </div>
  );
};
export default CampaignDetails;
