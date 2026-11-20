// Shared pieces for the Fleet Partner Portal screens.
import React from 'react';
import { AlertTriangle, ShieldAlert, Info } from 'lucide-react';
import { Button, Spinner } from '@/components/common';
import { useAuthStore } from '@/store/authStore';
import type { FleetPermissions, FleetSession } from '@/types/fleetPortal';
import { PAGE_SIZE } from '@/services/api/fleetPortal';

export { StatusBadge, ComplianceChips, Stat, EmptyRow, Th, Field, PromptModal, InfoCard, selectCls, fieldCls, fmtDate, money, pct, label } from '@/components/features/partnerships';
export { apiError } from '@/services/api/fleetPortal';

const NONE: FleetPermissions = { view: false, manageUsers: false, manageSettings: false, manageVehicles: false, manageDocuments: false, assignDrivers: false, seeTrips: false, seeFinance: false, seeDriverIdentity: false };

/** The signed-in fleet user's fleet, role and permissions. */
export const useFleet = (): { fleet: FleetSession | undefined; can: FleetPermissions; active: boolean } => {
  const fleet = useAuthStore((s) => s.user?.fleet);
  return { fleet, can: fleet?.permissions ?? NONE, active: fleet?.status === 'ACTIVE' };
};

const BANNERS: Record<string, { tone: 'amber' | 'red' | 'blue'; icon: React.ElementType; text: string }> = {
  PENDING: { tone: 'blue', icon: Info, text: 'Your application has been received. Runserv will review it and may contact you. You can prepare vehicles and documents now, but nothing goes live and no driver can be assigned until your account is approved.' },
  UNDER_REVIEW: { tone: 'blue', icon: Info, text: 'Runserv is reviewing your application. You can prepare vehicles and documents now, but nothing goes live and no driver can be assigned until your account is approved.' },
  SUSPENDED: { tone: 'red', icon: ShieldAlert, text: 'Your fleet account is suspended. Your drivers cannot receive new jobs and you cannot assign drivers. Contact Runserv support to resolve this.' },
  REJECTED: { tone: 'red', icon: ShieldAlert, text: 'Your application was not approved. Contact Runserv support if you think this is a mistake.' },
  DEACTIVATED: { tone: 'amber', icon: AlertTriangle, text: 'Your fleet account is deactivated. Contact Runserv support to reactivate it.' },
};
const TONE = { amber: 'bg-amber-50 border-amber-200 text-amber-900', red: 'bg-red-50 border-red-200 text-red-900', blue: 'bg-blue-50 border-blue-200 text-blue-900' };

/** A clear banner whenever the fleet account is anything other than Active. */
export const FleetStatusBanner: React.FC = () => {
  const { fleet } = useFleet();
  const b = fleet && BANNERS[fleet.status];
  if (!b) return null;
  const Icon = b.icon;
  return (
    <div role="status" data-testid="fleet-status-banner" className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${TONE[b.tone]}`}>
      <Icon className="h-5 w-5 flex-shrink-0 mt-0.5" /><p>{b.text}</p>
    </div>
  );
};

/** Page frame: status banner, title, optional actions. */
export const FleetPage: React.FC<{ title: string; subtitle?: string; actions?: React.ReactNode; children: React.ReactNode }> = ({ title, subtitle, actions, children }) => (
  <div className="space-y-5">
    <FleetStatusBanner />
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><h1 className="text-2xl font-bold text-gray-900">{title}</h1>{subtitle && <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>}</div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
    {children}
  </div>
);

export const Loading: React.FC = () => <div className="flex justify-center py-16"><Spinner /></div>;

export const LoadError: React.FC<{ message: string; onRetry: () => void }> = ({ message, onRetry }) => (
  <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 flex items-center justify-between gap-3">
    <span>{message}</span><Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>
  </div>
);

export const Pager: React.FC<{ page: number; total: number; onPage: (p: number) => void }> = ({ page, total, onPage }) => {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between pt-4 text-sm text-gray-500">
      <span>{total} in total</span>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
        <span>Page {page} of {pages}</span>
        <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
      </div>
    </div>
  );
};

/** Simple data loader: runs `fn` on mount and whenever `deps` change. */
export function useLoad<T>(fn: () => Promise<T>, deps: React.DependencyList) {
  const [data, setData] = React.useState<T | null>(null);
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const run = React.useCallback(async () => {
    setLoading(true); setError('');
    try { setData(await fn()); } catch (e: any) { setError(e?.response?.data?.message || e?.message || 'Could not load this page'); } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  React.useEffect(() => { run(); }, [run]);
  return { data, error, loading, reload: run };
}

export const personName = (p?: { firstName?: string; lastName?: string } | null) => (p ? `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim() || '—' : '—');
