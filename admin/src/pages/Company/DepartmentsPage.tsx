import React, { useEffect, useState, useCallback } from 'react';
import { Plus } from 'lucide-react';
import toast from 'react-hot-toast';
import { Card, Button, Modal, Input, Spinner, Badge } from '@/components/common';
import { useAuthStore } from '@/store/authStore';
import { companyAPI, errMsg } from '@/services/api/company';
import { formatMoney } from '@/utils/money';
import type { Department, StaffRow } from '@/types/company';
import { PageHeader, Empty } from './ui';

const blank = { name: '', costCenter: '', monthlyBudget: '', maxTripAmount: '', approvalThreshold: '', headEmployeeId: '' };

const DepartmentsPage: React.FC = () => {
  const canManage = !!useAuthStore((s) => s.user?.company?.permissions.manageStaff);
  const [rows, setRows] = useState<Department[]>([]); const [people, setPeople] = useState<StaffRow[]>([]);
  const [loading, setLoading] = useState(true); const [edit, setEdit] = useState<Department | 'new' | null>(null);
  const [f, setF] = useState(blank); const [busy, setBusy] = useState(false);

  const load = useCallback(() => { setLoading(true); companyAPI.departments().then(setRows).catch((e) => toast.error(errMsg(e))).finally(() => setLoading(false)); }, []);
  useEffect(() => { load(); if (canManage) companyAPI.staff({ status: 'ACTIVE', limit: 200 }).then((r) => setPeople(r.employees)).catch(() => {}); }, [load, canManage]);

  const open = (d: Department | 'new') => {
    setF(d === 'new' ? blank : { name: d.name, costCenter: d.costCenter, monthlyBudget: d.monthlyBudget?.toString() ?? '', maxTripAmount: d.maxTripAmount?.toString() ?? '', approvalThreshold: d.approvalThreshold?.toString() ?? '', headEmployeeId: d.head?.id ?? '' });
    setEdit(d);
  };
  const save = async () => {
    setBusy(true);
    try {
      await companyAPI.saveDepartment(edit === 'new' || !edit ? null : edit.id, { ...f, headEmployeeId: f.headEmployeeId || null });
      toast.success('Department saved'); setEdit(null); load();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <div>
      <PageHeader title="Departments & cost centres" subtitle="Each department has a cost centre, an optional monthly transport budget and a head who sees its costs and approves its trips."
        right={canManage ? <Button onClick={() => open('new')}><Plus className="h-4 w-4 inline mr-1" />New department</Button> : undefined} />
      {loading ? <div className="py-16 flex justify-center"><Spinner /></div> : rows.length === 0 ? <Card><Empty>No departments yet. Add them here, or import your staff directory and they are created for you.</Empty></Card> : (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {rows.map((d) => (
            <Card key={d.id}>
              <div className="flex items-start justify-between gap-2">
                <div><h3 className="font-semibold text-gray-900">{d.name}</h3><p className="text-xs text-gray-400 font-mono mt-0.5">{d.costCenter}</p></div>
                {!d.isActive && <Badge>Inactive</Badge>}
              </div>
              <p className="text-sm text-gray-600 mt-2">Head: <b>{d.head?.name ?? '— none —'}</b> · {d.staffCount} staff</p>
              <div className="mt-3">
                <div className="flex justify-between text-sm"><span className="text-gray-500">This month</span><b className="tabular-nums">{formatMoney(d.monthSpend, 'NGN')}</b></div>
                {d.monthlyBudget != null && (<><div className="h-1.5 rounded bg-gray-100 overflow-hidden mt-1.5"><div className={`h-full ${d.monthSpend / d.monthlyBudget > 0.9 ? 'bg-red-500' : 'bg-primary-500'}`} style={{ width: `${Math.min(100, (d.monthSpend / d.monthlyBudget) * 100)}%` }} /></div>
                  <p className="text-[11px] text-gray-400 mt-0.5">{Math.round((d.monthSpend / d.monthlyBudget) * 100)}% of {formatMoney(d.monthlyBudget, 'NGN')}</p></>)}
              </div>
              {(d.maxTripAmount != null || d.approvalThreshold != null) && <p className="text-xs text-gray-400 mt-2">{d.maxTripAmount != null && `Trip cap ${formatMoney(d.maxTripAmount, 'NGN')}`}{d.maxTripAmount != null && d.approvalThreshold != null && ' · '}{d.approvalThreshold != null && `Approval above ${formatMoney(d.approvalThreshold, 'NGN')}`}</p>}
              {canManage && <button onClick={() => open(d)} className="mt-3 text-sm text-primary-700 hover:underline">Edit</button>}
            </Card>))}
        </div>)}

      <Modal isOpen={!!edit} onClose={() => setEdit(null)} title={edit === 'new' ? 'New department' : 'Edit department'}
        footer={<><Button variant="outline" onClick={() => setEdit(null)}>Cancel</Button><Button loading={busy} disabled={!f.name.trim()} onClick={save}>Save</Button></>}>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3"><Input label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /><Input label="Cost centre code" value={f.costCenter} onChange={(e) => setF({ ...f, costCenter: e.target.value })} placeholder="e.g. CC-1040" /></div>
          <label className="block"><span className="block text-sm font-medium text-gray-700 mb-1">Department head / manager</span>
            <select className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white" value={f.headEmployeeId} onChange={(e) => setF({ ...f, headEmployeeId: e.target.value })}><option value="">None</option>{people.map((p) => <option key={p.id} value={p.id}>{p.user.firstName} {p.user.lastName} · {p.staffNumber}</option>)}</select>
            <span className="text-xs text-gray-400">The head sees this department’s costs and approves its trips. They are given the Manager role automatically.</span></label>
          <Input label="Monthly transport budget (blank = none)" type="number" min={0} value={f.monthlyBudget} onChange={(e) => setF({ ...f, monthlyBudget: e.target.value })} />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Max cost per trip (blank = company rule)" type="number" min={0} value={f.maxTripAmount} onChange={(e) => setF({ ...f, maxTripAmount: e.target.value })} />
            <Input label="Needs approval above (blank = company rule)" type="number" min={0} value={f.approvalThreshold} onChange={(e) => setF({ ...f, approvalThreshold: e.target.value })} /></div>
        </div>
      </Modal>
    </div>
  );
};
export default DepartmentsPage;
