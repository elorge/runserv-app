// Operations alerts: durable, acknowledge / resolve with a note. Staff with deliveries or support scope.
import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { BellRing } from 'lucide-react';
import { Button, Card, Spinner } from '@/components/common';
import { apiError } from '@/services/api/partnerships';
import { alertsAPI, OpsAlert } from '@/services/api/finance';

const sev = (s: string) => (s === 'CRITICAL' ? 'bg-red-100 text-red-700' : s === 'WARNING' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-700');

const OpsAlerts: React.FC = () => {
  const [items, setItems] = useState<OpsAlert[]>([]); const [next, setNext] = useState<string | null>(null); const [open, setOpen] = useState(0);
  const [status, setStatus] = useState('OPEN'); const [loading, setLoading] = useState(true); const [err, setErr] = useState(''); const [busy, setBusy] = useState('');

  const load = useCallback(async (more = false, cursor?: string | null) => {
    setLoading(!more); setErr('');
    try { const r = await alertsAPI.list({ status: status || undefined, cursor: more ? cursor || undefined : undefined }); setItems((p) => (more ? [...p, ...r.alerts] : r.alerts)); setNext(r.nextCursor); setOpen(r.openCount); }
    catch (e: any) { setErr(e?.response?.status === 403 ? 'You do not have permission to view operations alerts.' : apiError(e)); }
    finally { setLoading(false); }
  }, [status]);
  useEffect(() => { load(); }, [load]);

  const act = async (id: string, fn: () => Promise<unknown>, ok: string) => { setBusy(id); try { await fn(); toast.success(ok); load(); } catch (e) { toast.error(apiError(e)); } finally { setBusy(''); } };
  const resolve = (a: OpsAlert) => { const n = window.prompt('Resolution note (required)'); if (n && n.trim().length >= 3 && window.confirm('Mark this alert resolved?')) act(a.id, () => alertsAPI.resolve(a.id, n.trim()), 'Resolved'); };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3"><BellRing className="w-6 h-6 text-primary-600" /><h1 className="text-2xl font-bold">Operations alerts</h1><span className="text-sm text-gray-500">{open} open</span>
        <select className="ml-auto border rounded px-2 py-1 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}><option value="OPEN">Open</option><option value="ACKNOWLEDGED">Acknowledged</option><option value="RESOLVED">Resolved</option><option value="">All</option></select></div>
      {loading ? <div className="py-16 flex justify-center"><Spinner /></div> : err ? <Card><div className="p-6 text-red-600">{err}</div></Card> : items.length === 0 ? <Card><div className="p-6 text-gray-500">No alerts in this view.</div></Card> : (
        <Card><div className="divide-y">{items.map((a) => (
          <div key={a.id} className="p-4 flex flex-wrap gap-3 items-center">
            <span className={`px-2 py-0.5 rounded text-xs font-semibold ${sev(a.severity)}`}>{a.severity}</span>
            <div className="flex-1 min-w-[240px]"><div className="font-medium">{a.title}</div><div className="text-sm text-gray-600">{a.message}</div>
              <div className="text-xs text-gray-400">{a.kind} · {new Date(a.createdAt).toLocaleString()}{a.occurrences ? ` · seen ${a.occurrences}×` : ''}{a.resolutionNote ? ` · ${a.resolutionNote}` : ''}</div></div>
            <span className="text-xs">{a.status}</span>
            {a.status === 'OPEN' && <Button variant="secondary" disabled={busy === a.id} onClick={() => act(a.id, () => alertsAPI.acknowledge(a.id), 'Acknowledged')}>Acknowledge</Button>}
            {a.status !== 'RESOLVED' && <Button disabled={busy === a.id} onClick={() => resolve(a)}>Resolve</Button>}
          </div>))}</div></Card>)}
      {next && <Button variant="secondary" onClick={() => load(true, next)}>Load more</Button>}
    </div>
  );
};
export default OpsAlerts;
