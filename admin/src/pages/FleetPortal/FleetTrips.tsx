import React, { useState } from 'react';
import { Download } from 'lucide-react';
import { Button, Card } from '@/components/common';
import { fleetPortalAPI } from '@/services/api/fleetPortal';
import { downloadCsv } from '@/utils/csv';
import type { PortalTrip } from '@/types/fleetPortal';
import { FleetPage, Loading, LoadError, Pager, StatusBadge, EmptyRow, Th, selectCls, money, label, personName, useFleet, useLoad } from './shared';

const STATUSES = ['', 'OFFERED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'DISPUTED'];
const when = (t: PortalTrip) => new Date(t.completedAt ?? t.cancelledAt ?? t.createdAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export const tripCsv = (trips: PortalTrip[], finance: boolean) => [
  ['Date', 'Driver', 'Vehicle', 'Service', 'Status', 'Note', ...(finance ? ['Currency', 'Fare', 'Platform fee', 'Net to fleet'] : [])],
  ...trips.map((t) => [new Date(t.completedAt ?? t.cancelledAt ?? t.createdAt).toISOString(), personName(t.driver), t.vehicle?.registrationNumber ?? '', label(t.serviceType), label(t.status), t.cancellationReason ?? '',
    ...(finance ? [t.currency, t.fareAmount ?? '', t.platformFeeAmount ?? '', t.fleetNetAmount ?? ''] : [])]),
];

const FleetTrips: React.FC = () => {
  const { can } = useFleet();
  const [status, setStatus] = useState(''); const [exceptions, setExceptions] = useState(false); const [page, setPage] = useState(1);
  const { data, error, loading, reload } = useLoad(() => fleetPortalAPI.trips({ status: exceptions ? undefined : status || undefined, exceptions, page }), [status, exceptions, page]);
  const finance = can.seeFinance;
  return (
    <FleetPage title="Trips" subtitle="Rides and deliveries completed by your drivers."
      actions={data && data.trips.length > 0 && <Button variant="outline" onClick={() => downloadCsv(`fleet-trips-page-${page}.csv`, tripCsv(data.trips, finance))}><Download className="h-4 w-4" /> Export this page (CSV)</Button>}>
      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <select aria-label="Filter by status" className={selectCls} value={status} disabled={exceptions} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>{STATUSES.map((s) => <option key={s} value={s}>{s ? label(s) : 'All statuses'}</option>)}</select>
          <label className="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={exceptions} onChange={(e) => { setExceptions(e.target.checked); setPage(1); }} /> Exceptions only (cancelled or disputed)</label>
        </div>
        {!finance && <p className="mb-3 text-xs text-gray-500">Fares and earnings are visible to Owner, Admin and Finance roles only.</p>}
        {loading && <Loading />}
        {error && <LoadError message={error} onRetry={reload} />}
        {data && (!data.trips.length ? <EmptyRow text="No trips found." /> : (
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr className="border-b border-gray-100"><Th>When</Th><Th>Driver</Th><Th>Vehicle</Th><Th>Service</Th><Th>Status</Th>{finance && <><Th right>Fare</Th><Th right>Fee</Th><Th right>Net to you</Th></>}</tr></thead>
            <tbody className="divide-y divide-gray-50">
              {data.trips.map((t) => (
                <tr key={t.id} className="align-top">
                  <td className="py-3 pr-4 whitespace-nowrap text-gray-600">{when(t)}</td>
                  <td className="py-3 pr-4">{personName(t.driver)}</td>
                  <td className="py-3 pr-4 font-mono text-xs">{t.vehicle?.registrationNumber ?? '—'}</td>
                  <td className="py-3 pr-4">{label(t.serviceType)}</td>
                  <td className="py-3 pr-4"><StatusBadge status={t.status} />{t.cancellationReason && <p className="text-xs text-gray-400 mt-1">{t.cancellationReason}</p>}</td>
                  {finance && <><td className="py-3 pr-4 text-right tabular-nums">{money(t.fareAmount, t.currency)}</td><td className="py-3 pr-4 text-right tabular-nums text-gray-500">{money(t.platformFeeAmount, t.currency)}</td><td className="py-3 pr-4 text-right tabular-nums font-medium">{money(t.fleetNetAmount, t.currency)}</td></>}
                </tr>))}
            </tbody></table></div>))}
        {data && <Pager page={page} total={data.total} onPage={setPage} />}
      </Card>
      <p className="text-xs text-gray-400">Exports cover the page currently on screen.</p>
    </FleetPage>
  );
};
export default FleetTrips;
