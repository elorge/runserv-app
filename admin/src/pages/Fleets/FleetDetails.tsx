// Runserv staff: one fleet organisation — verification, status, commercial terms, documents, vehicles, team.
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Building, ExternalLink } from 'lucide-react';
import { Alert, Button, Spinner } from '@/components/common';
import { fleetAdminAPI, apiError } from '@/services/api/partnerships';
import { useAuth } from '@/hooks/useAuth';
import type { FleetDetail, FleetStatus, VerificationStatus } from '@/types/partnerships';
import { PageHeader, StatusBadge, InfoCard, Field, fieldCls, Th, EmptyRow, fmtDate, pct, label, PromptModal, ComplianceChips, VehicleActions } from '@/components/features/partnerships';
import { SecureDocLink } from '@/components/common/SecureDocLink';

const STATUS_ACTIONS: { to: FleetStatus; text: string; from: FleetStatus[]; danger?: boolean; reason?: boolean }[] = [
  { to: 'UNDER_REVIEW', text: 'Start review', from: ['PENDING'] },
  { to: 'ACTIVE', text: 'Activate', from: ['PENDING', 'UNDER_REVIEW', 'SUSPENDED', 'DEACTIVATED'] },
  { to: 'SUSPENDED', text: 'Suspend', from: ['ACTIVE'], danger: true, reason: true },
  { to: 'REJECTED', text: 'Reject', from: ['PENDING', 'UNDER_REVIEW'], danger: true, reason: true },
  { to: 'DEACTIVATED', text: 'Deactivate', from: ['ACTIVE', 'SUSPENDED'], danger: true, reason: true },
];

const FleetDetails: React.FC = () => {
  const { id = '' } = useParams();
  const { can } = useAuth(); const canWrite = can.managePartnerships;
  const [data, setData] = useState<FleetDetail | null>(null); const [loading, setLoading] = useState(true);
  const [ask, setAsk] = useState<FleetStatus | null>(null);
  const [rejectDoc, setRejectDoc] = useState<string | null>(null);
  const [verif, setVerif] = useState<VerificationStatus>('UNVERIFIED'); const [vNotes, setVNotes] = useState('');
  const [rate, setRate] = useState(''); const [days, setDays] = useState(''); const [tNote, setTNote] = useState(''); const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fleetAdminAPI.get(id).then((d) => {
      setData(d); setVerif(d.fleet.verificationStatus); setVNotes(d.fleet.verificationNotes ?? '');
      setRate(String(+(Number(d.fleet.commissionRate) * 100).toFixed(2))); setDays(String(d.fleet.settlementTermsDays));
    }).catch((e) => toast.error(apiError(e))).finally(() => setLoading(false));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="py-24 flex justify-center"><Spinner /></div>;
  if (!data) return <EmptyRow text="Fleet partner not found." />;
  const { fleet, vehicles } = data;

  const guard = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); try { await fn(); toast.success(ok); load(); } catch (e) { toast.error(apiError(e)); } finally { setBusy(false); } };
  const setStatus = (to: FleetStatus, reason?: string) => guard(async () => { await fleetAdminAPI.setStatus(fleet.id, to, reason); setAsk(null); }, `Fleet is now ${label(to).toLowerCase()}`);
  const saveTerms = () => {
    const r = Number(rate) / 100; const dd = Number(days);
    if (!(r >= 0 && r <= 0.6)) return toast.error('Fee must be between 0% and 60%.');
    if (!Number.isInteger(dd) || dd < 0 || dd > 90) return toast.error('Settlement terms must be 0–90 days.');
    return guard(() => fleetAdminAPI.setTerms(fleet.id, { commissionRate: r, settlementTermsDays: dd, note: tNote || undefined }), 'Commercial terms saved and logged');
  };

  return (
    <div className="space-y-5">
      <Link to="/fleets" className="text-sm text-gray-500 hover:text-gray-800">← All fleets</Link>
      <PageHeader icon={Building} title={fleet.tradingName || fleet.legalName} subtitle={`${fleet.legalName}${fleet.rcNumber ? ` · RC ${fleet.rcNumber}` : ''} · ${fleet.email} · ${fleet.phone}`}
        actions={<><StatusBadge status={fleet.verificationStatus} /><StatusBadge status={fleet.status} /></>} />

      {fleet.status !== 'ACTIVE' && <Alert variant="info">Drivers linked to this fleet cannot take jobs until the fleet is <b>verified</b> and <b>active</b>. Suspending a fleet takes effect immediately.</Alert>}

      {canWrite && (
        <div className="grid lg:grid-cols-3 gap-4">
          <InfoCard title="1. Verification">
            <div className="space-y-3">
              <Field label="Organisation check"><select className={`${fieldCls}`} value={verif} onChange={(e) => setVerif(e.target.value as VerificationStatus)}>{['UNVERIFIED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
              <Field label="Notes (CAC / RC check, owner ID, etc.)"><textarea className={fieldCls} rows={2} value={vNotes} onChange={(e) => setVNotes(e.target.value)} /></Field>
              <Button size="sm" loading={busy} onClick={() => guard(() => fleetAdminAPI.setVerification(fleet.id, verif, vNotes), 'Verification saved')}>Save verification</Button>
              {fleet.verifiedAt && <p className="text-xs text-gray-400">Verified {fmtDate(fleet.verifiedAt)}</p>}
            </div>
          </InfoCard>
          <InfoCard title="2. Account status">
            <div className="flex flex-wrap gap-2">
              {STATUS_ACTIONS.filter((a) => a.from.includes(fleet.status)).map((a) => (
                <Button key={a.to} size="sm" variant={a.danger ? 'outline' : 'success'} disabled={a.to === 'ACTIVE' && fleet.verificationStatus !== 'VERIFIED'}
                  title={a.to === 'ACTIVE' && fleet.verificationStatus !== 'VERIFIED' ? 'Verify the organisation first' : undefined}
                  onClick={() => (a.reason ? setAsk(a.to) : setStatus(a.to))}>{a.text}</Button>))}
              {STATUS_ACTIONS.every((a) => !a.from.includes(fleet.status)) && <p className="text-sm text-gray-400">No actions available.</p>}
            </div>
            {fleet.verificationStatus !== 'VERIFIED' && <p className="text-xs text-amber-600 mt-3">Activation is blocked until verification is “Verified”.</p>}
          </InfoCard>
          <InfoCard title="3. Commercial terms">
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Platform fee (%)" hint="Hypothesis until agreed"><input className={fieldCls} type="number" min={0} max={60} step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
                <Field label="Payout terms (days)"><input className={fieldCls} type="number" min={0} max={90} value={days} onChange={(e) => setDays(e.target.value)} /></Field>
              </div>
              <Field label="Agreement reference / note"><input className={fieldCls} value={tNote} onChange={(e) => setTNote(e.target.value)} placeholder="e.g. signed agreement FP-2026-004" /></Field>
              <Button size="sm" loading={busy} onClick={saveTerms}>Save terms</Button>
              <p className="text-xs text-gray-400">Applies to trips completed from now on. Every change is audit-logged. Current: {pct(fleet.commissionRate)}.</p>
            </div>
          </InfoCard>
        </div>)}

      <InfoCard title={`Vehicles (${vehicles.length})`}>
        {vehicles.length === 0 ? <EmptyRow text="No vehicles registered." /> : (
          <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-gray-100"><Th>Vehicle</Th><Th>Compliance</Th><Th>Status</Th><Th right>{canWrite ? 'Actions' : ''}</Th></tr></thead>
            <tbody className="divide-y divide-gray-50">{vehicles.map((v) => (
              <tr key={v.id} className="align-top">
                <td className="py-3 pr-4"><p className="font-medium font-mono">{v.registrationNumber}</p><p className="text-xs text-gray-400">{label(v.vehicleType)} · {v.make} {v.model}{v.modelYear ? ` (${v.modelYear})` : ''}</p></td>
                <td className="py-3 pr-4"><ComplianceChips c={v.compliance} />{v.compliance.blockers.length > 0 && <p className="text-xs text-red-600 mt-1">{v.compliance.blockers.join('; ')}</p>}</td>
                <td className="py-3 pr-4"><StatusBadge status={v.status} /></td>
                <td className="py-3"><VehicleActions vehicle={v} canWrite={canWrite} onChanged={load} /></td></tr>))}</tbody></table></div>)}
      </InfoCard>

      <InfoCard title={`Documents (${fleet.documents.length})`}>
        {fleet.documents.length === 0 ? <EmptyRow text="No documents uploaded." /> : (
          <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-gray-100"><Th>Type</Th><Th>Applies to</Th><Th>Number</Th><Th>Expires</Th><Th>Review</Th><Th right>{canWrite ? 'Actions' : ''}</Th></tr></thead>
            <tbody className="divide-y divide-gray-50">{fleet.documents.map((d) => {
              const veh = vehicles.find((v) => v.id === d.vehicleId);
              return (
                <tr key={d.id}>
                  <td className="py-3 pr-4 font-medium">{label(d.documentType)}</td>
                  <td className="py-3 pr-4 text-gray-600">{veh ? veh.registrationNumber : 'Organisation'}</td>
                  <td className="py-3 pr-4 text-gray-600">{d.documentNumber || '—'}</td>
                  <td className="py-3 pr-4 text-gray-600">{fmtDate(d.expiresAt)}</td>
                  <td className="py-3 pr-4">{d.isApproved ? <StatusBadge status="APPROVED" /> : d.rejectionNote ? <span title={d.rejectionNote}><StatusBadge status="REJECTED" /></span> : <StatusBadge status="PENDING" />}</td>
                  <td className="py-3"><div className="flex justify-end gap-1.5">
                    <SecureDocLink access={{ source: 'FLEET_DOCUMENT', id: d.id, field: 'fileUrl' }} className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline px-2 py-1.5"><ExternalLink className="h-3 w-3" />Open</SecureDocLink>
                    {canWrite && !d.isApproved && <Button size="sm" variant="success" onClick={() => guard(() => fleetAdminAPI.reviewDocument(d.id, true), 'Document approved')}>Approve</Button>}
                    {canWrite && !d.rejectionNote && !d.isApproved && <Button size="sm" variant="outline" onClick={() => setRejectDoc(d.id)}>Reject</Button>}
                  </div></td></tr>); })}</tbody></table></div>)}
      </InfoCard>

      <InfoCard title={`Team (${fleet.members.length})`}>
        {fleet.members.length === 0 ? <EmptyRow text="No team members." /> : (
          <ul className="divide-y divide-gray-50 text-sm">{fleet.members.map((m) => (
            <li key={m.id} className="py-2 flex items-center justify-between"><span><span className="font-medium">{m.user.firstName} {m.user.lastName}</span> <span className="text-gray-400">· {m.user.email}</span></span><span className="text-xs text-gray-500">{label(m.role)}{m.isActive === false ? ' · inactive' : ''}</span></li>))}</ul>)}
      </InfoCard>

      <PromptModal open={!!ask} title={`${ask ? label(ask) : ''} this fleet`} fieldLabel="Reason (kept in the audit log)" required confirmLabel="Confirm" danger onClose={() => setAsk(null)} onSubmit={(t) => setStatus(ask as FleetStatus, t)}
        description="Drivers linked to this fleet will no longer be dispatchable while the fleet is not active." />
      <PromptModal open={!!rejectDoc} title="Reject document" fieldLabel="Why is it rejected? (shown to the fleet)" required confirmLabel="Reject" danger onClose={() => setRejectDoc(null)}
        onSubmit={async (t) => { await guard(() => fleetAdminAPI.reviewDocument(rejectDoc as string, false, t), 'Document rejected'); setRejectDoc(null); }} />
    </div>
  );
};
export default FleetDetails;
