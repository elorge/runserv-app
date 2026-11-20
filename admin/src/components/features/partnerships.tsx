// Shared building blocks for the Fleet and Bank Offers admin pages.
import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Button, Modal, Badge, Card } from '@/components/common';
import { formatMoney } from '@/utils/money';
import { formatDate } from '@/utils/helpers';
import { apiError, fleetAdminAPI } from '@/services/api/partnerships';
import type { Compliance, Dec, FleetVehicle, SettlementStatus, VehicleStatus } from '@/types/partnerships';

export type Tone = 'default' | 'success' | 'warning' | 'error' | 'info';

const TONES: Record<string, Tone> = {
  ACTIVE: 'success', VERIFIED: 'success', APPROVED: 'success', PAID: 'success', VALID: 'success', SCHEDULED: 'info', IN_SERVICE: 'info',
  PENDING: 'warning', UNDER_REVIEW: 'warning', PENDING_APPROVAL: 'warning', RECONCILING: 'warning', DUE_DILIGENCE: 'warning', CONTRACT_PENDING: 'warning', EXPIRING: 'warning', MAINTENANCE: 'warning', PAUSED: 'warning', PROSPECT: 'default', UNVERIFIED: 'default', DRAFT: 'default',
  SUSPENDED: 'error', REJECTED: 'error', DISPUTED: 'error', EXPIRED: 'error', MISSING: 'error', TERMINATED: 'error', DEACTIVATED: 'default', CANCELLED: 'default', RETIRED: 'default', COMPLETED: 'default',
};
export const toneOf = (s: string): Tone => TONES[s] ?? 'default';
export const label = (s?: string | null) => (s ? s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : '—');
export const StatusBadge: React.FC<{ status: string }> = ({ status }) => <Badge variant={toneOf(status)}>{label(status)}</Badge>;

export const fmtDate = (v?: string | null) => (v ? formatDate(v) : '—');
export const money = (v: Dec | undefined, currency?: string | null) => formatMoney(Number(v ?? 0), currency || 'NGN', { decimals: 2 });
export const pct = (v: Dec | undefined) => `${(Number(v ?? 0) * 100).toFixed(2).replace(/\.?0+$/, '')}%`;

/** Lagos is UTC+1 all year: a calendar date picked by staff means midnight Lagos time. */
export const lagosStart = (ymd: string) => new Date(`${ymd}T00:00:00+01:00`).toISOString();
/** Inclusive "to" date → exclusive upper bound (the next midnight, Lagos). */
export const lagosEndExclusive = (ymd: string) => new Date(new Date(`${ymd}T00:00:00+01:00`).getTime() + 864e5).toISOString();
/** Value for <input type="datetime-local"> from an ISO string (browser local time). */
export const toLocalInput = (iso?: string | null) => {
  if (!iso) return '';
  const dt = new Date(iso); const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}`;
};

export const Stat: React.FC<{ label: string; value: React.ReactNode; hint?: string; tone?: 'warn' }> = ({ label: l, value, hint, tone }) => (
  <div className={`rounded-xl border bg-white p-4 shadow-sm ${tone === 'warn' ? 'border-amber-200' : 'border-gray-100'}`}>
    <p className="text-xs text-gray-500">{l}</p>
    <p className="text-xl font-bold mt-1 text-gray-900">{value}</p>
    {hint && <p className="text-xs text-gray-400 mt-0.5">{hint}</p>}
  </div>
);

export const PageHeader: React.FC<{ icon: React.ElementType; color?: string; title: string; subtitle?: string; actions?: React.ReactNode }> = ({ icon: Icon, color = 'bg-blue-100 text-blue-600', title, subtitle, actions }) => (
  <div className="flex flex-wrap items-center justify-between gap-3">
    <div className="flex items-center gap-3">
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${color}`}><Icon className="h-5 w-5" /></div>
      <div><h1 className="text-2xl font-bold text-gray-900">{title}</h1>{subtitle && <p className="text-sm text-gray-500">{subtitle}</p>}</div>
    </div>
    {actions && <div className="flex items-center gap-2">{actions}</div>}
  </div>
);

export const EmptyRow: React.FC<{ text: string }> = ({ text }) => <p className="text-center text-gray-400 py-12 text-sm">{text}</p>;

export const Th: React.FC<{ children?: React.ReactNode; right?: boolean }> = ({ children, right }) => (
  <th className={`pb-3 pr-4 text-xs font-semibold uppercase text-gray-500 ${right ? 'text-right' : 'text-left'}`}>{children}</th>
);

export const selectCls = 'border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary-500';
export const fieldCls = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500';

export const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label: l, hint, children }) => (
  <label className="block text-sm"><span className="block font-medium text-gray-700 mb-1">{l}</span>{children}{hint && <span className="block text-xs text-gray-400 mt-1">{hint}</span>}</label>
);

/** Asks for a short text (a reason / note) before a sensitive action. */
export const PromptModal: React.FC<{
  open: boolean; title: string; description?: React.ReactNode; fieldLabel: string; required?: boolean; confirmLabel: string; danger?: boolean;
  onClose: () => void; onSubmit: (text: string) => Promise<void> | void;
}> = ({ open, title, description, fieldLabel, required, confirmLabel, danger, onClose, onSubmit }) => {
  const [text, setText] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setText(''); }, [open]);
  const submit = async () => { setBusy(true); try { await onSubmit(text.trim()); } finally { setBusy(false); } };
  return (
    <Modal isOpen={open} onClose={onClose} title={title} size="md"
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} loading={busy} disabled={required && !text.trim()} onClick={submit}>{confirmLabel}</Button></>}>
      <div className="space-y-3 text-sm">
        {description && <div className="text-gray-600">{description}</div>}
        <Field label={fieldLabel}><textarea className={fieldCls} rows={3} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      </div>
    </Modal>
  );
};

// ── Vehicle compliance + status actions ────────────────────────────────────────
export const ComplianceChips: React.FC<{ c: Compliance }> = ({ c }) => (
  <div className="flex flex-wrap gap-1">
    {Object.entries(c.docs).filter(([, d]) => d.mandatory || d.state !== 'MISSING').map(([name, d]) => (
      <span key={name} title={d.expiresAt ? `Expires ${fmtDate(d.expiresAt)}` : 'No expiry recorded'}><Badge variant={toneOf(d.state)}>{label(name)}: {label(d.state)}</Badge></span>
    ))}
  </div>
);

const VEHICLE_ACTIONS: { to: VehicleStatus; text: string; from: VehicleStatus[]; danger?: boolean; reason?: boolean }[] = [
  { to: 'ACTIVE', text: 'Activate', from: ['PENDING', 'SUSPENDED', 'MAINTENANCE', 'IN_SERVICE'] },
  { to: 'SUSPENDED', text: 'Suspend', from: ['ACTIVE', 'IN_SERVICE', 'MAINTENANCE', 'PENDING'], danger: true, reason: true },
  { to: 'RETIRED', text: 'Retire', from: ['PENDING', 'ACTIVE', 'SUSPENDED', 'MAINTENANCE', 'IN_SERVICE'], danger: true, reason: true },
];

/** Activate / suspend / retire a vehicle. The server refuses activation while a mandatory document is missing or expired. */
export const VehicleActions: React.FC<{ vehicle: FleetVehicle; canWrite: boolean; onChanged: () => void }> = ({ vehicle, canWrite, onChanged }) => {
  const [ask, setAsk] = useState<VehicleStatus | null>(null);
  if (!canWrite) return null;
  const run = async (to: VehicleStatus, reason?: string) => {
    try { await fleetAdminAPI.setVehicleStatus(vehicle.id, to, reason); toast.success(`Vehicle ${vehicle.registrationNumber} is now ${label(to).toLowerCase()}`); setAsk(null); onChanged(); }
    catch (e) { toast.error(apiError(e)); }
  };
  const blocked = vehicle.compliance.blockers.length > 0;
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {VEHICLE_ACTIONS.filter((a) => a.from.includes(vehicle.status) && a.to !== vehicle.status).map((a) => (
        <Button key={a.to} size="sm" variant={a.danger ? 'outline' : 'success'} disabled={a.to === 'ACTIVE' && blocked}
          title={a.to === 'ACTIVE' && blocked ? vehicle.compliance.blockers.join('; ') : undefined}
          onClick={() => (a.reason ? setAsk(a.to) : run(a.to))}>{a.text}</Button>
      ))}
      <PromptModal open={!!ask} title={`${ask ? label(ask) : ''} vehicle ${vehicle.registrationNumber}`} fieldLabel="Reason (kept in the audit log)" required confirmLabel="Confirm" danger
        description="A suspended or retired vehicle can no longer take jobs. Any driver assigned to it is blocked from going online."
        onClose={() => setAsk(null)} onSubmit={(t) => run(ask as VehicleStatus, t)} />
    </div>
  );
};

// ── Settlements (fleet statements and bank invoices share one lifecycle) ───────
export interface SettlementRow { id: string; party: string; partyHref?: string; ref: string; periodStart: string; periodEnd: string; headline: Dec; breakdown: string; currency: string; status: SettlementStatus; paidAt: string | null }

const NEXT: Record<SettlementStatus, { to: SettlementStatus; text: string; variant: 'success' | 'outline' | 'danger'; confirm?: string }[]> = {
  PENDING: [{ to: 'RECONCILING', text: 'Start reconciling', variant: 'outline' }, { to: 'CANCELLED', text: 'Cancel', variant: 'danger', confirm: 'Cancel this settlement? Its period can then be settled again.' }],
  RECONCILING: [{ to: 'APPROVED', text: 'Approve', variant: 'success' }, { to: 'DISPUTED', text: 'Dispute', variant: 'outline' }, { to: 'CANCELLED', text: 'Cancel', variant: 'danger', confirm: 'Cancel this settlement? Its period can then be settled again.' }],
  APPROVED: [{ to: 'PAID', text: 'Mark paid', variant: 'success', confirm: 'Mark as paid? Only do this once the money has actually moved. A different admin from the approver must do this (maker–checker).' }, { to: 'DISPUTED', text: 'Dispute', variant: 'outline' }],
  DISPUTED: [{ to: 'RECONCILING', text: 'Back to reconciling', variant: 'outline' }, { to: 'CANCELLED', text: 'Cancel', variant: 'danger', confirm: 'Cancel this settlement? Its period can then be settled again.' }],
  PAID: [], CANCELLED: [],
};

export const SettlementTable: React.FC<{ rows: SettlementRow[]; canWrite: boolean; partyHeader: string; amountHeader: string; busyId: string | null; onMove: (id: string, to: SettlementStatus) => void; link?: (href: string, text: string) => React.ReactNode }> = ({ rows, canWrite, partyHeader, amountHeader, busyId, onMove, link }) => {
  if (!rows.length) return <EmptyRow text="No settlements yet." />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="border-b border-gray-100"><Th>Reference</Th><Th>{partyHeader}</Th><Th>Period</Th><Th right>{amountHeader}</Th><Th>Status</Th><Th right>{canWrite ? 'Actions' : ''}</Th></tr></thead>
        <tbody className="divide-y divide-gray-50">
          {rows.map((r) => (
            <tr key={r.id} className="align-top">
              <td className="py-3 pr-4 font-mono text-xs text-gray-600">{r.ref}</td>
              <td className="py-3 pr-4 font-medium">{r.partyHref && link ? link(r.partyHref, r.party) : r.party}</td>
              <td className="py-3 pr-4 text-gray-600 whitespace-nowrap">{fmtDate(r.periodStart)} – {fmtDate(new Date(new Date(r.periodEnd).getTime() - 1).toISOString())}</td>
              <td className="py-3 pr-4 text-right"><p className="font-semibold">{money(r.headline, r.currency)}</p><p className="text-xs text-gray-400">{r.breakdown}</p></td>
              <td className="py-3 pr-4"><StatusBadge status={r.status} />{r.paidAt && <p className="text-xs text-gray-400 mt-1">{fmtDate(r.paidAt)}</p>}</td>
              <td className="py-3 text-right">
                {canWrite && <div className="flex flex-wrap justify-end gap-1.5">{NEXT[r.status].map((a) => (
                  <Button key={a.to} size="sm" variant={a.variant} loading={busyId === r.id} onClick={() => { if (!a.confirm || window.confirm(a.confirm)) onMove(r.id, a.to); }}>{a.text}</Button>))}</div>}
              </td>
            </tr>))}
        </tbody>
      </table>
    </div>
  );
};

export const InfoCard: React.FC<{ title: string; children: React.ReactNode; className?: string }> = ({ title, children, className = '' }) => (
  <Card className={className}><h2 className="text-sm font-semibold text-gray-900 mb-3">{title}</h2>{children}</Card>
);
