import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus } from 'lucide-react';
import { Button, Card, Modal } from '@/components/common';
import { fleetPortalAPI, VehicleInput } from '@/services/api/fleetPortal';
import { FleetPage, Loading, LoadError, Pager, StatusBadge, ComplianceChips, EmptyRow, Th, Field, fieldCls, selectCls, apiError, label, useFleet, useLoad } from './shared';

const STATUSES = ['', 'PENDING', 'ACTIVE', 'SUSPENDED', 'MAINTENANCE', 'RETIRED'];
const TYPES = ['CAR', 'MOTORCYCLE', 'VAN'];
const blank = { vehicleType: 'CAR', make: '', model: '', registrationNumber: '', modelYear: '', colour: '', seatingCapacity: '', insuranceExpiresAt: '', roadworthyExpiresAt: '', permitExpiresAt: '' };

export const AddVehicleModal: React.FC<{ open: boolean; onClose: () => void; onDone: () => void }> = ({ open, onClose, onDone }) => {
  const [f, setF] = useState(blank); const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const ok = f.make.trim() && f.model.trim() && f.registrationNumber.trim().length >= 4;
  const submit = async () => {
    setBusy(true);
    try {
      const body: VehicleInput = { vehicleType: f.vehicleType, make: f.make.trim(), model: f.model.trim(), registrationNumber: f.registrationNumber.trim() };
      if (f.modelYear) body.modelYear = Number(f.modelYear);
      if (f.colour.trim()) body.colour = f.colour.trim();
      if (f.seatingCapacity) body.seatingCapacity = Number(f.seatingCapacity);
      for (const k of ['insuranceExpiresAt', 'roadworthyExpiresAt', 'permitExpiresAt'] as const) if (f[k]) body[k] = f[k];
      await fleetPortalAPI.createVehicle(body);
      toast.success('Vehicle added. Runserv will review it before it can take jobs.'); setF(blank); onDone();
    } catch (e) { toast.error(apiError(e)); } finally { setBusy(false); }
  };
  return (
    <Modal isOpen={open} onClose={onClose} title="Add a vehicle" size="lg"
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!ok} onClick={submit}>Add vehicle</Button></>}>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <Field label="Type"><select className={fieldCls} value={f.vehicleType} onChange={set('vehicleType')}>{TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field>
        <Field label="Registration number"><input className={fieldCls} value={f.registrationNumber} onChange={set('registrationNumber')} placeholder="LND123AA" /></Field>
        <Field label="Make"><input className={fieldCls} value={f.make} onChange={set('make')} placeholder="Toyota" /></Field>
        <Field label="Model"><input className={fieldCls} value={f.model} onChange={set('model')} placeholder="Corolla" /></Field>
        <Field label="Year"><input className={fieldCls} type="number" value={f.modelYear} onChange={set('modelYear')} /></Field>
        <Field label="Colour"><input className={fieldCls} value={f.colour} onChange={set('colour')} /></Field>
        <Field label="Seats"><input className={fieldCls} type="number" value={f.seatingCapacity} onChange={set('seatingCapacity')} /></Field>
        <span />
        <Field label="Insurance expires"><input className={fieldCls} type="date" value={f.insuranceExpiresAt} onChange={set('insuranceExpiresAt')} /></Field>
        <Field label="Roadworthiness expires"><input className={fieldCls} type="date" value={f.roadworthyExpiresAt} onChange={set('roadworthyExpiresAt')} /></Field>
        <Field label="Permit expires (if required)"><input className={fieldCls} type="date" value={f.permitExpiresAt} onChange={set('permitExpiresAt')} /></Field>
        <p className="col-span-2 text-xs text-gray-500">New vehicles start as <b>Pending</b>. Only Runserv can approve a vehicle, and only when its mandatory documents are valid. Upload the document files on the vehicle’s page.</p>
      </div>
    </Modal>
  );
};

const FleetVehicles: React.FC = () => {
  const { can } = useFleet();
  const [status, setStatus] = useState(''); const [page, setPage] = useState(1); const [adding, setAdding] = useState(false);
  const { data, error, loading, reload } = useLoad(() => fleetPortalAPI.vehicles({ status: status || undefined, page }), [status, page]);
  return (
    <FleetPage title="Vehicles" subtitle="Cars, motorcycles and vans in your fleet and what blocks them from taking jobs."
      actions={can.manageVehicles && <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> Add vehicle</Button>}>
      <Card>
        <div className="mb-4"><select aria-label="Filter by status" className={selectCls} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>{STATUSES.map((s) => <option key={s} value={s}>{s ? label(s) : 'All statuses'}</option>)}</select></div>
        {loading && <Loading />}
        {error && <LoadError message={error} onRetry={reload} />}
        {data && (!data.vehicles.length ? <EmptyRow text="No vehicles yet." /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-gray-100"><Th>Registration</Th><Th>Vehicle</Th><Th>Status</Th><Th>Documents</Th><Th>Driver</Th></tr></thead>
              <tbody className="divide-y divide-gray-50">
                {data.vehicles.map((v) => (
                  <tr key={v.id} className="align-top">
                    <td className="py-3 pr-4"><Link to={`/fleet/vehicles/${v.id}`} className="font-mono font-medium text-primary-700 hover:underline">{v.registrationNumber}</Link></td>
                    <td className="py-3 pr-4">{v.make} {v.model}{v.modelYear ? ` (${v.modelYear})` : ''}<p className="text-xs text-gray-400">{label(v.vehicleType)}</p></td>
                    <td className="py-3 pr-4"><StatusBadge status={v.status} />{v.compliance.blockers.length > 0 && <p className="text-xs text-red-600 mt-1">Blocked: {v.compliance.blockers.join('; ')}</p>}</td>
                    <td className="py-3 pr-4"><ComplianceChips c={v.compliance} /></td>
                    <td className="py-3 pr-4 text-gray-600">{v.assignments?.length ? 'Assigned' : <span className="text-gray-400">None</span>}</td>
                  </tr>))}
              </tbody>
            </table>
          </div>))}
        {data && <Pager page={page} total={data.total} onPage={setPage} />}
      </Card>
      <AddVehicleModal open={adding} onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />
    </FleetPage>
  );
};
export default FleetVehicles;
