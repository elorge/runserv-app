import React, { useEffect, useState, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Check, X, Search, ShieldCheck, AlertTriangle, HelpCircle, UserMinus } from 'lucide-react';
import toast from 'react-hot-toast';
import { Card, Button, Modal, Input, Badge, Spinner, Pagination } from '@/components/common';
import { useAuthStore } from '@/store/authStore';
import { companyAPI, errMsg } from '@/services/api/company';
import { formatMoney } from '@/utils/money';
import { ROLE_LABEL, type StaffRow, type Department, type OrgRole } from '@/types/company';
import { PageHeader, Empty, fmtKm } from './ui';

const name = (s: StaffRow) => `${s.user.firstName} ${s.user.lastName}`;
const sel = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary-500';

/** What HR sees when a staff ID is checked against the company's directory. */
const MatchBadge: React.FC<{ s: StaffRow }> = ({ s }) => {
  if (s.directoryMatch === 'EXACT') return <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full"><ShieldCheck className="h-3.5 w-3.5" />Matches directory</span>;
  if (s.directoryMatch === 'NAME_MISMATCH') return <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full"><AlertTriangle className="h-3.5 w-3.5" />Name differs</span>;
  if (s.directoryMatch === 'EXITED') return <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700 bg-red-50 px-2 py-0.5 rounded-full"><AlertTriangle className="h-3.5 w-3.5" />Marked as left</span>;
  return <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-600 bg-gray-100 px-2 py-0.5 rounded-full"><HelpCircle className="h-3.5 w-3.5" />Not in directory</span>;
};

type Tab = 'requests' | 'staff' | 'delisted';

const StaffPage: React.FC = () => {
  const perms = useAuthStore((st) => st.user?.company?.permissions);
  const canManage = !!perms?.manageStaff; const canRoles = !!perms?.manageRoles;
  const [sp, setSp] = useSearchParams();
  const tab: Tab = canManage && sp.get('tab') === 'requests' ? 'requests' : sp.get('tab') === 'delisted' && canManage ? 'delisted' : 'staff';
  const [rows, setRows] = useState<StaffRow[]>([]); const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(''); const [page, setPage] = useState(1); const [pages, setPages] = useState(1);
  const [depts, setDepts] = useState<Department[]>([]); const [people, setPeople] = useState<StaffRow[]>([]);
  const [review, setReview] = useState<{ row: StaffRow; approve: boolean } | null>(null);
  const [delist, setDelist] = useState<StaffRow | null>(null); const [roleFor, setRoleFor] = useState<StaffRow | null>(null);
  const [edit, setEdit] = useState<StaffRow | null>(null);
  const [f, setF] = useState({ departmentId: '', supervisorId: '', limit: '30000', note: '', reason: 'RESIGNED', role: 'STAFF' as OrgRole });
  const [busy, setBusy] = useState(false);
  const currency = 'NGN';

  const load = useCallback(() => {
    setLoading(true);
    const q = tab === 'requests' ? { requests: true, page, limit: 20 } : { status: tab === 'delisted' ? 'DELISTED' : 'ACTIVE', search: search || undefined, page, limit: 20 };
    companyAPI.staff(q).then((r) => { setRows(r.employees); setPages(r.pagination.pages); }).catch((e) => toast.error(errMsg(e))).finally(() => setLoading(false));
  }, [tab, search, page]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [tab]);
  useEffect(() => { if (canManage) { companyAPI.departments().then(setDepts).catch(() => {}); companyAPI.staff({ status: 'ACTIVE', limit: 200 }).then((r) => setPeople(r.employees)).catch(() => {}); } }, [canManage]);

  const openReview = (row: StaffRow, approve: boolean) => {
    setF({ ...f, departmentId: row.directory?.departmentId ?? depts.find((d) => d.name.toLowerCase() === (row.claimedDepartment ?? '').toLowerCase())?.id ?? '', supervisorId: '', limit: '30000', note: '' });
    setReview({ row, approve });
  };
  const doReview = async () => {
    if (!review) return; setBusy(true);
    try {
      await companyAPI.reviewStaff(review.row.id, review.approve
        ? { approve: true, departmentId: f.departmentId || undefined, supervisorId: f.supervisorId || undefined, monthlyLimit: Number(f.limit) }
        : { approve: false, note: f.note || undefined });
      toast.success(review.approve ? 'Listed — they can now book on the company' : 'Request declined'); setReview(null); load();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const doDelist = async () => {
    if (!delist) return; setBusy(true);
    try { await companyAPI.delist(delist.id, f.reason); toast.success(`${name(delist)} delisted. They remain a Runserv customer.`); setDelist(null); load(); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const doRole = async () => {
    if (!roleFor) return; setBusy(true);
    try { await companyAPI.setRole(roleFor.id, f.role); toast.success('Role updated'); setRoleFor(null); load(); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const doEdit = async () => {
    if (!edit) return; setBusy(true);
    try { await companyAPI.updateStaff(edit.id, { monthlyLimit: Number(f.limit), departmentId: f.departmentId || undefined, supervisorId: f.supervisorId || null, staffNumber: edit.staffNumber ?? undefined }); toast.success('Saved'); setEdit(null); load(); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const supOptions = (excludeId?: string) => people.filter((p) => p.id !== excludeId);

  const tabs: [Tab, string][] = canManage ? [['requests', 'Join requests'], ['staff', 'Listed staff'], ['delisted', 'Delisted']] : [['staff', 'My team']];

  return (
    <div>
      <PageHeader title={canManage ? 'Staff' : 'My team'} subtitle={canManage ? 'Check each request against your staff directory, assign the department and supervisor, and delist people who leave.' : 'People in your department(s) and reporting to you'} />
      <div className="flex gap-1 mb-4 border-b border-gray-200">
        {tabs.map(([k, l]) => (
          <button key={k} onClick={() => setSp(k === 'staff' ? {} : { tab: k })} className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === k ? 'border-primary-600 text-primary-700' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>{l}</button>))}
      </div>
      {tab !== 'requests' && (
        <div className="relative mb-3 max-w-sm"><Search className="h-4 w-4 absolute left-3 top-2.5 text-gray-400" />
          <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search name or staff ID" className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" /></div>)}

      <Card padding={false}>
        {loading ? <div className="py-16 flex justify-center"><Spinner /></div> : rows.length === 0 ? (
          <Empty>{tab === 'requests' ? 'No pending requests. Staff ask to be listed from the Runserv app using your organisation code.' : tab === 'delisted' ? 'Nobody has been delisted.' : 'No staff yet.'}</Empty>
        ) : tab === 'requests' ? (
          <ul className="divide-y divide-gray-100">{rows.map((s) => (
            <li key={s.id} className="p-4">
              <div className="flex flex-wrap items-start gap-4">
                <div className="flex-1 min-w-[260px]">
                  <div className="flex items-center gap-2 flex-wrap"><p className="font-semibold text-gray-900">{name(s)}</p><MatchBadge s={s} /></div>
                  <p className="text-sm text-gray-500 mt-0.5">Staff ID <b className="font-mono text-gray-800">{s.staffNumber}</b>{s.claimedDepartment ? ` · says ${s.claimedDepartment}` : ''} · {s.user.email}</p>
                  {s.directory ? (
                    <div className="mt-2 rounded-lg bg-gray-50 border border-gray-100 px-3 py-2 text-sm">
                      <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-0.5">Your staff directory says</p>
                      <p className="text-gray-800"><b>{s.directory.fullName}</b>{s.directory.department ? ` · ${s.directory.department}` : ''}{s.directory.jobTitle ? ` · ${s.directory.jobTitle}` : ''}</p>
                    </div>) : <p className="text-xs text-amber-700 mt-2">This staff ID is not in your directory. Verify with your HR records before approving.</p>}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="success" onClick={() => openReview(s, true)}><Check className="h-3.5 w-3.5 inline mr-1" />Approve</Button>
                  <Button size="sm" variant="outline" onClick={() => openReview(s, false)}><X className="h-3.5 w-3.5 inline mr-1" />Decline</Button>
                </div>
              </div>
            </li>))}</ul>
        ) : (
          <div className="overflow-x-auto"><table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500"><tr>
              <th className="text-left px-4 py-2.5">Name</th><th className="text-left px-4 py-2.5">Staff ID</th><th className="text-left px-4 py-2.5">Department · cost centre</th><th className="text-left px-4 py-2.5">Supervisor</th>
              {tab === 'staff' ? <th className="text-left px-4 py-2.5">This month</th> : <th className="text-left px-4 py-2.5">Left</th>}<th className="text-right px-4 py-2.5"> </th></tr></thead>
            <tbody className="divide-y divide-gray-100">{rows.map((s) => (
              <tr key={s.id}>
                <td className="px-4 py-3"><p className="font-medium text-gray-900">{name(s)} {s.role !== 'STAFF' && <Badge variant="info" className="ml-1">{ROLE_LABEL[s.role]}</Badge>}</p><p className="text-xs text-gray-400">{s.user.phone ?? s.user.email}</p></td>
                <td className="px-4 py-3 font-mono text-xs">{s.staffNumber}</td>
                <td className="px-4 py-3">{s.department ? <>{s.department.name} <span className="text-xs text-gray-400 font-mono">{s.department.costCenter}</span></> : '—'}</td>
                <td className="px-4 py-3">{s.supervisor?.name ?? '—'}</td>
                {tab === 'staff' ? <td className="px-4 py-3"><Link className="text-primary-700 hover:underline" to={`/company/staff/${s.id}`}>{formatMoney(s.monthSpend, currency)}</Link><p className="text-xs text-gray-400">{s.monthTrips} trips · {fmtKm(s.monthDistanceKm)}{s.monthlyLimit > 0 ? ` · limit ${formatMoney(s.monthlyLimit, currency)}` : ''}</p></td>
                  : <td className="px-4 py-3 text-gray-500">{s.exitedAt ? new Date(s.exitedAt).toLocaleDateString('en-GB') : '—'}<p className="text-xs">{s.exitReason}</p></td>}
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  {tab === 'staff' && <Link to={`/company/staff/${s.id}`} className="text-sm text-primary-700 hover:underline mr-3">Audit</Link>}
                  {tab === 'staff' && canManage && <button className="text-sm text-gray-500 hover:text-gray-900 mr-3" onClick={() => { setF({ ...f, departmentId: s.department?.id ?? '', supervisorId: s.supervisor?.id ?? '', limit: String(s.monthlyLimit) }); setEdit(s); }}>Edit</button>}
                  {tab === 'staff' && canRoles && <button className="text-sm text-gray-500 hover:text-gray-900 mr-3" onClick={() => { setF({ ...f, role: s.role }); setRoleFor(s); }}>Role</button>}
                  {tab === 'staff' && canManage && <button className="text-sm text-red-500 hover:text-red-700" onClick={() => { setF({ ...f, reason: 'RESIGNED' }); setDelist(s); }}><UserMinus className="h-3.5 w-3.5 inline mr-0.5" />Delist</button>}
                </td></tr>))}</tbody></table></div>)}
      </Card>
      <Pagination currentPage={page} totalPages={pages} onPageChange={setPage} className="mt-4" />

      <Modal isOpen={!!review} onClose={() => setReview(null)} title={review?.approve ? 'List this staff member' : 'Decline request'}
        footer={<><Button variant="outline" onClick={() => setReview(null)}>Cancel</Button><Button variant={review?.approve ? 'success' : 'danger'} loading={busy} disabled={!!review?.approve && !f.departmentId} onClick={doReview}>{review?.approve ? 'Approve & list' : 'Decline'}</Button></>}>
        {review && (<div className="space-y-3">
          <div className="rounded-lg bg-gray-50 p-3 text-sm"><div className="flex items-center gap-2"><p className="font-semibold">{name(review.row)}</p><MatchBadge s={review.row} /></div><p className="text-gray-500">Staff ID <b className="font-mono">{review.row.staffNumber}</b></p></div>
          {review.approve ? (<>
            <label className="block"><span className="block text-sm font-medium text-gray-700 mb-1">Department (sets the cost centre)</span>
              <select className={sel} value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}><option value="">Choose…</option>{depts.filter((d) => d.isActive).map((d) => <option key={d.id} value={d.id}>{d.name} — {d.costCenter}</option>)}</select>
              {depts.length === 0 && <span className="text-xs text-amber-700">Create departments first (Departments page).</span>}</label>
            <label className="block"><span className="block text-sm font-medium text-gray-700 mb-1">Supervisor (defaults to the department head)</span>
              <select className={sel} value={f.supervisorId} onChange={(e) => setF({ ...f, supervisorId: e.target.value })}><option value="">Department head / from directory</option>{supOptions().map((p) => <option key={p.id} value={p.id}>{name(p)} · {p.staffNumber}</option>)}</select></label>
            <Input label={`Monthly allowance (${currency}) — 0 for none`} type="number" min={0} value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })} />
          </>) : <Input label="Reason (shown to the staff member, optional)" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={300} />}
        </div>)}
      </Modal>

      <Modal isOpen={!!delist} onClose={() => setDelist(null)} title="Delist staff member"
        footer={<><Button variant="outline" onClick={() => setDelist(null)}>Cancel</Button><Button variant="danger" loading={busy} onClick={doDelist}>Delist</Button></>}>
        {delist && (<div className="space-y-3 text-sm">
          <p><b>{name(delist)}</b> will no longer be able to book on the company account. Their trip history stays in your records, and they remain a normal Runserv customer.</p>
          <label className="block"><span className="block text-sm font-medium text-gray-700 mb-1">Reason</span>
            <select className={sel} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}>{['RESIGNED', 'TERMINATED', 'RETIRED', 'TRANSFERRED', 'CONTRACT_ENDED'].map((r) => <option key={r} value={r}>{r.replace('_', ' ').toLowerCase()}</option>)}</select></label>
        </div>)}
      </Modal>

      <Modal isOpen={!!roleFor} onClose={() => setRoleFor(null)} title="Portal role"
        footer={<><Button variant="outline" onClick={() => setRoleFor(null)}>Cancel</Button><Button loading={busy} onClick={doRole}>Save</Button></>}>
        {roleFor && (<div className="space-y-3 text-sm"><p>What can <b>{name(roleFor)}</b> do in this dashboard?</p>
          {(['STAFF', 'MANAGER', 'HR', 'FINANCE', 'ORG_ADMIN'] as OrgRole[]).map((r) => (
            <label key={r} className={`flex gap-3 p-3 rounded-lg border cursor-pointer ${f.role === r ? 'border-primary-500 bg-primary-50/40' : 'border-gray-200'}`}>
              <input type="radio" className="mt-1" checked={f.role === r} onChange={() => setF({ ...f, role: r })} />
              <span><span className="block font-medium">{ROLE_LABEL[r]}</span><span className="block text-xs text-gray-500">{{
                STAFF: 'App only — no dashboard access.', MANAGER: 'Sees the cost of their department(s) and direct reports; approves their trips.',
                HR: 'Staff directory, join requests, delisting, departments.', FINANCE: 'Costs, invoices, wallet and top-ups.', ORG_ADMIN: 'Everything, including roles, branding and policy.' }[r]}</span></span></label>))}
        </div>)}
      </Modal>

      <Modal isOpen={!!edit} onClose={() => setEdit(null)} title="Edit staff member"
        footer={<><Button variant="outline" onClick={() => setEdit(null)}>Cancel</Button><Button loading={busy} onClick={doEdit}>Save</Button></>}>
        {edit && (<div className="space-y-3">
          <label className="block"><span className="block text-sm font-medium text-gray-700 mb-1">Department</span>
            <select className={sel} value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}><option value="">—</option>{depts.map((d) => <option key={d.id} value={d.id}>{d.name} — {d.costCenter}</option>)}</select></label>
          <label className="block"><span className="block text-sm font-medium text-gray-700 mb-1">Supervisor</span>
            <select className={sel} value={f.supervisorId} onChange={(e) => setF({ ...f, supervisorId: e.target.value })}><option value="">None</option>{supOptions(edit.id).map((p) => <option key={p.id} value={p.id}>{name(p)} · {p.staffNumber}</option>)}</select></label>
          <Input label={`Monthly allowance (${currency}) — 0 for none`} type="number" min={0} value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })} />
        </div>)}
      </Modal>
    </div>
  );
};
export default StaffPage;
