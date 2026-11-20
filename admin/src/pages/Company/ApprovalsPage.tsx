// Trip approvals (over the threshold) and weekend-ride requests, decided by managers / HR / admins.
import React, { useEffect, useState, useCallback } from 'react';
import { Check, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { Card, Button, Badge, Spinner } from '@/components/common';
import { companyAPI, errMsg } from '@/services/api/company';
import { formatMoney } from '@/utils/money';
import type { WeekendRequest, ApprovalItem } from '@/types/company';
import { PageHeader, Empty, fmtDT } from './ui';

const fmt = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
type Kind = 'trips' | 'weekend'; type St = 'PENDING' | 'APPROVED' | 'REJECTED';

const ApprovalsPage: React.FC = () => {
  const [kind, setKind] = useState<Kind>('trips'); const [status, setStatus] = useState<St>('PENDING');
  const [trips, setTrips] = useState<ApprovalItem[]>([]); const [wk, setWk] = useState<WeekendRequest[]>([]);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    (kind === 'trips' ? companyAPI.approvals(status).then(setTrips) : companyAPI.weekendRequests(status).then(setWk)).catch((e) => toast.error(errMsg(e))).finally(() => setLoading(false));
  }, [kind, status]);
  useEffect(() => { load(); }, [load]);

  const decide = async (id: string, approve: boolean) => {
    const note = approve ? undefined : (window.prompt('Reason for declining (optional)') ?? undefined);
    setBusy(id);
    try { await (kind === 'trips' ? companyAPI.decideApproval(id, approve, note) : companyAPI.reviewWeekend(id, approve, note)); toast.success(approve ? 'Approved' : 'Declined'); load(); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(null); }
  };
  const Actions = ({ id }: { id: string }) => status === 'PENDING' ? (
    <div className="flex gap-2"><Button size="sm" variant="success" loading={busy === id} onClick={() => decide(id, true)}><Check className="h-3.5 w-3.5 inline mr-1" />Approve</Button>
      <Button size="sm" variant="outline" disabled={busy === id} onClick={() => decide(id, false)}><X className="h-3.5 w-3.5 inline mr-1" />Decline</Button></div>) : null;

  return (
    <div>
      <PageHeader title="Approvals" subtitle="Trips above the approval limit, and Saturday/Sunday rides, wait here for a manager, HR or admin." />
      <div className="flex gap-1 mb-2 border-b border-gray-200">{([['trips', 'Trip approvals'], ['weekend', 'Weekend rides']] as const).map(([k, l]) => (
        <button key={k} onClick={() => setKind(k)} className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${kind === k ? 'border-primary-600 text-primary-700' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>{l}</button>))}</div>
      <div className="flex gap-2 mb-4">{(['PENDING', 'APPROVED', 'REJECTED'] as St[]).map((s) => (
        <button key={s} onClick={() => setStatus(s)} className={`text-xs px-3 py-1 rounded-full border ${status === s ? 'bg-primary-600 text-white border-primary-600' : 'border-gray-300 text-gray-600'}`}>{s === 'PENDING' ? 'Waiting' : s === 'APPROVED' ? 'Approved' : 'Declined'}</button>))}</div>
      <Card padding={false}>
        {loading ? <div className="py-16 flex justify-center"><Spinner /></div> : kind === 'trips' ? (trips.length === 0 ? <Empty>Nothing here.</Empty> : (
          <ul className="divide-y divide-gray-100">{trips.map((a) => (
            <li key={a.id} className="p-4 flex flex-wrap items-start gap-3">
              <div className="flex-1 min-w-[240px]">
                <p className="font-semibold text-gray-900">{a.employee.name} <span className="font-normal text-gray-400">· {a.employee.staffNumber} · {a.employee.department} {a.employee.costCenter && <span className="font-mono">({a.employee.costCenter})</span>}</span></p>
                <p className="text-sm text-gray-700 mt-1">{a.pickup} → {a.dropoff}</p>
                <p className="text-sm mt-0.5"><b className="tabular-nums">{formatMoney(a.fare, 'NGN')}</b>{a.distanceKm ? ` · ${a.distanceKm.toFixed(1)} km` : ''} · {a.serviceType.toLowerCase()}</p>
                {a.purpose && <p className="text-xs text-gray-500 mt-1">Purpose: {a.purpose}</p>}
                <p className="text-xs text-gray-400 mt-1">Requested {fmtDT(a.createdAt)}</p>
                {a.decisionNote && <p className="text-xs text-gray-400">Note: {a.decisionNote}</p>}
              </div>
              {status === 'PENDING' ? <Actions id={a.id} /> : <Badge variant={a.status === 'APPROVED' || a.status === 'USED' ? 'success' : 'default'}>{a.status === 'USED' ? 'Approved · used' : a.status}</Badge>}
            </li>))}</ul>)
        ) : (wk.length === 0 ? <Empty>Nothing here.</Empty> : (
          <ul className="divide-y divide-gray-100">{wk.map((r) => (
            <li key={r.id} className="p-4 flex flex-wrap items-start gap-3">
              <div className="flex-1 min-w-[220px]"><p className="font-semibold text-gray-900">{r.employee.name} <span className="font-normal text-gray-400">· {r.employee.staffNumber} · {r.employee.department}</span></p>
                <p className="text-sm text-primary-700 font-medium mt-0.5">{fmt(r.date)}</p><p className="text-sm text-gray-600 mt-1">“{r.reason}”</p></div>
              {status === 'PENDING' ? <Actions id={r.id} /> : <Badge variant={r.status === 'APPROVED' ? 'success' : 'default'}>{r.status}</Badge>}
            </li>))}</ul>))}
      </Card>
    </div>
  );
};
export default ApprovalsPage;
