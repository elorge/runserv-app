import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Spinner, Alert, Select, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/common';
import { guestBookingsAPI } from '@/services/api/guestBookings';
import type { PilotMetrics, ChannelMetrics } from '@/types/guestBooking';
import { fmtDate, apiMessage } from './shared';

const pct = (n: number | null) => (n === null || n === undefined ? '—' : `${n}%`);
const secs = (n: number | null) => (n === null || n === undefined ? '—' : n >= 120 ? `${Math.round(n / 60)} min` : `${n} s`);
const Stat: React.FC<{ label: string; value: React.ReactNode; hint?: string }> = ({ label, value, hint }) => <div className="rounded border border-gray-200 p-3"><p className="text-xs text-gray-500">{label}</p><p className="text-2xl font-bold">{value}</p>{hint ? <p className="text-xs text-gray-500">{hint}</p> : null}</div>;

const Channel: React.FC<{ m: ChannelMetrics; title: string }> = ({ m, title }) => (
  <Card><h2 className="mb-3 font-semibold">{title}</h2>
    <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
      <Stat label="Notifications" value={m.total} hint={`${m.queued} waiting`} /><Stat label="Accepted by provider" value={m.accepted} hint={`${pct(m.acceptedRatePct)} of resolved`} />
      <Stat label="Failed permanently" value={m.deadLettered} hint={`${pct(m.deadLetterRatePct)} of resolved`} /><Stat label="Needed retries" value={m.retried} />
      <Stat label="Median time to acceptance" value={secs(m.medianSecondsToAcceptance)} />
      {m.channel === 'email' ? <><Stat label="With a delivery report" value={pct(m.deliveryReceiptRatePct)} /><Stat label="Reported delivered" value={pct(m.deliveredPct)} /></> : null}
      <Stat label="Skipped" value={m.skipped} />
    </div>
    {Object.keys(m.byProvider).length ? (
      <div className="mt-3"><Table><TableHeader><TableRow><TableHead>Provider</TableHead><TableHead>Total</TableHead><TableHead>Accepted</TableHead><TableHead>Failed</TableHead></TableRow></TableHeader>
        <TableBody>{Object.entries(m.byProvider).map(([k, v]) => <TableRow key={k}><TableCell className="capitalize">{k}</TableCell><TableCell>{v.total}</TableCell><TableCell>{v.accepted}</TableCell><TableCell>{v.deadLettered}</TableCell></TableRow>)}</TableBody></Table></div>
    ) : null}
  </Card>
);

/** Pilot metrics from the outbox and audit tables. Aggregates only: no addresses, codes or message text. "Accepted" is not "delivered". */
const GuestMetrics: React.FC = () => {
  const [hours, setHours] = useState('168');
  const [m, setM] = useState<PilotMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setM(await guestBookingsAPI.pilotMetrics(Number(hours))); } catch (e) { setM(null); setError(apiMessage(e, 'Could not load the metrics.')); } finally { setLoading(false); }
  }, [hours]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4 p-6">
      <div><Link to="/guest-bookings" className="text-sm text-primary-600">← Guest bookings</Link><h1 className="text-2xl font-bold text-gray-900">Pilot metrics</h1>
        <p className="text-sm text-gray-500">Recipient notifications and hand-over codes{m ? ` since ${fmtDate(m.since)}` : ''}.</p></div>
      <Card><div className="max-w-xs"><Select label="Period" value={hours} onChange={(e: any) => setHours(String(e.target?.value ?? e))}
        options={[{ value: '24', label: 'Last 24 hours' }, { value: '168', label: 'Last 7 days' }, { value: '720', label: 'Last 30 days' }, { value: '2160', label: 'Last 90 days' }]} /></div></Card>
      {error ? <Alert variant="error">{error}</Alert> : null}
      {loading ? <div className="flex justify-center p-10"><Spinner /></div> : m ? (<>
        <Card><h2 className="mb-3 font-semibold">Hand-over</h2>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <Stat label="Parcels with a code" value={m.pod.parcels} /><Stat label="Verified hand-overs" value={m.pod.verified} /><Stat label="Wrong-code attempts" value={m.pod.wrongAttempts} />
            <Stat label="Expired-code attempts" value={m.pod.expiredAttempts} /><Stat label="Lockouts" value={m.pod.lockouts} hint={`${pct(m.pod.lockoutRatePct)} of verified + locked`} />
            <Stat label="Resends" value={m.pod.resends} /><Stat label="Rotations" value={m.pod.rotations} />
            <Stat label="Exceptions requested / approved" value={`${m.pod.exceptionsRequested} / ${m.pod.exceptionsApproved}`} />
            <Stat label="Parcels needing manual action" value={m.escalation.parcelsNeedingManualAction} hint={`${pct(m.escalation.ratePct)} of parcels`} />
            <Stat label="Tracking page views" value={m.tracking.views} hint="First view per link per 10 minutes" />
          </div></Card>
        <Channel m={m.email} title="Email" /><Channel m={m.sms} title="SMS" />
      </>) : null}
    </div>
  );
};
export default GuestMetrics;
