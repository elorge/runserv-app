// Fleet shift schedule: a week agenda of who is on which vehicle. A schedule only; it does not by itself allow or block dispatch.
import React, { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { CalendarPlus, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button, Card, Modal } from '@/components/common';
import { fleetPortalAPI } from '@/services/api/fleetPortal';
import { FleetPage, Loading, LoadError, Field, fieldCls, selectCls, apiError, personName, useFleet, useLoad } from './shared';

const DAY = 86400000;
const startOfWeek = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };   // Monday
const hhmm = (v: string) => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

const FleetShifts: React.FC = () => {
  const { can, active } = useFleet();
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [adding, setAdding] = useState(false); const [busy, setBusy] = useState<string | null>(null);
  const from = weekStart.toISOString(); const to = new Date(weekStart.getTime() + 7 * DAY).toISOString();
  const shifts = useLoad(() => fleetPortalAPI.shifts({ from, to }), [from]);
  const pairs = useLoad(() => fleetPortalAPI.drivers({}), []);
  const names = useMemo(() => {
    const d = new Map<string, string>(); const v = new Map<string, string>();
    (pairs.data || []).forEach((a) => { d.set(a.driverUserId, personName(a.driver)); v.set(a.vehicleId, a.vehicle.registrationNumber); });
    return { d, v };
  }, [pairs.data]);
  const days = Array.from({ length: 7 }, (_, i) => new Date(weekStart.getTime() + i * DAY));
  const cancel = async (id: string) => {
    if (!window.confirm('Cancel this shift?')) return; setBusy(id);
    try { await fleetPortalAPI.cancelShift(id); toast.success('Shift cancelled'); shifts.reload(); } catch (e) { toast.error(apiError(e)); } finally { setBusy(null); }
  };

  return (
    <FleetPage title="Shifts" subtitle="Plan which driver works which vehicle. This is a schedule for your team; it does not by itself allow or block jobs."
      actions={can.assignDrivers && <Button disabled={!active} onClick={() => setAdding(true)}><CalendarPlus className="h-4 w-4" /> Schedule shift</Button>}>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" aria-label="Previous week" onClick={() => setWeekStart(new Date(weekStart.getTime() - 7 * DAY))}><ChevronLeft className="h-4 w-4" /></Button>
        <Button size="sm" variant="outline" onClick={() => setWeekStart(startOfWeek(new Date()))}>This week</Button>
        <Button size="sm" variant="outline" aria-label="Next week" onClick={() => setWeekStart(new Date(weekStart.getTime() + 7 * DAY))}><ChevronRight className="h-4 w-4" /></Button>
        <span className="text-sm text-gray-600 ml-2">{days[0].toLocaleDateString([], { day: 'numeric', month: 'short' })} – {days[6].toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}</span>
      </div>
      {shifts.loading && <Loading />}
      {shifts.error && <LoadError message={shifts.error} onRetry={shifts.reload} />}
      {shifts.data && <div className="grid gap-3 md:grid-cols-7">
        {days.map((day) => {
          const dayShifts = shifts.data!.filter((s) => new Date(s.startsAt) < new Date(day.getTime() + DAY) && new Date(s.endsAt) > day);
          return (
            <Card key={day.toISOString()}>
              <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">{day.toLocaleDateString([], { weekday: 'short', day: 'numeric' })}</h3>
              {dayShifts.length === 0 && <p className="text-xs text-gray-400">No shifts</p>}
              <ul className="space-y-2">{dayShifts.map((s) => (
                <li key={s.id} className="rounded-lg bg-blue-50 border border-blue-100 p-2 text-xs">
                  <p className="font-semibold text-blue-900">{hhmm(s.startsAt)} – {hhmm(s.endsAt)}</p>
                  <p>{names.d.get(s.driverUserId) ?? 'Driver'}</p><p className="text-gray-600">{names.v.get(s.vehicleId) ?? 'Vehicle'}</p>
                  {s.note && <p className="text-gray-500 italic">{s.note}</p>}
                  {can.assignDrivers && <button className="mt-1 text-red-600 underline disabled:opacity-50" disabled={busy === s.id} onClick={() => cancel(s.id)}>Cancel</button>}
                </li>))}</ul>
            </Card>);
        })}
      </div>}
      {adding && <ShiftModal pairs={(pairs.data || []).filter((a) => a.status === 'ACTIVE')} onClose={() => setAdding(false)} onDone={() => { setAdding(false); shifts.reload(); }} />}
    </FleetPage>
  );
};

const ShiftModal: React.FC<{ pairs: { id: string; vehicleId: string; driverUserId: string; vehicle: { registrationNumber: string }; driver: { firstName: string; lastName: string } }[]; onClose: () => void; onDone: () => void }> = ({ pairs, onClose, onDone }) => {
  const [pair, setPair] = useState(pairs[0]?.id ?? '');
  const [start, setStart] = useState(() => { const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); return toLocalInput(d); });
  const [end, setEnd] = useState(() => { const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 9); return toLocalInput(d); });
  const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async () => {
    const a = pairs.find((p) => p.id === pair); if (!a) return; setBusy(true);
    try { await fleetPortalAPI.createShift({ vehicleId: a.vehicleId, driverUserId: a.driverUserId, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), note: note.trim() || undefined }); toast.success('Shift scheduled'); onDone(); }
    catch (e) { toast.error(apiError(e)); } finally { setBusy(false); }
  };
  return (
    <Modal isOpen onClose={onClose} title="Schedule a shift" size="md" footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!pair || !start || !end} onClick={submit}>Schedule</Button></>}>
      <div className="space-y-3 text-sm">
        {pairs.length === 0 ? <p className="text-gray-500">No driver is assigned to a vehicle yet. Assign a driver on the Drivers page first.</p> : <>
          <Field label="Driver and vehicle"><select className={selectCls} value={pair} onChange={(e) => setPair(e.target.value)}>{pairs.map((p) => <option key={p.id} value={p.id}>{personName(p.driver)} — {p.vehicle.registrationNumber}</option>)}</select></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Starts"><input type="datetime-local" className={fieldCls} value={start} onChange={(e) => setStart(e.target.value)} /></Field>
            <Field label="Ends" hint="At most 24 hours."><input type="datetime-local" className={fieldCls} value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
          </div>
          <Field label="Note (optional)"><input className={fieldCls} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field></>}
      </div>
    </Modal>
  );
};
export default FleetShifts;
