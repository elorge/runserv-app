// The company's own staff list. HR uploads it (CSV); join requests are checked against it.
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Upload, Download, Search } from 'lucide-react';
import toast from 'react-hot-toast';
import { Card, Button, Badge, Spinner, Pagination, Alert } from '@/components/common';
import { companyAPI, errMsg } from '@/services/api/company';
import type { DirectoryEntry } from '@/types/company';
import { PageHeader, Empty } from './ui';

/** Minimal CSV parser (quoted fields, commas inside quotes, CRLF). */
const parseCsv = (text: string): string[][] => {
  const rows: string[][] = []; let row: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((x) => x.trim())) rows.push(row); row = []; }
    else cur += c;
  }
  row.push(cur); if (row.some((x) => x.trim())) rows.push(row);
  return rows;
};
const HEADERS: Record<string, string> = {
  'staff id': 'staffNumber', 'staffid': 'staffNumber', 'staff number': 'staffNumber', 'staff_id': 'staffNumber', 'employee id': 'staffNumber', 'id': 'staffNumber',
  'name': 'fullName', 'full name': 'fullName', 'fullname': 'fullName', 'employee name': 'fullName',
  'department': 'department', 'dept': 'department', 'job title': 'jobTitle', 'title': 'jobTitle', 'position': 'jobTitle',
  'supervisor id': 'supervisorStaffNumber', 'supervisor': 'supervisorStaffNumber', 'manager id': 'supervisorStaffNumber', 'email': 'email', 'phone': 'phone',
};
const TEMPLATE = 'Staff ID,Full name,Department,Job title,Supervisor ID,Email,Phone\nEMP-001,Ada Chinwe Obi,Sales,Account Officer,EMP-000,ada@company.com,08012345678\n';

const DirectoryPage: React.FC = () => {
  const [rows, setRows] = useState<DirectoryEntry[]>([]); const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(''); const [page, setPage] = useState(1); const [pages, setPages] = useState(1); const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false); const [result, setResult] = useState<Awaited<ReturnType<typeof companyAPI.importDirectory>> | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(() => { setLoading(true); companyAPI.directory({ search: search || undefined, page }).then((r) => { setRows(r.entries); setPages(r.pagination.pages); setTotal(r.pagination.total); }).catch((e) => toast.error(errMsg(e))).finally(() => setLoading(false)); }, [search, page]);
  useEffect(() => { load(); }, [load]);

  const onFile = async (f?: File) => {
    if (!f) return;
    const table = parseCsv(await f.text());
    if (table.length < 2) return toast.error('The file is empty.');
    const map = table[0].map((h) => HEADERS[h.trim().toLowerCase()]);
    if (!map.includes('staffNumber') || !map.includes('fullName')) return toast.error('The first row must include “Staff ID” and “Full name” columns.');
    const data = table.slice(1).map((r) => Object.fromEntries(map.map((k, i) => [k, (r[i] ?? '').trim()]).filter(([k]) => k)));
    setBusy(true);
    try { setResult(await companyAPI.importDirectory(data)); toast.success('Directory imported'); load(); } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); if (file.current) file.current.value = ''; }
  };
  const exited = async (e: DirectoryEntry) => {
    if (!window.confirm(`Mark ${e.fullName} as having left? If they are listed in the app they will be delisted.`)) return;
    try { await companyAPI.markExited(e.id, 'RESIGNED'); toast.success('Marked as left'); load(); } catch (err) { toast.error(errMsg(err)); }
  };
  const template = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([TEMPLATE], { type: 'text/csv' })); a.download = 'staff-directory-template.csv'; a.click(); };

  return (
    <div>
      <PageHeader title="Staff directory" subtitle="Your own list of staff. When someone asks to be listed, Runserv checks their staff ID and name against it so HR can approve with confidence."
        right={<><Button variant="outline" onClick={template}><Download className="h-4 w-4 inline mr-1.5" />Template</Button>
          <Button loading={busy} onClick={() => file.current?.click()}><Upload className="h-4 w-4 inline mr-1.5" />Import CSV</Button>
          <input ref={file} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} /></>} />
      {result && (
        <Alert variant={result.skipped.length ? 'warning' : 'success'} className="mb-4" title="Import finished">
          {result.created} added · {result.updated} updated{result.departmentsCreated ? ` · ${result.departmentsCreated} department(s) created` : ''}.
          {result.skipped.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs">{result.skipped.slice(0, 6).map((s) => <li key={s.row}>Row {s.row}: {s.reason}</li>)}{result.skipped.length > 6 && <li>…and {result.skipped.length - 6} more</li>}</ul>}
        </Alert>)}
      <div className="relative mb-3 max-w-sm"><Search className="h-4 w-4 absolute left-3 top-2.5 text-gray-400" />
        <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search name or staff ID" className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" /></div>
      <Card padding={false}>
        {loading ? <div className="py-16 flex justify-center"><Spinner /></div> : rows.length === 0 ? <Empty>Your directory is empty. Import a CSV with Staff ID, Full name, Department, Job title and Supervisor ID.</Empty> : (
          <div className="overflow-x-auto"><table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500"><tr><th className="text-left px-4 py-2.5">Staff ID</th><th className="text-left px-4 py-2.5">Name</th><th className="text-left px-4 py-2.5">Department</th><th className="text-left px-4 py-2.5">Job title</th><th className="text-left px-4 py-2.5">Supervisor ID</th><th className="text-left px-4 py-2.5">Status</th><th /></tr></thead>
            <tbody className="divide-y divide-gray-100">{rows.map((e) => (
              <tr key={e.id}><td className="px-4 py-2.5 font-mono text-xs">{e.staffNumber}</td><td className="px-4 py-2.5 font-medium">{e.fullName}</td><td className="px-4 py-2.5">{e.department?.name ?? '—'}</td><td className="px-4 py-2.5">{e.jobTitle ?? '—'}</td><td className="px-4 py-2.5 font-mono text-xs">{e.supervisorStaffNumber ?? '—'}</td>
                <td className="px-4 py-2.5">{e.status === 'EXITED' ? <Badge>Left</Badge> : e.onRunserv ? <Badge variant="success">Listed in app</Badge> : <Badge variant="default">Not yet in app</Badge>}</td>
                <td className="px-4 py-2.5 text-right">{e.status === 'ACTIVE' && <button onClick={() => exited(e)} className="text-xs text-red-500 hover:text-red-700">Mark as left</button>}</td></tr>))}</tbody></table></div>)}
      </Card>
      <p className="text-xs text-gray-400 mt-2">{total} people in your directory</p>
      <Pagination currentPage={page} totalPages={pages} onPageChange={setPage} className="mt-2" />
    </div>
  );
};
export default DirectoryPage;
