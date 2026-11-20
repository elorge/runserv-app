import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Users, CalendarClock, Receipt, AlertTriangle, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { Card, Spinner, Badge, Alert } from '@/components/common';
import AreaChart from '@/components/charts/AreaChart';
import { companyAPI, errMsg } from '@/services/api/company';
import type { PortalProfile } from '@/types/company';
import { formatMoney } from '@/utils/money';
import type { DashboardData } from '@/types/company';
import { StatCard, PageHeader, MonthPicker, currentPeriod, monthLabel, CopyChip, fmtKm } from './ui';

const CompanyDashboard: React.FC = () => {
  const [period, setPeriod] = useState(currentPeriod());
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [prof, setProf] = useState<PortalProfile | null>(null);
  const orgCode = prof?.company.orgCode ?? '';

  useEffect(() => { companyAPI.profile().then(setProf).catch(() => {}); }, []);
  useEffect(() => {
    setLoading(true);
    companyAPI.dashboard(period).then(setData).catch((e) => toast.error(errMsg(e, 'Could not load the dashboard'))).finally(() => setLoading(false));
  }, [period]);

  if (loading && !data) return <div className="py-24 flex justify-center"><Spinner size="lg" /></div>;
  if (!data) return null;
  const money = (n: number) => formatMoney(n, data.currency);
  const overdue = data.invoices?.find((i) => i.status === 'OVERDUE');
  const f = data.funding;

  return (
    <div>
      <PageHeader title="Overview" subtitle={`${data.scope === 'TEAM' ? 'Your team’s' : 'Your staff’s'} rides and deliveries — ${monthLabel(data.period)}`}
        right={<>{orgCode && <CopyChip text={orgCode} label={`Org code  ${orgCode}`} />}<MonthPicker value={period} onChange={setPeriod} /></>} />

      {overdue && (
        <Alert variant="error" className="mb-4" title="Invoice overdue">
          Invoice {overdue.number} ({money(overdue.total)}) is past its due date. Company rides are paused for your staff until it is paid.{' '}
          <Link to="/company/billing" className="underline font-medium">Open billing</Link>
        </Alert>
      )}

      {((prof?.pendingRequests ?? 0) > 0 || (prof?.pendingApprovals ?? 0) + (prof?.pendingWeekend ?? 0) > 0) && (
        <div className="grid sm:grid-cols-2 gap-3 mb-4">
          {(prof?.pendingRequests ?? 0) > 0 && (
            <Link to="/company/staff?tab=requests" className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 hover:bg-amber-100/60">
              <Users className="h-5 w-5 text-amber-600" />
              <div className="flex-1"><p className="font-semibold text-gray-900">{prof?.pendingRequests} staff request{(prof?.pendingRequests ?? 0) > 1 ? 's' : ''} waiting</p>
                <p className="text-xs text-gray-500">Approve people so they can book on the company</p></div>
              <ChevronRight className="h-4 w-4 text-gray-400" />
            </Link>
          )}
          {(prof?.pendingApprovals ?? 0) + (prof?.pendingWeekend ?? 0) > 0 && (
            <Link to="/company/approvals" className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 hover:bg-amber-100/60">
              <CalendarClock className="h-5 w-5 text-amber-600" />
              <div className="flex-1"><p className="font-semibold text-gray-900">{(prof?.pendingApprovals ?? 0) + (prof?.pendingWeekend ?? 0)} approval{(prof?.pendingApprovals ?? 0) + (prof?.pendingWeekend ?? 0) > 1 ? 's' : ''} waiting</p>
                <p className="text-xs text-gray-500">Trips over the limit and weekend rides</p></div>
              <ChevronRight className="h-4 w-4 text-gray-400" />
            </Link>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard label="Spend this month" value={money(data.totals.spend)} sub={`${data.totals.trips} trips · ${data.totals.rides} rides · ${data.totals.deliveries} deliveries`} />
        <StatCard label="Distance covered" value={fmtKm(data.totals.distanceKm)} sub={data.totals.avgCostPerKm ? `${money(data.totals.avgCostPerKm)} per km` : undefined} />
        <StatCard label="Active staff" value={data.activeStaff} sub={data.inProgress ? `${data.inProgress} trip${data.inProgress > 1 ? 's' : ''} in progress` : undefined} />
        <StatCard label="Trips to review" value={data.totals.unreviewed} tone={data.totals.flagged ? 'bad' : data.totals.unreviewed ? 'warn' : 'good'}
          sub={`${data.totals.verified} verified · ${data.totals.flagged} flagged`} />
      </div>

      {f && (
        <div className="grid sm:grid-cols-3 gap-3 mb-5">
          {f.mode !== 'POSTPAID' && <StatCard label="Wallet balance" value={money(f.walletAvailable)} sub={f.walletBalance !== f.walletAvailable ? `${money(f.walletBalance)} incl. trips in progress` : 'available for rides'} tone={f.walletAvailable <= 0 ? 'bad' : 'default'} />}
          {f.mode !== 'PREPAID' && <StatCard label="Credit used" value={money(f.creditExposure)} sub={`of ${money(f.creditLimit)} limit · ${money(f.creditAvailable)} left`} tone={f.creditLimit > 0 && f.creditExposure / f.creditLimit > 0.8 ? 'warn' : 'default'} />}
          <StatCard label="Outstanding invoices" value={money(data.outstandingTotal ?? 0)} />
        </div>)}

      <div className="grid lg:grid-cols-3 gap-4 mb-5">
        <Card className="lg:col-span-2">
          <h3 className="font-semibold text-gray-900 mb-3">Daily spend</h3>
          {data.daily.length === 0 ? <p className="text-sm text-gray-400 py-12 text-center">No completed trips in {monthLabel(data.period)}.</p> :
            <AreaChart data={data.daily} xKey="date" areaKey="spend" areaName="Spend" color="#2563EB" height={240} />}
        </Card>
        <Card padding={false}>
          <div className="px-5 pt-4 pb-2"><h3 className="font-semibold text-gray-900">By department / cost centre</h3></div>
          {data.byDepartment.length === 0 ? <p className="text-sm text-gray-400 py-12 text-center">Nothing yet.</p> : (
            <ul className="divide-y divide-gray-50">{data.byDepartment.slice(0, 8).map((d) => (
              <li key={d.departmentId ?? 'x'} className="px-5 py-2.5">
                <div className="flex justify-between text-sm"><span className="font-medium text-gray-900">{d.department} <span className="text-xs text-gray-400 font-mono">{d.costCenter}</span></span><span className="tabular-nums font-semibold">{money(d.spend)}</span></div>
                {d.budget ? (<div className="mt-1.5"><div className="h-1.5 rounded bg-gray-100 overflow-hidden"><div className={`h-full ${d.spend / d.budget > 0.9 ? 'bg-red-500' : 'bg-primary-500'}`} style={{ width: `${Math.min(100, (d.spend / d.budget) * 100)}%` }} /></div>
                  <p className="text-[11px] text-gray-400 mt-0.5">{Math.round((d.spend / d.budget) * 100)}% of {money(d.budget)} budget</p></div>) : <p className="text-[11px] text-gray-400">{d.trips} trips</p>}
              </li>))}</ul>)}
        </Card>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card padding={false}>
          <div className="px-5 pt-4 pb-2 flex items-center justify-between"><h3 className="font-semibold text-gray-900">Top users this month</h3>
            <Link to="/company/trips" className="text-xs text-primary-600 hover:underline">All trips</Link></div>
          {data.topStaff.length === 0 ? <p className="text-sm text-gray-400 py-8 text-center">No trips yet.</p> : (
            <ul className="divide-y divide-gray-50">
              {data.topStaff.map((s) => (
                <li key={s.employeeId}>
                  <Link to={`/company/staff/${s.employeeId}?period=${data.period}`} className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50">
                    <div className="flex-1 min-w-0"><p className="text-sm font-medium text-gray-900 truncate">{s.name}</p>
                      <p className="text-xs text-gray-400">{s.staffNumber ?? '—'} · {s.department}</p></div>
                    <div className="text-right"><p className="text-sm font-semibold tabular-nums">{money(s.spend)}</p>
                      <p className="text-xs text-gray-400">{s.trips} trips · {fmtKm(s.distanceKm)}</p></div>
                  </Link>
                </li>))}
            </ul>)}
        </Card>

        {data.invoices && <Card padding={false}>
          <div className="px-5 pt-4 pb-2 flex items-center justify-between"><h3 className="font-semibold text-gray-900">Invoices</h3>
            <Link to="/company/billing" className="text-xs text-primary-600 hover:underline">Billing</Link></div>
          {data.invoices!.length === 0 ? <p className="text-sm text-gray-400 py-8 text-center">Your first invoice is issued after the month ends.</p> : (
            <ul className="divide-y divide-gray-50">
              {data.invoices!.slice(0, 5).map((i) => (
                <li key={i.id} className="flex items-center gap-3 px-5 py-3">
                  <Receipt className="h-4 w-4 text-gray-300" />
                  <div className="flex-1"><p className="text-sm font-medium text-gray-900">{monthLabel(i.period)}</p><p className="text-xs text-gray-400">{i.tripCount} trips</p></div>
                  <p className="text-sm font-semibold tabular-nums">{money(i.total)}</p>
                  <Badge variant={i.status === 'PAID' ? 'success' : i.status === 'OVERDUE' ? 'error' : 'warning'}>{i.status}</Badge>
                </li>))}
            </ul>)}
          {(data.outstandingTotal ?? 0) > 0 && (
            <div className="px-5 py-3 border-t border-gray-100 flex items-center gap-2 text-sm text-amber-700 bg-amber-50/50 rounded-b-xl">
              <AlertTriangle className="h-4 w-4" /> Outstanding: <b>{money(data.outstandingTotal ?? 0)}</b>
            </div>)}
        </Card>}
      </div>
    </div>
  );
};
export default CompanyDashboard;
