// Runserv staff: what drivers / partners were paid from company invoices.
import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Wallet } from 'lucide-react';
import { Card, Badge, Spinner, Pagination } from '@/components/common';
import api from '@/services/api';
import { formatMoney } from '@/utils/money';

const OrgPayouts: React.FC = () => {
  const [rows, setRows] = useState<any[]>([]); const [page, setPage] = useState(1); const [pages, setPages] = useState(1);
  const [status, setStatus] = useState(''); const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    api.get('/admin/corporate/payouts', { params: { status: status || undefined, page, limit: 25 } })
      .then((r) => { setRows(r.data.data.payouts); setPages(r.data.data.pagination.pages); }).catch(() => toast.error('Could not load payouts')).finally(() => setLoading(false));
  }, [page, status]);
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3"><div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center"><Wallet className="h-5 w-5 text-emerald-600" /></div>
        <div><h1 className="text-2xl font-bold text-gray-900">Driver payouts — company rides</h1><p className="text-sm text-gray-500">Credited to the driver's wallet when the company pays its monthly invoice. They withdraw to their bank as usual.</p></div></div>
      <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
        <option value="">All</option><option value="PENDING">Pending</option><option value="PAID">Paid</option></select>
      <Card>{loading ? <div className="py-16 flex justify-center"><Spinner /></div> : rows.length === 0 ? <p className="text-center text-gray-400 py-12">No payouts yet.</p> : (
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-gray-100 text-left text-xs uppercase text-gray-500">
          <th className="pb-3 pr-4">Driver / partner</th><th className="pb-3 pr-4">Company</th><th className="pb-3 pr-4">Month</th><th className="pb-3 pr-4 text-right">Trips</th><th className="pb-3 pr-4 text-right">Fares</th><th className="pb-3 pr-4 text-right">Paid out</th><th className="pb-3">Status</th></tr></thead>
          <tbody className="divide-y divide-gray-50">{rows.map((p) => (
            <tr key={p.id}><td className="py-3 pr-4 font-medium">{p.user.firstName} {p.user.lastName}<p className="text-xs text-gray-400">{p.user.role === 'DRIVER' ? 'Driver' : 'Delivery partner'} · {p.user.phone}</p></td>
              <td className="py-3 pr-4">{p.company?.name}</td><td className="py-3 pr-4">{p.period}</td><td className="py-3 pr-4 text-right">{p.tripCount}</td>
              <td className="py-3 pr-4 text-right text-gray-500">{formatMoney(p.grossAmount, p.currency)}</td><td className="py-3 pr-4 text-right font-semibold">{formatMoney(p.netAmount, p.currency)}</td>
              <td className="py-3"><Badge variant={p.status === 'PAID' ? 'success' : 'warning'}>{p.status}</Badge></td></tr>))}</tbody></table></div>)}</Card>
      <Pagination currentPage={page} totalPages={pages} onPageChange={setPage} />
    </div>
  );
};
export default OrgPayouts;
