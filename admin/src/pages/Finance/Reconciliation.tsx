// Finance > Reconciliation & ledger: wallet balances vs the append-only ledger. Super Admin / Admin only (API enforces it).
import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Scale } from 'lucide-react';
import { Button, Card, Spinner } from '@/components/common';
import { apiError } from '@/services/api/partnerships';
import { financeAPI, ReconRun, LedgerRow } from '@/services/api/finance';

const tone = (s: string) => (s === 'OK' ? 'bg-green-100 text-green-700' : s === 'RUNNING' ? 'bg-blue-100 text-blue-700' : 'bg-red-100 text-red-700');

const Reconciliation: React.FC = () => {
  const [run, setRun] = useState<ReconRun | null>(null); const [runs, setRuns] = useState<ReconRun[]>([]); const [next, setNext] = useState<string | null>(null);
  const [rows, setRows] = useState<LedgerRow[]>([]); const [lNext, setLNext] = useState<string | null>(null);
  const [account, setAccount] = useState(''); const [refType, setRefType] = useState('');
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try { const [l, h] = await Promise.all([financeAPI.latest(), financeAPI.runs()]); setRun(l); setRuns(h.items); setNext(h.nextCursor); }
    catch (e: any) { setErr(e?.response?.status === 403 ? 'You do not have permission to view finance reconciliation.' : apiError(e)); }
    finally { setLoading(false); }
  }, []);
  const loadLedger = async (more = false) => {
    try { const r = await financeAPI.ledger({ account: account || undefined, refType: refType || undefined, cursor: more ? lNext || undefined : undefined }); setRows(more ? [...rows, ...r.items] : r.items); setLNext(r.nextCursor); }
    catch (e) { toast.error(apiError(e)); }
  };
  useEffect(() => { load(); loadLedger(); /* eslint-disable-next-line */ }, [load]);

  const start = async () => {
    if (!window.confirm('Run a reconciliation now? It reads every wallet and the ledger; it changes no balances.')) return;
    setBusy(true); try { const r = await financeAPI.start(); toast.success(`Reconciliation ${r.status}`); load(); } catch (e) { toast.error(apiError(e)); } finally { setBusy(false); }
  };
  const more = async () => { if (!next) return; try { const h = await financeAPI.runs(next); setRuns([...runs, ...h.items]); setNext(h.nextCursor); } catch (e) { toast.error(apiError(e)); } };
  const exportCsv = () => {
    const head = 'createdAt,account,direction,amount,currency,refType,refId,memo\n';
    const body = rows.map((r) => [r.createdAt, r.account, r.direction, r.amount, r.currency, r.refType, r.refId, (r.memo || '').replace(/[",\n]/g, ' ')].join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([head + body], { type: 'text/csv' })); a.download = 'ledger.csv'; a.click();
  };

  if (loading) return <div className="py-16 flex justify-center"><Spinner /></div>;
  if (err) return <Card><div className="p-6 text-red-600">{err}</div></Card>;
  const ex = run?.exceptions || [];
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3"><Scale className="w-6 h-6 text-primary-600" /><h1 className="text-2xl font-bold">Reconciliation &amp; ledger</h1>
        <div className="ml-auto"><Button onClick={start} disabled={busy}>{busy ? 'Running…' : 'Run reconciliation'}</Button></div></div>
      <Card><div className="p-5 space-y-3">
        {!run ? <p className="text-gray-500">No reconciliation has run yet.</p> : (<>
          <div className="flex flex-wrap items-center gap-3"><span className={`px-2 py-0.5 rounded text-xs font-semibold ${tone(run.status)}`}>{run.status}</span>
            <span className="text-sm text-gray-500">{new Date(run.startedAt).toLocaleString()} · {run.trigger}</span></div>
          {run.error && <div className="text-red-600 text-sm">{run.error}</div>}
          {run.summary && <div className="text-sm text-gray-700">{run.summary.walletsChecked} wallets · {run.summary.companiesChecked} company wallets · {run.summary.exceptionCount} exceptions
            {Object.entries(run.summary.liabilitiesByCurrency || {}).map(([c, v]: any) => <div key={c}>Liability {c}: wallets {v.walletBalances}, pending payouts {v.pendingPayouts}</div>)}</div>}
          {ex.length > 0 && <table className="w-full text-sm"><thead><tr className="text-left text-gray-500"><th>Exceptions</th><th>Kind</th><th>Id</th><th>Balance</th><th>Ledger</th><th>Variance</th></tr></thead><tbody>
            {ex.map((x, i) => <tr key={i} className="border-t"><td>{x.type}</td><td>{x.kind}</td><td className="font-mono text-xs">{x.id}</td><td>{x.balance ?? ''} {x.currency}</td><td>{x.ledger ?? '—'}</td><td className="text-red-600">{x.variance ?? ''}</td></tr>)}</tbody></table>}
          {run.status === 'OK' && <p className="text-green-700 text-sm">Every wallet equals its ledger. No exceptions.</p>}
        </>)}</div></Card>
      <Card><div className="p-5"><h3 className="font-semibold mb-2">Run history</h3>
        {runs.length === 0 ? <p className="text-gray-500 text-sm">No runs.</p> : runs.map((r) => <div key={r.id} className="flex gap-3 text-sm border-t py-1.5"><span className={`px-2 rounded text-xs ${tone(r.status)}`}>{r.status}</span><span>{new Date(r.startedAt).toLocaleString()}</span><span className="text-gray-500">{r.trigger}</span><span className="ml-auto">{r.summary?.exceptionCount ?? ''} exceptions</span></div>)}
        {next && <Button variant="secondary" onClick={more}>Load more</Button>}</div></Card>
      <Card><div className="p-5 space-y-3"><div className="flex flex-wrap gap-2 items-center"><h3 className="font-semibold">Ledger</h3>
        <input className="border rounded px-2 py-1 text-sm" placeholder="Account e.g. WALLET:id" value={account} onChange={(e) => setAccount(e.target.value)} />
        <input className="border rounded px-2 py-1 text-sm" placeholder="Reference type" value={refType} onChange={(e) => setRefType(e.target.value)} />
        <Button variant="secondary" onClick={() => loadLedger()}>Filter</Button><Button variant="secondary" onClick={exportCsv} disabled={!rows.length}>Export CSV</Button></div>
        {rows.length === 0 ? <p className="text-gray-500 text-sm">No ledger entries match.</p> : <table className="w-full text-sm"><tbody>
          {rows.map((r) => <tr key={r.id} className="border-t"><td className="whitespace-nowrap">{new Date(r.createdAt).toLocaleString()}</td><td className="font-mono text-xs">{r.account}</td><td>{r.direction}</td><td>{r.amount} {r.currency}</td><td>{r.refType}</td><td className="font-mono text-xs">{r.refId}</td></tr>)}</tbody></table>}
        {lNext && <Button variant="secondary" onClick={() => loadLedger(true)}>Load more</Button>}</div></Card>
    </div>
  );
};
export default Reconciliation;
