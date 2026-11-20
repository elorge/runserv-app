// The audit table: every trip with distance, cost, purpose — and verify / flag controls.
import React, { useState } from 'react';
import { CheckCircle2, Flag, Package, Car } from 'lucide-react';
import toast from 'react-hot-toast';
import { Modal, Button, Badge } from '@/components/common';
import { companyAPI, errMsg } from '@/services/api/company';
import { formatMoney } from '@/utils/money';
import { exportToExcel } from '@/utils/exportToExcel';
import { PURPOSE_LABELS, type Trip } from '@/types/company';
import { AuditBadge, fmtDT, fmtKm, Empty } from './ui';

export const exportTrips = (trips: Trip[], filename: string) =>
  exportToExcel(trips, [
    { header: 'Date', key: 'date', width: 18, format: (v) => new Date(v).toLocaleString('en-GB') },
    { header: 'Staff', key: 'employee.name', width: 22 },
    { header: 'Staff no.', key: 'employee.staffNumber', width: 12 },
    { header: 'Department', key: 'employee.department', width: 16 },
    { header: 'Type', key: 'type', width: 10 },
    { header: 'From', key: 'from', width: 34 },
    { header: 'To', key: 'to', width: 34 },
    { header: 'Distance (km)', key: 'distanceKm', width: 12, format: (v) => (v == null ? '' : Number(v.toFixed(2))) },
    { header: 'Cost', key: 'fare', width: 12 },
    { header: 'Cost per km', key: 'costPerKm', width: 12, format: (v) => v ?? '' },
    { header: 'Purpose type', key: 'purposeCategory', width: 16, format: (v) => (v ? PURPOSE_LABELS[v] ?? v : '') },
    { header: 'Purpose', key: 'purpose', width: 36 },
    { header: 'Weekend', key: 'weekendTrip', width: 9, format: (v) => (v ? 'Yes' : '') },
    { header: 'Audit', key: 'audit.status', width: 12 },
    { header: 'Audit note', key: 'audit.note', width: 30 },
    { header: 'Invoice', key: 'invoice.number', width: 22 },
  ], filename, 'Trips');

interface Props { trips: Trip[]; currency: string; showStaff?: boolean; onChange: (t: Trip) => void }

const TripTable: React.FC<Props> = ({ trips, currency, showStaff = true, onChange }) => {
  const [target, setTarget] = useState<{ trip: Trip; status: 'VERIFIED' | 'FLAGGED' | 'UNREVIEWED' } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const open = (trip: Trip, status: 'VERIFIED' | 'FLAGGED' | 'UNREVIEWED') => { setNote(trip.audit.note ?? ''); setTarget({ trip, status }); };
  const save = async () => {
    if (!target) return; setBusy(true);
    try { onChange(await companyAPI.auditTrip(target.trip.id, target.status, note)); toast.success('Audit updated'); setTarget(null); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };

  if (!trips.length) return <Empty>No trips match.</Empty>;
  return (
    <>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="text-left px-4 py-2.5">When</th>
              {showStaff && <th className="text-left px-4 py-2.5">Staff</th>}
              <th className="text-left px-4 py-2.5">Trip</th>
              <th className="text-right px-4 py-2.5">Distance</th>
              <th className="text-right px-4 py-2.5">Cost</th>
              <th className="text-left px-4 py-2.5">Purpose</th>
              <th className="text-left px-4 py-2.5">Audit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {trips.map((t) => (
              <tr key={t.id} className={t.audit.status === 'FLAGGED' ? 'bg-red-50/40' : ''}>
                <td className="px-4 py-3 whitespace-nowrap text-gray-600">{fmtDT(t.date)}
                  {t.weekendTrip && <Badge variant="info" className="ml-1.5">Weekend</Badge>}</td>
                {showStaff && <td className="px-4 py-3"><p className="font-medium text-gray-900">{t.employee.name}</p>
                  <p className="text-xs text-gray-400">{t.employee.staffNumber} · {t.employee.department}{t.costCenter ? <span className="font-mono"> · {t.costCenter}</span> : null}</p></td>}
                <td className="px-4 py-3 max-w-xs">
                  <div className="flex items-start gap-2">
                    {t.type === 'DELIVERY' ? <Package className="h-4 w-4 mt-0.5 text-amber-500 flex-shrink-0" /> : <Car className="h-4 w-4 mt-0.5 text-blue-500 flex-shrink-0" />}
                    <div className="min-w-0"><p className="truncate text-gray-900" title={t.from ?? ''}>{t.from}</p><p className="truncate text-gray-500" title={t.to ?? ''}>→ {t.to}</p>
                      {t.driver && <p className="text-xs text-gray-400 mt-0.5">{t.driver.firstName}{t.driver.plate ? ` · ${t.driver.plate}` : ''}</p>}</div>
                  </div>
                </td>
                <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{fmtKm(t.distanceKm)}</td>
                <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap"><p className="font-semibold">{formatMoney(t.fare, currency)}</p>
                  {t.costPerKm != null && <p className="text-xs text-gray-400">{formatMoney(t.costPerKm, currency)}/km</p>}</td>
                <td className="px-4 py-3 max-w-[220px]">
                  {t.purposeCategory && <Badge className="mb-1">{PURPOSE_LABELS[t.purposeCategory] ?? t.purposeCategory}</Badge>}
                  <p className="text-gray-700 text-xs">{t.purpose ?? <span className="text-red-500">No purpose given</span>}</p></td>
                <td className="px-4 py-3 whitespace-nowrap">
                  <AuditBadge status={t.audit.status} />
                  {t.audit.note && <p className="text-xs text-gray-400 mt-1 max-w-[160px] truncate" title={t.audit.note}>{t.audit.note}</p>}
                  <div className="flex gap-2 mt-1.5">
                    <button title="Mark as a legitimate business trip" onClick={() => open(t, 'VERIFIED')} className="text-emerald-600 hover:text-emerald-800"><CheckCircle2 className="h-4 w-4" /></button>
                    <button title="Flag for follow-up" onClick={() => open(t, 'FLAGGED')} className="text-red-500 hover:text-red-700"><Flag className="h-4 w-4" /></button>
                    {t.audit.status !== 'UNREVIEWED' && <button onClick={() => open(t, 'UNREVIEWED')} className="text-xs text-gray-400 hover:text-gray-700">reset</button>}
                  </div>
                </td>
              </tr>))}
          </tbody>
        </table>
      </div>

      <Modal isOpen={!!target} onClose={() => setTarget(null)}
        title={target?.status === 'VERIFIED' ? 'Verify trip' : target?.status === 'FLAGGED' ? 'Flag trip' : 'Reset review'}
        footer={<><Button variant="outline" onClick={() => setTarget(null)}>Cancel</Button>
          <Button variant={target?.status === 'FLAGGED' ? 'danger' : 'primary'} loading={busy} onClick={save}>Save</Button></>}>
        {target && (<div className="space-y-3 text-sm">
          <p className="text-gray-600"><b>{target.trip.employee.name}</b> · {fmtDT(target.trip.date)} · {formatMoney(target.trip.fare, currency)}</p>
          <p className="text-gray-500">Stated purpose: {target.trip.purpose ?? '—'}</p>
          <label className="block"><span className="block text-sm font-medium text-gray-700 mb-1">Note (only your company sees this)</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={500}
              placeholder={target.status === 'FLAGGED' ? 'e.g. No client meeting logged for this address' : 'e.g. Confirmed with the sales manager'}
              className="w-full border border-gray-300 rounded-lg p-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" /></label>
        </div>)}
      </Modal>
    </>
  );
};
export default TripTable;
