import React, { useEffect, useState, useCallback } from 'react';
import { Download } from 'lucide-react';
import toast from 'react-hot-toast';
import { Card, Button, Spinner, Pagination, Select } from '@/components/common';
import { companyAPI, errMsg } from '@/services/api/company';
import { formatMoney } from '@/utils/money';
import type { Trip } from '@/types/company';
import TripTable, { exportTrips } from './TripTable';
import { PageHeader, StatCard, MonthPicker, currentPeriod, fmtKm } from './ui';

const TripsPage: React.FC = () => {
  const [period, setPeriod] = useState(currentPeriod());
  const [type, setType] = useState(''); const [audit, setAudit] = useState(''); const [weekend, setWeekend] = useState('');
  const [department, setDepartment] = useState('');
  const [page, setPage] = useState(1);
  const [trips, setTrips] = useState<Trip[]>([]); const [pages, setPages] = useState(1);
  const [summary, setSummary] = useState<{ trips: number; spend: number; distanceKm: number; avgCostPerKm: number | null; currency: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    companyAPI.trips({ period, type: type || undefined, auditStatus: audit || undefined, weekend: weekend || undefined, costCenter: department || undefined, page, limit: 25 })
      .then((r) => { setTrips(r.trips); setPages(r.pagination.pages); setSummary(r.summary); })
      .catch((e) => toast.error(errMsg(e))).finally(() => setLoading(false));
  }, [period, type, audit, weekend, department, page]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [period, type, audit, weekend, department]);

  const exportAll = async () => {
    try { const r = await companyAPI.trips({ period, type: type || undefined, auditStatus: audit || undefined, weekend: weekend || undefined, costCenter: department || undefined, limit: 200 });
      exportTrips(r.trips, `trips-${period}`); if (r.pagination.pages > 1) toast('Exported the first 200 trips — narrow the filters for the rest'); }
    catch (e) { toast.error(errMsg(e)); }
  };
  const cur = summary?.currency ?? 'NGN';

  return (
    <div>
      <PageHeader title="Trips & audit" subtitle="Every company-paid ride and delivery, with distance, cost and the reason given"
        right={<><MonthPicker value={period} onChange={setPeriod} /><Button variant="outline" onClick={exportAll}><Download className="h-4 w-4 inline mr-1.5" />Excel</Button></>} />
      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
          <StatCard label="Trips" value={summary.trips} /><StatCard label="Total cost" value={formatMoney(summary.spend, cur)} />
          <StatCard label="Distance" value={fmtKm(summary.distanceKm)} /><StatCard label="Avg cost / km" value={summary.avgCostPerKm ? formatMoney(summary.avgCostPerKm, cur) : '—'} />
        </div>)}
      <div className="flex flex-wrap gap-2 mb-3">
        <Select value={type} onChange={(e) => setType(e.target.value)} options={[{ value: '', label: 'Rides & deliveries' }, { value: 'RIDE', label: 'Rides' }, { value: 'DELIVERY', label: 'Deliveries' }]} />
        <Select value={audit} onChange={(e) => setAudit(e.target.value)} options={[{ value: '', label: 'Any audit status' }, { value: 'UNREVIEWED', label: 'Not reviewed' }, { value: 'VERIFIED', label: 'Verified' }, { value: 'FLAGGED', label: 'Flagged' }]} />
        <Select value={weekend} onChange={(e) => setWeekend(e.target.value)} options={[{ value: '', label: 'Any day' }, { value: 'true', label: 'Weekend trips only' }]} />
        <input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="Cost centre" className="px-3 py-2 border border-gray-300 rounded-lg text-sm w-40" />
      </div>
      <Card padding={false}>
        {loading ? <div className="py-16 flex justify-center"><Spinner /></div> :
          <TripTable trips={trips} currency={cur} onChange={(t) => setTrips((p) => p.map((x) => (x.id === t.id ? t : x)))} />}
      </Card>
      <Pagination currentPage={page} totalPages={pages} onPageChange={setPage} className="mt-4" />
    </div>
  );
};
export default TripsPage;
