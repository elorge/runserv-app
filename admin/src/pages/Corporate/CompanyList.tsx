// Runserv staff: organisations — create, approve, verify.
import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, Search, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { Card, Badge, Spinner, Pagination } from '@/components/common';
import api from '@/services/api';
import { formatMoney } from '@/utils/money';
import CreateCompanyModal from './CreateCompanyModal';

const st = (s: string) => (s === 'ACTIVE' || s === 'VERIFIED' ? 'success' : s === 'SUSPENDED' || s === 'REJECTED' ? 'error' : 'warning') as 'success' | 'error' | 'warning';
const MODE: Record<string, string> = { PREPAID: 'Prepaid', POSTPAID: 'Monthly invoice', HYBRID: 'Hybrid' };

const CompanyList: React.FC = () => {
  const navigate = useNavigate();
  const [rows, setRows] = useState<any[]>([]); const [total, setTotal] = useState(0); const [page, setPage] = useState(1); const [pages, setPages] = useState(1);
  const [search, setSearch] = useState(''); const [status, setStatus] = useState(''); const [loading, setLoading] = useState(true); const [create, setCreate] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/admin/corporate/companies', { params: { page, limit: 20, search: search || undefined, status: status || undefined } })
      .then((r) => { setRows(r.data.data.companies); setTotal(r.data.data.pagination.total); setPages(r.data.data.pagination.pages); })
      .catch(() => toast.error('Could not load organisations')).finally(() => setLoading(false));
  }, [page, search, status]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-5">
      <CreateCompanyModal isOpen={create} onClose={() => setCreate(false)} onCreated={load} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3"><div className="w-10 h-10 bg-primary-100 rounded-xl flex items-center justify-center"><Building2 className="h-5 w-5 text-primary-600" /></div>
          <div><h1 className="text-2xl font-bold text-gray-900">Organisations</h1><p className="text-sm text-gray-500">{total} organisations</p></div></div>
        <button onClick={() => setCreate(true)} className="px-4 py-2 bg-primary-600 text-white text-sm font-semibold rounded-lg hover:bg-primary-700">+ New organisation</button>
      </div>
      <div className="flex flex-wrap gap-2">
        <div className="relative"><Search className="h-4 w-4 absolute left-3 top-2.5 text-gray-400" /><input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search name, email or code" className="pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm w-64" /></div>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="border border-gray-200 rounded-lg px-3 py-2 text-sm"><option value="">All statuses</option><option value="PENDING">Awaiting approval</option><option value="ACTIVE">Active</option><option value="SUSPENDED">Suspended</option></select>
      </div>
      <Card>
        {loading ? <div className="py-16 flex justify-center"><Spinner /></div> : rows.length === 0 ? <p className="text-center text-gray-400 py-12">No organisations yet.</p> : (
          <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-gray-100 text-left text-xs uppercase text-gray-500">
            <th className="pb-3 pr-4">Organisation</th><th className="pb-3 pr-4">Code</th><th className="pb-3 pr-4">Status</th><th className="pb-3 pr-4">Verification</th><th className="pb-3 pr-4">Billing</th><th className="pb-3 pr-4 text-right">Wallet</th><th className="pb-3 pr-4 text-right">Staff</th><th /></tr></thead>
            <tbody className="divide-y divide-gray-50">{rows.map((c) => (
              <tr key={c.id} onClick={() => navigate(`/corporate/${c.id}`)} className="cursor-pointer hover:bg-gray-50">
                <td className="py-3 pr-4"><p className="font-medium text-gray-900">{c.name}</p><p className="text-xs text-gray-400">{c.email}</p></td>
                <td className="py-3 pr-4 font-mono text-xs">{c.orgCode}</td><td className="py-3 pr-4"><Badge variant={st(c.status)}>{c.status}</Badge></td>
                <td className="py-3 pr-4"><Badge variant={st(c.verificationStatus)}>{c.verificationStatus.replace('_', ' ')}</Badge></td><td className="py-3 pr-4">{MODE[c.billingMode]}</td>
                <td className="py-3 pr-4 text-right">{formatMoney(c.walletBalance, 'NGN')}</td><td className="py-3 pr-4 text-right">{c.staffCount}</td><td className="py-3"><ChevronRight className="h-4 w-4 text-gray-300" /></td></tr>))}</tbody></table></div>)}
      </Card>
      <Pagination currentPage={page} totalPages={pages} onPageChange={setPage} />
    </div>
  );
};
export default CompanyList;
