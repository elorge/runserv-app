import React, { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Download, Printer } from 'lucide-react';
import toast from 'react-hot-toast';
import { Card, Button, Spinner } from '@/components/common';
import { companyAPI, errMsg } from '@/services/api/company';
import { formatMoney } from '@/utils/money';
import TripTable, { exportTrips } from './TripTable';
import { StatCard, MonthPicker, currentPeriod, monthLabel, fmtKm } from './ui';

type Hist = Awaited<ReturnType<typeof companyAPI.staffHistory>>;

/** One staff member's rides for one month — the page the rep uses to check they were real business trips. */
const StaffAudit: React.FC = () => {
  const { id = '' } = useParams();
  const [sp, setSp] = useSearchParams();
  const period = sp.get('period') || currentPeriod();
  const [data, setData] = useState<Hist | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    companyAPI.staffHistory(id, period).then(setData).catch((e) => toast.error(errMsg(e))).finally(() => setLoading(false));
  }, [id, period]);

  if (loading && !data) return <div className="py-24 flex justify-center"><Spinner size="lg" /></div>;
  if (!data) return null;
  const e = data.employee; const s = data.summary; const money = (n: number) => formatMoney(n, data.currency);

  return (
    <div>
      <Link to="/company/staff" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 mb-3 print:hidden"><ArrowLeft className="h-4 w-4" />Staff</Link>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{e.name}</h1>
          <p className="text-sm text-gray-500">Staff no. <span className="font-mono">{e.staffNumber ?? '—'}</span> · {e.department ?? '—'}{e.costCenter ? ` (${e.costCenter})` : ''}{e.jobTitle ? ` · ${e.jobTitle}` : ''}{e.supervisor ? ` · reports to ${e.supervisor}` : ''} · {e.phone}</p>
          <p className="text-sm text-gray-400 mt-0.5">Ride history — {monthLabel(data.period)}</p>
        </div>
        <div className="flex items-center gap-2 print:hidden">
          <MonthPicker value={period} onChange={(v) => setSp({ period: v })} />
          <Button variant="outline" onClick={() => exportTrips(data.trips, `${e.name.replace(/\s+/g, '-')}-${data.period}`)}><Download className="h-4 w-4 inline mr-1.5" />Excel</Button>
          <Button variant="outline" onClick={() => window.print()}><Printer className="h-4 w-4 inline mr-1.5" />Print</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
        <StatCard label="Trips" value={s.trips} sub={s.weekendTrips ? `${s.weekendTrips} on weekends` : undefined} />
        <StatCard label="Distance" value={fmtKm(s.distanceKm)} />
        <StatCard label="Total cost" value={money(s.spend)} sub={e.monthlyLimit > 0 ? `limit ${money(e.monthlyLimit)}` : 'no limit'} />
        <StatCard label="Avg cost / km" value={s.avgCostPerKm ? money(s.avgCostPerKm) : '—'} />
        <StatCard label="Needs attention" value={s.flagged + s.noPurpose} tone={s.flagged + s.noPurpose ? 'bad' : 'good'} sub={`${s.flagged} flagged · ${s.noPurpose} without purpose`} />
      </div>

      <Card padding={false}>
        <TripTable trips={data.trips} currency={data.currency} showStaff={false}
          onChange={(t) => setData({ ...data, trips: data.trips.map((x) => (x.id === t.id ? t : x)), summary: { ...s, flagged: data.trips.filter((x) => (x.id === t.id ? t : x).audit.status === 'FLAGGED').length } })} />
      </Card>
    </div>
  );
};
export default StaffAudit;
