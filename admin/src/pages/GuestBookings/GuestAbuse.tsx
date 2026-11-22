import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Card, Button, Spinner, Alert, Input } from '@/components/common';
import { guestBookingsAPI } from '@/services/api/guestBookings';
import { useAuth } from '@/hooks/useAuth';
import type { GuestAbuse as Abuse } from '@/types/guestBooking';
import { fmtDate, apiMessage } from './shared';

/**
 * Abuse signals (last 24 h) plus identity block / unblock. Blocking needs an identity id, which comes from a booking's detail page;
 * the form below exists so a reviewer who has the id from there can act without leaving this page. The server re-checks ADMIN / SUPER_ADMIN.
 */
const GuestAbuse: React.FC = () => {
  const { isAdmin } = useAuth();
  const [data, setData] = useState<Abuse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [identityId, setIdentityId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setData(await guestBookingsAPI.abuse()); } catch (e) { setError(apiMessage(e, 'Could not load abuse signals.')); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identityId.trim());
  const act = async (kind: 'block' | 'unblock') => {
    if (!uuid || busy || (kind === 'block' && reason.trim().length < 5)) return;
    if (!window.confirm(kind === 'block' ? 'Block this guest identity? Their sessions are revoked.' : 'Unblock this guest identity?')) return;
    setBusy(true);
    try { const r = kind === 'block' ? await guestBookingsAPI.block(identityId.trim(), reason.trim()) : await guestBookingsAPI.unblock(identityId.trim()); toast.success(r.message || 'Done.'); setReason(''); load(); }
    catch (e) { toast.error(apiMessage(e, 'The action was refused.')); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4 p-6">
      <div><Link to="/guest-bookings" className="text-sm text-primary-600">← Guest bookings</Link><h1 className="text-2xl font-bold text-gray-900">Abuse signals</h1><p className="text-sm text-gray-500">Last 24 hours. Sources are hashed; no raw IP addresses or phone numbers are shown.</p></div>
      {error ? <Alert variant="error">{error}</Alert> : null}
      {loading ? <div className="flex justify-center p-10"><Spinner /></div> : data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{data.counts.length === 0 ? <Card><p className="text-gray-500">No signals in the last 24 hours.</p></Card> : data.counts.map((c) => <Card key={c.event}><p className="text-xs text-gray-500">{c.event.replace(/_/g, ' ')}</p><p className="text-2xl font-bold">{c.count}</p></Card>)}</div>
          <Card><h2 className="mb-2 font-semibold">Noisiest sources</h2>{data.noisySources.length === 0 ? <p className="text-sm text-gray-500">None.</p> : <ul className="text-sm">{data.noisySources.map((s) => <li key={s.source} className="flex justify-between border-b py-1"><code>{s.source.slice(0, 12)}…</code><span>{s.count}</span></li>)}</ul>}</Card>
          <Card><h2 className="mb-2 font-semibold">Recent events</h2><ul className="text-sm">{data.recent.map((r) => <li key={r.id} className="flex justify-between border-b py-1"><span>{r.event.replace(/_/g, ' ')}</span><span className="text-gray-500">{fmtDate(r.at)}</span></li>)}</ul></Card>
        </>
      ) : null}
      {isAdmin ? (
        <Card>
          <h2 className="mb-2 font-semibold">Block / unblock an identity</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <Input label="Identity id" value={identityId} onChange={(e) => setIdentityId(e.target.value)} placeholder="From a booking detail page" />
            <Input label="Reason (5–200 characters, audited)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
          </div>
          <div className="mt-3 flex gap-2"><Button variant="danger" disabled={!uuid || reason.trim().length < 5 || busy} onClick={() => act('block')}>Block</Button><Button variant="outline" disabled={!uuid || busy} onClick={() => act('unblock')}>Unblock</Button></div>
        </Card>
      ) : null}
    </div>
  );
};
export default GuestAbuse;
