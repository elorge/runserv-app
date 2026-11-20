// Runserv staff: fleet settlement statements (what Runserv owes a fleet for completed trips).
import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Wallet, Plus } from 'lucide-react';
import { Alert, Button, Card, Modal, Spinner } from '@/components/common';
import { useAuth } from '@/hooks/useAuth';
import { fleetAdminAPI, apiError } from '@/services/api/partnerships';
import type { FleetPartner, FleetSettlement, SettlementStatus } from '@/types/partnerships';
import { PageHeader, SettlementTable, Field, fieldCls, selectCls, lagosStart, lagosEndExclusive, money, label, type SettlementRow } from '@/components/features/partnerships';

const FleetSettlements: React.FC = () => {
  const { can } = useAuth();
  const [rows, setRows] = useState<FleetSettlement[]>([]); const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(''); const [fleets, setFleets] = useState<FleetPartner[]>([]);
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [busyId, setBusyId] = useState<string | null>(null);
  const [f, setF] = useState({ fleetPartnerId: '', from: '', to: '', adjustments: '' });

  const load = useCallback(() => {
    setLoading(true);
    fleetAdminAPI.settlements({ status: status || undefined, limit: 100 }).then(setRows).catch((e) => toast.error(apiError(e))).finally(() => setLoading(false));
  }, [status]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (open && !fleets.length) fleetAdminAPI.list({ status: 'ACTIVE', limit: 100 }).then((r) => setFleets(r.fleets)).catch(() => undefined); }, [open, fleets.length]);

  const create = async () => {
    if (new Date(f.to) < new Date(f.from)) return toast.error('“To” must not be before “From”.');
    setBusy(true);
    try {
      const r = await fleetAdminAPI.createSettlement({ fleetPartnerId: f.fleetPartnerId, periodStart: lagosStart(f.from), periodEnd: lagosEndExclusive(f.to), adjustments: f.adjustments ? Number(f.adjustments) : undefined });
      toast.success(`Statement created from ${r.tripCount} completed trips`); setOpen(false); setF({ fleetPartnerId: '', from: '', to: '', adjustments: '' }); load();
    } catch (e) { toast.error(apiError(e)); } finally { setBusy(false); }
  };
  const move = async (id: string, to: SettlementStatus) => {
    setBusyId(id);
    try { await fleetAdminAPI.transitionSettlement(id, to); toast.success(`Settlement ${label(to).toLowerCase()}`); load(); } catch (e) { toast.error(apiError(e)); } finally { setBusyId(null); }
  };

  const table: SettlementRow[] = rows.map((s) => ({
    id: s.id, party: s.fleetPartner?.legalName ?? s.fleetPartnerId, partyHref: `/fleets/${s.fleetPartnerId}`, ref: s.reference ?? s.id.slice(0, 8),
    periodStart: s.periodStart, periodEnd: s.periodEnd, headline: s.netAmount, currency: s.currency, status: s.status, paidAt: s.paidAt,
    breakdown: `${money(s.grossAmount, s.currency)} fares − ${money(s.platformFeeAmount, s.currency)} fee${Number(s.adjustmentsAmount) ? ` ${Number(s.adjustmentsAmount) > 0 ? '+' : '−'} ${money(Math.abs(Number(s.adjustmentsAmount)), s.currency)} adj.` : ''}`,
  }));

  return (
    <div className="space-y-5">
      <PageHeader icon={Wallet} color="bg-emerald-100 text-emerald-600" title="Fleet settlements" subtitle="Pending → Reconciling → Approved → Paid. A different admin from the approver must mark a statement paid."
        actions={can.managePartnerships && <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" />New statement</Button>} />
      <Alert variant="warning" title="Before paying a fleet for real">Confirm which platform fee applies to fleet drivers (one fee only — never charge both the fleet and the driver). Until that decision is made, treat these statements as reporting, not as payouts.</Alert>
      <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{['PENDING', 'RECONCILING', 'APPROVED', 'PAID', 'DISPUTED', 'CANCELLED'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
      <Card>{loading ? <div className="py-16 flex justify-center"><Spinner /></div> : <SettlementTable rows={table} canWrite={can.managePartnerships} partyHeader="Fleet" amountHeader="Net payable" busyId={busyId} onMove={move} link={(href, text) => <Link className="text-blue-600 hover:underline" to={href}>{text}</Link>} />}</Card>

      <Modal isOpen={open} onClose={() => setOpen(false)} title="New settlement statement" size="md"
        footer={<><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button loading={busy} disabled={!f.fleetPartnerId || !f.from || !f.to} onClick={create}>Create statement</Button></>}>
        <div className="space-y-3">
          <Field label="Fleet"><select className={fieldCls} value={f.fleetPartnerId} onChange={(e) => setF({ ...f, fleetPartnerId: e.target.value })}><option value="">Choose an active fleet…</option>{fleets.map((x) => <option key={x.id} value={x.id}>{x.tradingName || x.legalName}</option>)}</select></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="From (inclusive)"><input type="date" className={fieldCls} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field><Field label="To (inclusive)"><input type="date" className={fieldCls} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field></div>
          <Field label="Adjustments (optional)" hint="Positive adds to what the fleet receives; negative deducts. Use for agreed corrections only."><input type="number" step="0.01" className={fieldCls} value={f.adjustments} onChange={(e) => setF({ ...f, adjustments: e.target.value })} /></Field>
          <p className="text-xs text-gray-500">Built from the fleet’s completed trips in the period (Lagos time). A period can only be settled once; overlapping statements are refused.</p>
        </div>
      </Modal>
    </div>
  );
};
export default FleetSettlements;
