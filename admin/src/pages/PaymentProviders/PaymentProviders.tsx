// Payments → Provider Management. Operational control panel: shows provider status, never secrets.
// Reads: any admin. Changes: Super Admin (the API enforces this too). Disabling is the kill switch.
import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { Card, Badge } from '@/components/common';
import api from '@/services/api';
import { useAuth } from '@/hooks/useAuth';
import { ChangeRequest, ExceptionRow, ONBOARDING_LABEL, ProviderRow, errMsg } from './shared';
import ProviderSettingsModal from './ProviderSettingsModal';
import CredentialsModal from './CredentialsModal';
import PaymentTimelineModal from './PaymentTimelineModal';
import ResolveReviewModal from './ResolveReviewModal';
import ReconciliationTab from './ReconciliationTab';
import AuditTab from './AuditTab';

type Tab = 'providers' | 'exceptions' | 'reconciliation' | 'audit';
const TABS: { id: Tab; label: string }[] = [
  { id: 'providers', label: 'Providers' }, { id: 'exceptions', label: 'Exceptions' },
  { id: 'reconciliation', label: 'Reconciliation' }, { id: 'audit', label: 'Audit log' },
];

const PaymentProviders: React.FC = () => {
  const { user } = useAuth() as any;
  const isSuper = user?.role === 'SUPER_ADMIN';
  const [tab, setTab] = useState<Tab>('providers');
  const [rows, setRows] = useState<ProviderRow[]>([]);
  const [exceptions, setExceptions] = useState<ExceptionRow[]>([]);
  const [requests, setRequests] = useState<ChangeRequest[]>([]);
  const [env, setEnv] = useState<string>('SANDBOX');
  const [loading, setLoading] = useState(false);
  const [settingsFor, setSettingsFor] = useState<ProviderRow | null>(null);
  const [credsFor, setCredsFor] = useState<ProviderRow | null>(null);
  const [timelineFor, setTimelineFor] = useState<string | null>(null);
  const [resolveFor, setResolveFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, e, r] = await Promise.all([
        api.get('/admin/payment-providers'), api.get('/admin/payment-ops/exceptions'), api.get('/admin/payment-providers/change-requests'),
      ]);
      setRows(d.data.data.providers); setEnv(d.data.data.activeEnvironment);
      setExceptions(e.data.data.exceptions);
      setRequests((r.data.data.requests as ChangeRequest[]).filter(x => x.status === 'PENDING'));
    } catch { toast.error('Failed to load payment providers'); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (fn: () => Promise<any>, ok: string) => {
    try { const res = await fn(); toast.success(res?.data?.data?.pendingApproval ? 'Sent for approval by a second Super Admin' : ok); load(); }
    catch (err: any) { toast.error(errMsg(err)); }
  };
  const path = (p: ProviderRow) => `/admin/payment-providers/${p.providerKey}/${p.countryCode}`;
  const manageable = (p: ProviderRow) => p.providerKey === 'mtn_momo';

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Payment providers</h1>
          <p className="text-gray-500 text-sm mt-1">
            Backend environment: <b>{env}</b>. Secrets are held by the backend only and are never shown here. MTN MoMo stays off until onboarding is approved.
          </p>
        </div>
        <button onClick={load} className="flex items-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-semibold rounded-xl">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className="flex gap-2 border-b">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-semibold -mb-px border-b-2 ${tab === t.id ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {t.label}{t.id === 'exceptions' && exceptions.length > 0 ? ` (${exceptions.length})` : ''}
          </button>))}
      </div>

      {tab === 'providers' && (<>
        <Card padding={false}>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-gray-500 border-b">
              <th className="p-3">Provider</th><th>Market</th><th>Onboarding</th><th>Status</th><th>Credentials</th><th>Currencies</th><th></th>
            </tr></thead>
            <tbody>
              {rows.map(p => (
                <tr key={p.providerKey + p.countryCode} className="border-b last:border-0">
                  <td className="p-3 font-medium">{p.name}</td>
                  <td>{p.countryCode}</td>
                  <td>{ONBOARDING_LABEL[p.onboardingStatus] ?? p.onboardingStatus}</td>
                  <td><Badge variant={p.effective ? 'success' : 'default'}>{p.effective ? 'Live for customers' : p.effectiveReason.replace(/_/g, ' ').toLowerCase()}</Badge></td>
                  <td>{Object.keys(p.credentials).length === 0 ? '—' : Object.entries(p.credentials).map(([k, v]) => (
                    <span key={k} className={`mr-2 text-xs ${v ? 'text-green-700' : 'text-gray-400'}`}>{k}: {v ? 'set' : 'missing'}</span>))}
                    {p.secretsRotatedAt && <div className="text-xs text-gray-400">rotated {new Date(p.secretsRotatedAt).toLocaleDateString()}</div>}</td>
                  <td>{p.capabilities?.currencies?.join(', ') || '—'}</td>
                  <td className="p-3 text-right space-x-3 whitespace-nowrap">
                    {isSuper && manageable(p) && <button className="text-blue-700 font-semibold" onClick={() => setSettingsFor(p)}>Settings</button>}
                    {isSuper && manageable(p) && <button className="text-blue-700 font-semibold" onClick={() => setCredsFor(p)}>Credentials</button>}
                    {p.effective && <button className="text-red-600 font-semibold" onClick={() => { if (confirm(`Disable ${p.name} in ${p.countryCode}? New payments will be refused immediately.`)) act(() => api.post(`${path(p)}/disable`, { environment: env, reason: 'Disabled from Admin' }), 'Disabled'); }}>Disable</button>}
                    {isSuper && !p.effective && <button className="text-green-700 font-semibold" onClick={() => { const reason = prompt('Reason for enabling (min 5 characters):'); if (reason) act(() => api.post(`${path(p)}/enable`, { environment: env, reason }), 'Enabled'); }}>Enable</button>}
                  </td>
                </tr>))}
              {rows.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-gray-400">No providers found.</td></tr>}
            </tbody>
          </table>
        </Card>

        {requests.length > 0 && (
          <Card>
            <h2 className="font-semibold mb-3">Waiting for approval</h2>
            {requests.map(r => (
              <div key={r.id} className="flex items-center justify-between py-2 border-b last:border-0 text-sm">
                <span><b>{r.providerKey}</b> {r.countryCode} → {r.environment}: {r.reason}</span>
                {isSuper && <span className="space-x-3">
                  <button className="text-green-700 font-semibold" onClick={() => act(() => api.post(`/admin/payment-providers/change-requests/${r.id}/approve`, {}), 'Approved')}>Approve</button>
                  <button className="text-red-600 font-semibold" onClick={() => act(() => api.post(`/admin/payment-providers/change-requests/${r.id}/reject`, {}), 'Rejected')}>Reject</button>
                </span>}
              </div>))}
          </Card>)}
      </>)}

      {tab === 'exceptions' && (
        <Card>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">Exceptions queue ({exceptions.length} open)</h2>
            {isSuper && <button className="text-sm text-blue-700 font-semibold" onClick={() => act(() => api.post('/admin/payment-ops/sweep'), 'Pending payments re-checked')}>Re-check pending payments now</button>}
          </div>
          {exceptions.length === 0 ? <p className="text-sm text-gray-400">Nothing needs attention.</p> : exceptions.map(x => (
            <div key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2 border-b last:border-0 text-sm">
              <span><Badge variant="warning">{x.kind.replace(/_/g, ' ').toLowerCase()}</Badge> <span className="text-gray-500">{x.provider} · {new Date(x.createdAt).toLocaleString()}</span></span>
              <span className="space-x-3">
                {x.paymentId && <button className="text-gray-700 font-semibold" onClick={() => setTimelineFor(x.paymentId)}>Timeline</button>}
                {isSuper && x.paymentId && <button className="text-purple-700 font-semibold" onClick={() => setResolveFor(x.paymentId)}>Decide payment</button>}
                {isSuper && <button className="text-blue-700 font-semibold" onClick={() => { const resolution = prompt('How was this resolved? (min 5 characters)'); if (resolution) act(() => api.post(`/admin/payment-ops/exceptions/${x.id}/resolve`, { resolution }), 'Closed'); }}>Close</button>}
              </span>
            </div>))}
        </Card>)}

      {tab === 'reconciliation' && <ReconciliationTab isSuper={isSuper} onChanged={load} />}
      {tab === 'audit' && <AuditTab />}

      <ProviderSettingsModal provider={settingsFor} env={env} onClose={() => setSettingsFor(null)} onSaved={load} />
      <CredentialsModal provider={credsFor} env={env} onClose={() => setCredsFor(null)} onSaved={load} />
      <PaymentTimelineModal paymentId={timelineFor} onClose={() => setTimelineFor(null)} />
      <ResolveReviewModal paymentId={resolveFor} onClose={() => setResolveFor(null)} onDone={load} />
    </div>
  );
};

export default PaymentProviders;
