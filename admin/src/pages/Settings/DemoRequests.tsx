// Inbox for "Request a demo" submissions from the landing page.
import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Inbox } from 'lucide-react';
import { Card, Spinner } from '@/components/common';
import { demoAdminAPI, apiError } from '@/services/api/partnerships';
import type { DemoRequest, DemoStatus } from '@/services/api/partnerships';
import { PageHeader, selectCls, label } from '@/components/features/partnerships';

const STATUSES: DemoStatus[] = ['NEW', 'CONTACTED', 'DEMO_SCHEDULED', 'WON', 'LOST'];

const DemoRequests: React.FC = () => {
  const [rows, setRows] = useState<DemoRequest[]>([]); const [filter, setFilter] = useState<DemoStatus | ''>('NEW'); const [loading, setLoading] = useState(true);
  const load = useCallback(() => { setLoading(true); demoAdminAPI.list(filter || undefined).then(setRows).catch((e) => toast.error(apiError(e))).finally(() => setLoading(false)); }, [filter]);
  useEffect(() => { load(); }, [load]);
  const save = (id: string, body: { status?: DemoStatus; notes?: string }) => demoAdminAPI.update(id, body).then(() => { toast.success('Saved'); load(); }).catch((e) => toast.error(apiError(e)));

  return (
    <div className="space-y-5">
      <PageHeader icon={Inbox} color="bg-violet-100 text-violet-600" title="Demo requests" subtitle="People who asked for a demo on the website."
        actions={<select className={selectCls} value={filter} onChange={(e) => setFilter(e.target.value as DemoStatus | '')}><option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>} />
      {loading ? <div className="py-16 flex justify-center"><Spinner /></div> : (
        <Card><div className="divide-y">
          {rows.map((r) => (
            <div key={r.id} className="p-4 space-y-2">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex-1 min-w-[220px]"><div className="font-medium">{r.name}{r.organisation ? ` · ${r.organisation}` : ''}</div>
                  <div className="text-sm text-gray-600"><a className="text-primary-600" href={`mailto:${r.email}`}>{r.email}</a>{r.phone ? ` · ${r.phone}` : ''} · {label(r.interest)}</div>
                  <div className="text-xs text-gray-400">{new Date(r.createdAt).toLocaleString()}</div></div>
                <select className={selectCls} value={r.status} onChange={(e) => save(r.id, { status: e.target.value as DemoStatus })}>{STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
              </div>
              {r.message && <p className="text-sm text-gray-700 whitespace-pre-wrap">{r.message}</p>}
              <textarea className="w-full border rounded-lg p-2 text-sm" rows={2} placeholder="Internal notes" defaultValue={r.notes ?? ''} maxLength={1000} onBlur={(e) => { if ((e.target.value || '') !== (r.notes || '')) save(r.id, { notes: e.target.value }); }} />
            </div>))}
          {!rows.length && <p className="p-10 text-center text-gray-500">No requests.</p>}
        </div></Card>)}
    </div>
  );
};
export default DemoRequests;
