import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { UserPlus } from 'lucide-react';
import { Button, Card, Modal } from '@/components/common';
import { fleetPortalAPI } from '@/services/api/fleetPortal';
import { FleetPage, Loading, LoadError, StatusBadge, EmptyRow, Th, Field, fieldCls, selectCls, apiError, fmtDate, personName, useFleet, useLoad } from './shared';

const AssignModal: React.FC<{ open: boolean; onClose: () => void; onDone: () => void }> = ({ open, onClose, onDone }) => {
  const [email, setEmail] = useState(''); const [vehicleId, setVehicleId] = useState(''); const [busy, setBusy] = useState(false);
  const { data: vehicles } = useLoad(() => fleetPortalAPI.vehicles({ limit: 100 }), []);
  const free = (vehicles?.vehicles ?? []).filter((v) => v.status === 'ACTIVE' && !v.compliance.blockers.length && !v.assignments?.length);
  const submit = async () => {
    setBusy(true);
    try { await fleetPortalAPI.assign({ vehicleId, driverEmail: email.trim() }); toast.success('Driver assigned'); setEmail(''); setVehicleId(''); onDone(); }
    catch (e) { toast.error(apiError(e)); } finally { setBusy(false); }
  };
  return (
    <Modal isOpen={open} onClose={onClose} title="Assign a driver to a vehicle" size="md"
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!email.includes('@') || !vehicleId} onClick={submit}>Assign</Button></>}>
      <div className="space-y-3 text-sm">
        <Field label="Driver’s Runserv email" hint="The driver must already have a Runserv account that Runserv has approved as a driver."><input className={fieldCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Vehicle" hint="Only approved vehicles with valid mandatory documents and no current driver are listed.">
          <select className={fieldCls} value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
            <option value="">Select a vehicle…</option>
            {free.map((v) => <option key={v.id} value={v.id}>{v.registrationNumber} — {v.make} {v.model}</option>)}
          </select></Field>
        {vehicles && !free.length && <p className="text-xs text-amber-700">No vehicle is currently available to assign.</p>}
      </div>
    </Modal>
  );
};

const FleetDrivers: React.FC = () => {
  const { can, active } = useFleet();
  const [status, setStatus] = useState('ACTIVE'); const [adding, setAdding] = useState(false); const [busy, setBusy] = useState<string | null>(null);
  const { data, error, loading, reload } = useLoad(() => fleetPortalAPI.drivers({ status: status || undefined }), [status]);
  const end = async (id: string, name: string) => {
    if (!window.confirm(`End ${name}’s assignment? They will stop receiving jobs on this vehicle.`)) return;
    setBusy(id);
    try { await fleetPortalAPI.endAssignment(id); toast.success('Assignment ended'); reload(); } catch (e) { toast.error(apiError(e)); } finally { setBusy(null); }
  };
  return (
    <FleetPage title="Drivers" subtitle="Which driver is on which vehicle. One active driver per vehicle, one active vehicle per driver."
      actions={can.assignDrivers && <Button disabled={!active} title={active ? undefined : 'Available once Runserv approves your fleet account'} onClick={() => setAdding(true)}><UserPlus className="h-4 w-4" /> Assign driver</Button>}>
      <Card>
        <div className="mb-4"><select aria-label="Filter by status" className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="ACTIVE">Current assignments</option><option value="ENDED">Ended</option><option value="">All</option></select></div>
        {loading && <Loading />}
        {error && <LoadError message={error} onRetry={reload} />}
        {data && (!data.length ? <EmptyRow text="No assignments." /> : (
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr className="border-b border-gray-100"><Th>Driver</Th>{can.seeDriverIdentity && <Th>Contact</Th>}<Th>Vehicle</Th><Th>Since</Th><Th>Status</Th><Th right>{can.assignDrivers ? 'Actions' : ''}</Th></tr></thead>
            <tbody className="divide-y divide-gray-50">
              {data.map((a) => (
                <tr key={a.id}>
                  <td className="py-3 pr-4 font-medium">{personName(a.driver)}</td>
                  {can.seeDriverIdentity && <td className="py-3 pr-4 text-gray-600 text-xs">{a.driver.phone}<br />{a.driver.email}</td>}
                  <td className="py-3 pr-4"><span className="font-mono">{a.vehicle.registrationNumber}</span><p className="text-xs text-gray-400">{a.vehicle.make} {a.vehicle.model}</p></td>
                  <td className="py-3 pr-4 text-gray-600">{fmtDate(a.startsAt)}{a.endsAt ? ` – ${fmtDate(a.endsAt)}` : ''}</td>
                  <td className="py-3 pr-4"><StatusBadge status={a.status} /></td>
                  <td className="py-3 text-right">{can.assignDrivers && a.status === 'ACTIVE' && <Button size="sm" variant="outline" loading={busy === a.id} onClick={() => end(a.id, personName(a.driver))}>End assignment</Button>}</td>
                </tr>))}
            </tbody></table></div>))}
      </Card>
      {adding && <AssignModal open onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
    </FleetPage>
  );
};
export default FleetDrivers;
