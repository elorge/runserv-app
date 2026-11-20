import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { Download } from 'lucide-react';
import { Button, Card, Modal } from '@/components/common';
import { fleetPortalAPI } from '@/services/api/fleetPortal';
import { downloadCsv } from '@/utils/csv';
import type { PortalSettlement } from '@/types/fleetPortal';
import { tripCsv } from './FleetTrips';
import { FleetPage, Loading, LoadError, StatusBadge, EmptyRow, Th, PromptModal, apiError, fmtDate, money, label, personName, useFleet, useLoad } from './shared';

const periodText = (s: PortalSettlement) => `${fmtDate(s.periodStart)} – ${fmtDate(new Date(new Date(s.periodEnd).getTime() - 1).toISOString())}`;
const DISPUTABLE = ['RECONCILING', 'APPROVED'];

const StatementModal: React.FC<{ id: string; onClose: () => void; onChanged: () => void }> = ({ id, onClose, onChanged }) => {
  const { data, error, loading, reload } = useLoad(() => fleetPortalAPI.settlement(id), [id]);
  const [asking, setAsking] = useState(false);
  const s = data?.settlement;
  const dispute = async (note: string) => {
    try { await fleetPortalAPI.dispute(id, note); toast.success('Statement marked as disputed. Runserv will follow up.'); setAsking(false); reload(); onChanged(); }
    catch (e) { toast.error(apiError(e)); }
  };
  return (
    <Modal isOpen onClose={onClose} title={s ? `Statement ${s.reference ?? s.id.slice(0, 8)}` : 'Statement'} size="xl"
      footer={<>
        {s && data && <Button variant="outline" onClick={() => downloadCsv(`statement-${s.reference ?? s.id.slice(0, 8)}.csv`, tripCsv(data.trips, true))}><Download className="h-4 w-4" /> Export trips (CSV)</Button>}
        {s && DISPUTABLE.includes(s.status) && <Button variant="danger" onClick={() => setAsking(true)}>Dispute this statement</Button>}
        <Button variant="outline" onClick={onClose}>Close</Button></>}>
      {loading && <Loading />}
      {error && <LoadError message={error} onRetry={reload} />}
      {s && data && (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-3"><StatusBadge status={s.status} /><span className="text-gray-600">{periodText(s)}</span>{s.paidAt && <span className="text-gray-500">Paid {fmtDate(s.paidAt)}</span>}</div>
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {([['Gross fares', money(s.grossAmount, s.currency)], ['Runserv fee', `− ${money(s.platformFeeAmount, s.currency)}`], ['Adjustments', money(s.adjustmentsAmount, s.currency)], ['Net payable', money(s.netAmount, s.currency)]] as [string, string][]).map(([k, v]) => (
              <div key={k} className="rounded-lg border border-gray-100 p-3"><dt className="text-xs text-gray-500">{k}</dt><dd className="font-semibold">{v}</dd></div>))}
          </dl>
          <div className="overflow-x-auto max-h-72"><table className="w-full text-xs">
            <thead><tr className="border-b border-gray-100"><Th>Completed</Th><Th>Driver</Th><Th>Vehicle</Th><Th>Service</Th><Th right>Fare</Th><Th right>Net</Th></tr></thead>
            <tbody className="divide-y divide-gray-50">{data.trips.map((t) => (
              <tr key={t.id}><td className="py-2 pr-3 whitespace-nowrap">{t.completedAt ? fmtDate(t.completedAt) : '—'}</td><td className="py-2 pr-3">{personName(t.driver)}</td><td className="py-2 pr-3 font-mono">{t.vehicle?.registrationNumber ?? '—'}</td><td className="py-2 pr-3">{label(t.serviceType)}</td><td className="py-2 pr-3 text-right tabular-nums">{money(t.fareAmount, t.currency)}</td><td className="py-2 text-right tabular-nums">{money(t.fleetNetAmount, t.currency)}</td></tr>))}</tbody></table>
            {!data.trips.length && <EmptyRow text="No completed trips in this period." />}</div>
        </div>)}
      <PromptModal open={asking} title="Dispute this statement" fieldLabel="What looks wrong?" required confirmLabel="Send dispute" danger
        description="Runserv will review your note. The statement stays disputed until it is reconciled again." onClose={() => setAsking(false)} onSubmit={dispute} />
    </Modal>
  );
};

const FleetSettlementsPage: React.FC = () => {
  const { can } = useFleet();
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, loading, reload } = useLoad(() => fleetPortalAPI.settlements(), []);
  if (!can.seeFinance) return <FleetPage title="Settlements"><p className="text-sm text-gray-500">Settlements are visible to Owner, Admin and Finance roles.</p></FleetPage>;
  return (
    <FleetPage title="Settlements" subtitle="Statements of what Runserv owes your fleet for each period.">
      <Card>
        {loading && <Loading />}
        {error && <LoadError message={error} onRetry={reload} />}
        {data && (!data.length ? <EmptyRow text="No statements yet. Runserv issues one for each settlement period." /> : (
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr className="border-b border-gray-100"><Th>Reference</Th><Th>Period</Th><Th right>Gross</Th><Th right>Fee</Th><Th right>Net payable</Th><Th>Status</Th><Th right /></tr></thead>
            <tbody className="divide-y divide-gray-50">{data.map((s) => (
              <tr key={s.id}>
                <td className="py-3 pr-4 font-mono text-xs text-gray-600">{s.reference ?? s.id.slice(0, 8)}</td>
                <td className="py-3 pr-4 whitespace-nowrap">{periodText(s)}</td>
                <td className="py-3 pr-4 text-right tabular-nums">{money(s.grossAmount, s.currency)}</td>
                <td className="py-3 pr-4 text-right tabular-nums text-gray-500">{money(s.platformFeeAmount, s.currency)}</td>
                <td className="py-3 pr-4 text-right tabular-nums font-semibold">{money(s.netAmount, s.currency)}</td>
                <td className="py-3 pr-4"><StatusBadge status={s.status} /></td>
                <td className="py-3 text-right"><Button size="sm" variant="outline" onClick={() => setOpen(s.id)}>View</Button></td>
              </tr>))}</tbody></table></div>))}
      </Card>
      {open && <StatementModal id={open} onClose={() => setOpen(null)} onChanged={reload} />}
    </FleetPage>
  );
};
export default FleetSettlementsPage;
