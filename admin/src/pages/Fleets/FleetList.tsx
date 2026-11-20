// Runserv staff: fleet organisations — review queue and register.
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Building, Search } from 'lucide-react';
import { Card, Spinner, Pagination } from '@/components/common';
import { useDebounce } from '@/hooks/useDebounce';
import { fleetAdminAPI, apiError } from '@/services/api/partnerships';
import type { FleetPartner, FleetStats } from '@/types/partnerships';
import { PageHeader, Stat, StatusBadge, EmptyRow, Th, selectCls, fieldCls, fmtDate, pct } from '@/components/features/partnerships';

const PAGE = 20;

const FleetList: React.FC = () => {
  const nav = useNavigate();
  const [stats, setStats] = useState<FleetStats | null>(null);
  const [rows, setRows] = useState<FleetPartner[]>([]); const [total, setTotal] = useState(0);
  const [status, setStatus] = useState(''); const [q, setQ] = useState(''); const dq = useDebounce(q, 400);
  const [page, setPage] = useState(1); const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([fleetAdminAPI.list({ status: status || undefined, q: dq || undefined, page, limit: PAGE }), fleetAdminAPI.stats()])
      .then(([l, s]) => { setRows(l.fleets); setTotal(l.total); setStats(s); })
      .catch((e) => toast.error(apiError(e))).finally(() => setLoading(false));
  }, [status, dq, page]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [status, dq]);

  return (
    <div className="space-y-5">
      <PageHeader icon={Building} title="Fleet partners" subtitle="Approve fleet organisations, set their terms and keep their vehicles compliant." />
      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <Stat label="Active fleets" value={stats.activeFleets} />
          <Stat label="Awaiting review" value={stats.pendingFleets} tone={stats.pendingFleets ? 'warn' : undefined} />
          <Stat label="Active vehicles" value={stats.activeVehicles} />
          <Stat label="Vehicles to review" value={stats.pendingVehicles} tone={stats.pendingVehicles ? 'warn' : undefined} />
          <Stat label="Open settlements" value={stats.openSettlements} hint="not yet paid or cancelled" />
        </div>)}
      <div className="flex flex-wrap gap-3">
        <div className="relative"><Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" /><input className={`${fieldCls} pl-9 w-64`} placeholder="Search fleet name…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>{['PENDING', 'UNDER_REVIEW', 'ACTIVE', 'SUSPENDED', 'REJECTED', 'DEACTIVATED'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </select>
      </div>
      <Card>
        {loading ? <div className="py-16 flex justify-center"><Spinner /></div> : rows.length === 0 ? <EmptyRow text="No fleet partners match." /> : (
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr className="border-b border-gray-100"><Th>Fleet</Th><Th>Contact</Th><Th right>Vehicles</Th><Th right>Fee</Th><Th>Verification</Th><Th>Status</Th><Th>Applied</Th></tr></thead>
            <tbody className="divide-y divide-gray-50">{rows.map((f) => (
              <tr key={f.id} onClick={() => nav(`/fleets/${f.id}`)} className="cursor-pointer hover:bg-gray-50">
                <td className="py-3 pr-4"><p className="font-medium text-gray-900">{f.tradingName || f.legalName}</p>{f.tradingName && <p className="text-xs text-gray-400">{f.legalName}</p>}{f.rcNumber && <p className="text-xs text-gray-400">RC {f.rcNumber}</p>}</td>
                <td className="py-3 pr-4 text-gray-600"><p>{f.email}</p><p className="text-xs text-gray-400">{f.phone}</p></td>
                <td className="py-3 pr-4 text-right">{f._count?.vehicles ?? 0}</td>
                <td className="py-3 pr-4 text-right">{pct(f.commissionRate)}</td>
                <td className="py-3 pr-4"><StatusBadge status={f.verificationStatus} /></td>
                <td className="py-3 pr-4"><StatusBadge status={f.status} /></td>
                <td className="py-3 text-gray-500 whitespace-nowrap">{fmtDate(f.createdAt)}</td></tr>))}</tbody></table></div>)}
        <Pagination currentPage={page} totalPages={Math.max(Math.ceil(total / PAGE), 1)} onPageChange={setPage} />
      </Card>
    </div>
  );
};
export default FleetList;
