// Audit log viewer (read-only). Super Admin / Admin; the API enforces it and redacts secret-looking fields.
import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { ScrollText } from 'lucide-react';
import { Button, Card, Spinner } from '@/components/common';
import { apiError } from '@/services/api/partnerships';
import { auditAPI, AuditRow } from '@/services/api/finance';

const AuditLog: React.FC = () => {
  const [items, setItems] = useState<AuditRow[]>([]); const [next, setNext] = useState<string | null>(null);
  const [f, setF] = useState({ action: '', entityType: '', entityId: '', userId: '', from: '', to: '' });
  const [facets, setFacets] = useState<{ actions: string[]; entityTypes: string[] }>({ actions: [], entityTypes: [] });
  const [loading, setLoading] = useState(true); const [err, setErr] = useState(''); const [open, setOpen] = useState<string | null>(null);

  const params = (cursor?: string | null) => ({ action: f.action || undefined, entityType: f.entityType || undefined, entityId: f.entityId || undefined, userId: f.userId || undefined, from: f.from ? new Date(f.from).toISOString() : undefined, to: f.to ? new Date(f.to + 'T23:59:59').toISOString() : undefined, cursor: cursor || undefined });
  const load = useCallback(async (more = false, cursor?: string | null) => {
    setLoading(!more); setErr('');
    try { const r = await auditAPI.list(params(more ? cursor : null)); setItems((p) => (more ? [...p, ...r.items] : r.items)); setNext(r.nextCursor); }
    catch (e: any) { setErr(e?.response?.status === 403 ? 'You do not have permission to view the audit log.' : apiError(e)); }
    finally { setLoading(false); }
    // eslint-disable-next-line
  }, [f]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { auditAPI.facets().then(setFacets).catch(() => {}); }, []);

  const exportCsv = async () => {
    if (!window.confirm('Export up to 5,000 rows matching these filters? The export is itself recorded in the audit log.')) return;
    try { const b = await auditAPI.exportCsv(params()); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'audit-log.csv'; a.click(); } catch (e) { toast.error(apiError(e)); }
  };
  const inp = 'border rounded px-2 py-1 text-sm';
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3"><ScrollText className="w-6 h-6 text-primary-600" /><h1 className="text-2xl font-bold">Audit log</h1><div className="ml-auto"><Button variant="secondary" onClick={exportCsv}>Export CSV</Button></div></div>
      <Card><div className="p-4 flex flex-wrap gap-2">
        <select className={inp} value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })}><option value="">All actions</option>{facets.actions.map((a) => <option key={a}>{a}</option>)}</select>
        <select className={inp} value={f.entityType} onChange={(e) => setF({ ...f, entityType: e.target.value })}><option value="">All entities</option>{facets.entityTypes.map((a) => <option key={a}>{a}</option>)}</select>
        <input className={inp} placeholder="Entity id" value={f.entityId} onChange={(e) => setF({ ...f, entityId: e.target.value })} />
        <input className={inp} placeholder="Actor user id" value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })} />
        <input type="date" className={inp} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /><input type="date" className={inp} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
      </div></Card>
      {loading ? <div className="py-16 flex justify-center"><Spinner /></div> : err ? <Card><div className="p-6 text-red-600">{err}</div></Card> : items.length === 0 ? <Card><div className="p-6 text-gray-500">No audit entries match.</div></Card> : (
        <Card><div className="divide-y">{items.map((r) => (
          <div key={r.id} className="p-3 text-sm">
            <div className="flex flex-wrap gap-3 items-center cursor-pointer" onClick={() => setOpen(open === r.id ? null : r.id)}>
              <span className="text-gray-500 whitespace-nowrap">{new Date(r.createdAt).toLocaleString()}</span>
              <span className="font-medium">{r.action}</span><span className="text-gray-600">{r.entityType}{r.entityId ? ` · ${r.entityId.slice(0, 8)}` : ''}</span>
              <span className="ml-auto text-gray-500">{r.user ? `${r.user.firstName ?? ''} ${r.user.lastName ?? ''} (${r.user.role})` : r.userId || 'system'}</span>
            </div>
            {open === r.id && <pre className="mt-2 bg-gray-50 p-2 rounded text-xs overflow-auto">{JSON.stringify({ entityId: r.entityId, ip: r.ipAddress, details: r.details }, null, 2)}</pre>}
          </div>))}</div></Card>)}
      {next && <Button variant="secondary" onClick={() => load(true, next)}>Load more</Button>}
    </div>
  );
};
export default AuditLog;
