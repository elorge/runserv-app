// Runserv staff: completed fleet-driver trips vs. recorded fleet trips. Missing trips can be repaired (audited, idempotent); other differences are reported only.
import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { GitCompare } from 'lucide-react';
import { Alert, Button, Card, Spinner } from '@/components/common';
import { useAuth } from '@/hooks/useAuth';
import { fleetAdminAPI, apiError, type TripReconciliation } from '@/services/api/partnerships';
import { PageHeader, Field, fieldCls, fmtDate } from '@/components/features/partnerships';

const ref = (r: { rideId?: string | null; deliveryId?: string | null }) => (r.rideId ? `ride ${r.rideId.slice(0, 8)}` : r.deliveryId ? `delivery ${r.deliveryId.slice(0, 8)}` : '—');
const Section: React.FC<{ title: string; count: number; children: React.ReactNode }> = ({ title, count, children }) => (
  <Card><h2 className="text-sm font-semibold mb-2">{title} <span className={count ? 'text-red-600' : 'text-gray-400'}>({count})</span></h2>{count ? <div className="overflow-x-auto">{children}</div> : <p className="text-sm text-gray-500">None found.</p>}</Card>
);

const TripReconciliationPage: React.FC = () => {
  const { can } = useAuth();
  const [since, setSince] = useState(''); const [until, setUntil] = useState('');
  const [res, setRes] = useState<TripReconciliation | null>(null); const [busy, setBusy] = useState(false); const [repairing, setRepairing] = useState(false);
  const win = () => ({ since: since ? new Date(since).toISOString() : undefined, until: until ? new Date(until).toISOString() : undefined });

  const check = async () => { setBusy(true); try { setRes(await fleetAdminAPI.reconcileTrips(win())); } catch (e) { toast.error(apiError(e)); } finally { setBusy(false); } };
  const repair = async () => {
    if (!res || !window.confirm(`Re-record ${res.missing.length} missing fleet trip(s)? Fares recorded are not changed for existing trips.`)) return;
    setRepairing(true);
    try { const r = await fleetAdminAPI.repairTrips(win()); setRes(r); toast.success(`${r.repaired} trip(s) repaired${r.failed.length ? `, ${r.failed.length} failed` : ''}`); }
    catch (e) { toast.error(apiError(e)); } finally { setRepairing(false); }
  };

  return (
    <div className="space-y-5">
      <PageHeader icon={GitCompare} color="bg-indigo-100 text-indigo-600" title="Fleet trip reconciliation" subtitle="Finds completed trips by fleet drivers that never reached the fleet’s statement, or that were recorded differently." />
      <Card>
        <div className="grid sm:grid-cols-3 gap-3 items-end">
          <Field label="From (default: last 24 hours)"><input type="datetime-local" className={fieldCls} value={since} onChange={(e) => setSince(e.target.value)} /></Field>
          <Field label="To (default: now)"><input type="datetime-local" className={fieldCls} value={until} onChange={(e) => setUntil(e.target.value)} /></Field>
          <Button loading={busy} onClick={check}>Check</Button>
        </div>
        <p className="text-xs text-gray-500 mt-2">A window can be at most 31 days. Run this before creating settlement statements.</p>
      </Card>
      {busy && <div className="py-10 flex justify-center"><Spinner /></div>}
      {res && !busy && <>
        <Alert variant={res.missing.length + res.amountMismatch.length + res.fieldMismatch.length + res.ambiguous.length ? 'warning' : 'success'} title={`${res.checked} fleet trip(s) checked · ${fmtDate(res.window.start)} – ${fmtDate(res.window.end)}`}>
          {res.truncated ? 'More trips exist in this window than were scanned. Narrow the window and check again.' : 'The whole window was scanned.'}
        </Alert>
        <Section title="Missing from the fleet’s trips" count={res.missing.length}>
          <table className="w-full text-sm"><thead><tr className="text-left text-xs text-gray-500"><th className="py-1 pr-3">Trip</th><th className="pr-3">Completed</th><th className="pr-3">Fare</th><th>Fleet</th></tr></thead>
            <tbody>{res.missing.map((m, i) => <tr key={i} className="border-t border-gray-50"><td className="py-1 pr-3 font-mono text-xs">{ref(m)}</td><td className="pr-3">{fmtDate(m.completedAt)}</td><td className="pr-3">{String(m.fare)} {m.currency ?? ''}</td><td className="font-mono text-xs">{m.fleetPartnerId.slice(0, 8)}</td></tr>)}</tbody></table>
          {can.managePartnerships && <div className="mt-3"><Button loading={repairing} onClick={repair}>Repair {res.missing.length} missing trip(s)</Button></div>}
        </Section>
        <Section title="Fare differs from the completed trip (report only)" count={res.amountMismatch.length}>
          <table className="w-full text-sm"><tbody>{res.amountMismatch.map((m) => <tr key={m.fleetTripId} className="border-t border-gray-50"><td className="py-1 pr-3 font-mono text-xs">{ref(m)}</td><td className="pr-3">recorded {m.recordedFare}</td><td>actual {m.actualFare}</td></tr>)}</tbody></table>
        </Section>
        <Section title="Other fields differ (report only)" count={res.fieldMismatch.length}>
          <table className="w-full text-sm"><tbody>{res.fieldMismatch.map((m) => <tr key={m.fleetTripId} className="border-t border-gray-50"><td className="py-1 pr-3 font-mono text-xs">{ref(m)}</td><td>{m.diffs.map((d) => `${d.field}: ${d.recorded} → ${d.expected}`).join('; ')}</td></tr>)}</tbody></table>
        </Section>
        <Section title="Ambiguous assignments (resolve by hand)" count={res.ambiguous.length}>
          <table className="w-full text-sm"><tbody>{res.ambiguous.map((m, i) => <tr key={i} className="border-t border-gray-50"><td className="py-1 pr-3 font-mono text-xs">{ref(m)}</td><td className="pr-3">{fmtDate(m.completedAt)}</td><td>{m.note}</td></tr>)}</tbody></table>
        </Section>
      </>}
    </div>
  );
};
export default TripReconciliationPage;
