import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Button, Badge, Spinner, Alert } from '@/components/common';
import RecoveryActions from '@/components/guestBookings/RecoveryActions';
import CodeLifecycleView from '@/components/guestBookings/CodeLifecycleView';
import { guestBookingsAPI } from '@/services/api/guestBookings';
import { useAuth } from '@/hooks/useAuth';
import type { AttentionItem } from '@/types/guestBooking';
import { StatusBadge, fmtDate, apiMessage } from './shared';

/**
 * Operations work list: parcels whose recipient has no working path to the hand-over code (every channel failed, or the code expired or locked).
 * The code is never shown. Resend and Rotate are ADMIN / SUPER_ADMIN only (the server re-checks). There is no push/email alert yet: this list is how failures are found.
 */
const GuestAttention: React.FC = () => {
  const { isAdmin } = useAuth();
  const [items, setItems] = useState<AttentionItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setItems((await guestBookingsAPI.attention()).items); } catch (e) { setItems(null); setError(apiMessage(e, 'Could not load the work list.')); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div><Link to="/guest-bookings" className="text-sm text-primary-600">← Guest bookings</Link><h1 className="text-2xl font-bold text-gray-900">Recipient attention</h1>
          <p className="text-sm text-gray-500">Parcels from the last 7 days whose recipient cannot currently receive or use the hand-over code. Resend sends the same code; Rotate issues a new one.</p></div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>Refresh</Button>
      </div>
      {error ? <Alert variant="error">{error}</Alert> : null}
      {loading ? <div className="flex justify-center p-10"><Spinner /></div> : items && items.length === 0 ? <Card><p className="text-sm text-gray-600">Nothing needs attention right now.</p></Card> : (items ?? []).map((it) => {
        const key = it.deliveryId ?? it.id; const registered = it.source === 'REGISTERED';
        return (
          <Card key={key}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {registered || !it.id ? <span className="font-semibold">{it.reference ?? `Delivery ${key.slice(0, 8)}`}</span> : <Link className="font-semibold text-primary-600" to={`/guest-bookings/${it.id}`}>{it.reference}</Link>}
                <Badge variant={registered ? 'info' : 'default'}>{registered ? 'Registered customer' : 'Guest'}</Badge><StatusBadge status={it.deliveryStatus} />
              </div>
              <span className="text-xs text-gray-500">Booked {fmtDate(it.createdAt)}</span>
            </div>
            <div className="mt-2 grid gap-2 text-sm sm:grid-cols-3">
              <div>Email: <b>{it.email.state.replace(/_/g, ' ').toLowerCase()}</b>{it.email.contact ? <span className="text-gray-500"> · {it.email.contact}</span> : null}</div>
              <div>SMS: <b>{it.sms.state.replace(/_/g, ' ').toLowerCase()}</b></div>
              <div>Overall: <b>{it.overall.toLowerCase()}</b></div>
            </div>
            <CodeLifecycleView code={it.code} recovery={it.recovery} />
            {isAdmin ? (openId === key ? (
              <div className="mt-3"><RecoveryActions target={registered ? { source: 'REGISTERED', deliveryId: it.deliveryId ?? it.id } : { source: 'GUEST', bookingId: it.id }} recovery={it.recovery} onDone={() => { setOpenId(null); load(); }} />
                <button className="mt-2 text-xs text-gray-500 underline" onClick={() => setOpenId(null)}>Cancel</button></div>
            ) : <div className="mt-3"><Button size="sm" variant={it.recovery === 'ROTATE' ? 'danger' : 'primary'} onClick={() => setOpenId(key)}>{it.recovery === 'ROTATE' ? 'Rotate code…' : 'Resend code…'}</Button></div>) : null}
          </Card>
        );
      })}
    </div>
  );
};
export default GuestAttention;
