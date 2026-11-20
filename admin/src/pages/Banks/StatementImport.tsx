// Upload a bank statement (CSV) for one Runserv receiving account. Each file can be imported once; every credit in it
// is recorded as "pending review" and a second admin approves it on the Approvals page.
import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FileUp } from 'lucide-react';
import { Button, Card } from '@/components/common';
import { bankAdminAPI, apiError } from '@/services/api/partnerships';
import type { BankAccount, BankPartner } from '@/types/partnerships';
import type { StatementImportRow } from '@/services/api/partnerships';
import { PageHeader, Field, selectCls } from '@/components/features/partnerships';

const MAX = 2 * 1024 * 1024;

const StatementImport: React.FC = () => {
  const [banks, setBanks] = useState<BankPartner[]>([]); const [accounts, setAccounts] = useState<BankAccount[]>([]); const [history, setHistory] = useState<StatementImportRow[]>([]);
  const [bankId, setBankId] = useState(''); const [acctId, setAcctId] = useState(''); const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false); const [result, setResult] = useState<any>(null);

  const loadHistory = () => bankAdminAPI.statements().then(setHistory).catch(() => undefined);
  useEffect(() => { bankAdminAPI.partners().then(setBanks).catch((e) => toast.error(apiError(e))); bankAdminAPI.accounts().then(setAccounts).catch(() => undefined); loadHistory(); }, []);
  const myAccts = accounts.filter((a) => a.bankPartnerId === bankId && a.isActive);

  const pick = async (f?: File | null) => {
    setResult(null); if (!f) return setFile(null);
    if (f.size > MAX) { toast.error('The file is larger than 2 MB. Split it by month.'); return; }
    if (!/\.csv$/i.test(f.name)) { toast.error('Please choose a .csv file.'); return; }
    setFile({ name: f.name, text: await f.text() });
  };
  const submit = async () => {
    if (!file || !bankId || !acctId) return;
    if (!window.confirm(`Import ${file.name}? Every credit becomes a pending entry that a second admin must approve.`)) return;
    setBusy(true);
    try { setResult(await bankAdminAPI.importStatement({ bankPartnerId: bankId, receivingAccountId: acctId, fileName: file.name, csvText: file.text })); toast.success('Statement imported'); setFile(null); loadHistory(); }
    catch (e) { toast.error(apiError(e)); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-5">
      <PageHeader icon={FileUp} color="bg-blue-100 text-blue-600" title="Import bank statement" subtitle="CSV only, up to 2 MB. The same file cannot be imported twice." />
      <Card>
        <div className="p-5 grid md:grid-cols-2 gap-4">
          <Field label="Bank"><select className={selectCls} value={bankId} onChange={(e) => { setBankId(e.target.value); setAcctId(''); }}><option value="">Choose…</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.displayName}</option>)}</select></Field>
          <Field label="Runserv account this statement is for"><select className={selectCls} value={acctId} onChange={(e) => setAcctId(e.target.value)} disabled={!bankId}><option value="">Choose…</option>{myAccts.map((a) => <option key={a.id} value={a.id}>{a.accountNumber} · {a.accountName} ({a.currency})</option>)}</select></Field>
          <div className="md:col-span-2"><Field label="Statement file"><input type="file" accept=".csv,text/csv" onChange={(e) => pick(e.target.files?.[0])} /></Field>{file && <p className="text-xs text-gray-500 mt-1">{file.name} · {Math.round(file.text.length / 1024)} KB ready</p>}</div>
          <div className="md:col-span-2"><Button onClick={submit} disabled={busy || !file || !bankId || !acctId}>{busy ? 'Importing…' : 'Import'}</Button></div>
        </div>
        {result && <pre className="m-5 mt-0 p-3 bg-gray-50 border rounded text-xs overflow-x-auto">{JSON.stringify(result, null, 2)}</pre>}
      </Card>
      <Card>
        <div className="px-5 pt-4 pb-2"><h3 className="font-semibold">Previous imports</h3></div>
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-gray-500 border-b"><th className="p-3">When</th><th>File</th><th>Bank</th></tr></thead>
          <tbody>{history.map((h) => <tr key={h.id} className="border-b last:border-0"><td className="p-3">{new Date(h.createdAt).toLocaleString()}</td><td>{h.fileName ?? '—'}</td><td>{banks.find((b) => b.id === h.bankPartnerId)?.displayName ?? '—'}</td></tr>)}{!history.length && <tr><td colSpan={3} className="p-8 text-center text-gray-500">No imports yet.</td></tr>}</tbody></table></div>
      </Card>
    </div>
  );
};
export default StatementImport;
