// Reconciliation: upload a provider statement CSV (reference, amount, currency, status); differences become exceptions.
import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Card } from '@/components/common';
import api from '@/services/api';
import { errMsg, statementFromCsv, StatementRow } from './shared';

interface Run { id: string; provider: string; periodFrom: string; periodTo: string; source: string; matched: number; mismatched: number; missingHere: number; missingThere: number; createdAt: string }

const day = (d: Date) => d.toISOString().slice(0, 10);

const ReconciliationTab: React.FC<{ isSuper: boolean; onChanged: () => void }> = ({ isSuper, onChanged }) => {
  const [runs, setRuns] = useState<Run[]>([]);
  const [from, setFrom] = useState(day(new Date(Date.now() - 86400000)));
  const [to, setTo] = useState(day(new Date()));
  const [rows, setRows] = useState<StatementRow[]>([]);
  const [fileName, setFileName] = useState('');
  const [fileError, setFileError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<null | Record<string, number>>(null);

  const load = useCallback(() => { api.get('/admin/payment-ops/reconciliation').then(r => setRuns(r.data.data.runs)).catch(() => toast.error('Failed to load reconciliation runs')); }, []);
  useEffect(() => { load(); }, [load]);

  const onFile = async (f: File | undefined) => {
    setRows([]); setFileError(''); setResult(null); setFileName(f?.name || '');
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { setFileError('File is larger than 5 MB.'); return; }
    const parsed = statementFromCsv(await f.text());
    if (parsed.error) setFileError(parsed.error); else setRows(parsed.rows);
  };

  const run = async () => {
    if (!rows.length) return;
    setBusy(true);
    try {
      // Whole days, Lagos-agnostic: from start of first day to end of last day (UTC); widen by a day if your statement spans midnight.
      const r = await api.post('/admin/payment-ops/reconciliation', { provider: 'mtn_momo', periodFrom: `${from}T00:00:00.000Z`, periodTo: `${to}T23:59:59.999Z`, source: `statement:${fileName}`.slice(0, 200), rows });
      setResult(r.data.data); toast.success('Reconciliation complete'); load(); onChanged();
    } catch (err) { toast.error(errMsg(err, 'Reconciliation failed')); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-6">
      {isSuper && (
        <Card>
          <h2 className="font-semibold mb-1">Upload MTN statement</h2>
          <p className="text-sm text-gray-500 mb-3">CSV with columns <code>reference</code>, <code>amount</code>, <code>status</code> and (optionally) <code>currency</code>. Nothing is changed in the payments themselves — differences are raised in the exceptions queue.</p>
          <div className="flex flex-wrap items-end gap-3 text-sm">
            <label>From<input type="date" className="block border rounded-lg p-2" value={from} onChange={e => setFrom(e.target.value)} /></label>
            <label>To<input type="date" className="block border rounded-lg p-2" value={to} onChange={e => setTo(e.target.value)} /></label>
            <label>Statement file<input type="file" accept=".csv,text/csv" className="block text-sm" onChange={e => onFile(e.target.files?.[0])} /></label>
            <button disabled={busy || !rows.length || from > to} onClick={run} className="px-4 py-2 rounded-xl bg-gray-900 text-white disabled:opacity-50">{busy ? 'Running…' : `Run reconciliation${rows.length ? ` (${rows.length} rows)` : ''}`}</button>
          </div>
          {fileError && <p className="text-sm text-red-600 mt-2">{fileError}</p>}
          {result && <p className="text-sm mt-3">Matched <b>{result.matched}</b> · Mismatched <b>{result.mismatched}</b> · Missing in Runserv <b>{result.missingHere}</b> · Missing at provider <b>{result.missingThere}</b></p>}
        </Card>)}
      <Card padding={false}>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-gray-500 border-b"><th className="p-3">Run</th><th>Period</th><th>Source</th><th>Matched</th><th>Mismatch</th><th>Missing here</th><th>Missing there</th></tr></thead>
          <tbody>
            {runs.map(r => <tr key={r.id} className="border-b last:border-0"><td className="p-3">{new Date(r.createdAt).toLocaleString()}</td><td>{day(new Date(r.periodFrom))} → {day(new Date(r.periodTo))}</td><td className="max-w-[16rem] truncate">{r.source}</td><td>{r.matched}</td><td className={r.mismatched ? 'text-red-600 font-semibold' : ''}>{r.mismatched}</td><td className={r.missingHere ? 'text-red-600 font-semibold' : ''}>{r.missingHere}</td><td className={r.missingThere ? 'text-red-600 font-semibold' : ''}>{r.missingThere}</td></tr>)}
            {runs.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-gray-400">No reconciliation runs yet.</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
};
export default ReconciliationTab;
