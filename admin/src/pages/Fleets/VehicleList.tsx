// Runserv staff: every fleet vehicle, with its compliance verdict (can it take jobs?).
import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Car, Search } from 'lucide-react';
import { Card, Spinner, Pagination } from '@/components/common';
import { useDebounce } from '@/hooks/useDebounce';
import { useAuth } from '@/hooks/useAuth';
import { fleetAdminAPI, apiError } from '@/services/api/partnerships';
import type { FleetVehicle } from '@/types/partnerships';
import { PageHeader, StatusBadge, EmptyRow, Th, selectCls, fieldCls, label, ComplianceChips, VehicleActions } from '@/components/features/partnerships';

const PAGE = 25;

const VehicleList: React.FC = () => {
  const { can } = useAuth();
  const [rows, setRows] = useState<FleetVehicle[]>([]); const [pages, setPages] = useState(1); const [total, setTotal] = useState(0);
  const [status, setStatus] = useState(''); const [type, setType] = useState(''); const [blocked, setBlocked] = useState(false);
  const [q, setQ] = useState(''); const dq = useDebounce(q, 400); const [page, setPage] = useState(1); const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    fleetAdminAPI.vehicles({ status: status || undefined, vehicleType: type || undefined, q: dq || undefined, compliance: blocked ? 'blocked' : undefined, page, limit: PAGE })
      .then((r) => { setRows(r.vehicles); setPages(r.pages); setTotal(r.total); }).catch((e) => toast.error(apiError(e))).finally(() => setLoading(false));
  }, [status, type, blocked, dq, page]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [status, type, blocked, dq]);

  return (
    <div className="space-y-5">
      <PageHeader icon={Car} color="bg-indigo-100 text-indigo-600" title="Fleet vehicles" subtitle={`${total} vehicles across all fleets. A vehicle with a missing or expired mandatory document cannot be activated or dispatched.`} />
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative"><Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" /><input className={`${fieldCls} pl-9 w-64`} placeholder="Plate, make or model…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{['PENDING', 'ACTIVE', 'IN_SERVICE', 'MAINTENANCE', 'SUSPENDED', 'RETIRED'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
        <select className={selectCls} value={type} onChange={(e) => setType(e.target.value)}><option value="">All types</option>{['CAR', 'MOTORCYCLE', 'VAN'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
        <label className="flex items-center gap-2 text-sm text-gray-600"><input type="checkbox" checked={blocked} onChange={(e) => setBlocked(e.target.checked)} />Only vehicles blocked by documents <span className="text-xs text-gray-400">(this page)</span></label>
      </div>
      <Card>
        {loading ? <div className="py-16 flex justify-center"><Spinner /></div> : rows.length === 0 ? <EmptyRow text="No vehicles match." /> : (
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr className="border-b border-gray-100"><Th>Vehicle</Th><Th>Fleet</Th><Th>Compliance</Th><Th>Status</Th><Th right>{can.managePartnerships ? 'Actions' : ''}</Th></tr></thead>
            <tbody className="divide-y divide-gray-50">{rows.map((v) => (
              <tr key={v.id} className="align-top">
                <td className="py-3 pr-4"><p className="font-mono font-medium">{v.registrationNumber}</p><p className="text-xs text-gray-400">{label(v.vehicleType)} · {v.make} {v.model}</p></td>
                <td className="py-3 pr-4">{v.fleetPartner ? <Link className="text-blue-600 hover:underline" to={`/fleets/${v.fleetPartner.id}`}>{v.fleetPartner.tradingName || v.fleetPartner.legalName}</Link> : '—'}</td>
                <td className="py-3 pr-4"><ComplianceChips c={v.compliance} />{v.compliance.blockers.length > 0 && <p className="text-xs text-red-600 mt-1">{v.compliance.blockers.join('; ')}</p>}</td>
                <td className="py-3 pr-4"><StatusBadge status={v.status} /></td>
                <td className="py-3"><VehicleActions vehicle={v} canWrite={can.managePartnerships} onChanged={load} /></td></tr>))}</tbody></table></div>)}
        <Pagination currentPage={page} totalPages={pages} onPageChange={setPage} />
      </Card>
    </div>
  );
};
export default VehicleList;
