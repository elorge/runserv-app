import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Card, Button, Badge, Spinner, Alert, Select, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/common';
import { guestBookingsAPI } from '@/services/api/guestBookings';
import { useAuth } from '@/hooks/useAuth';
import type { GuestSmsQueue, SmsStatus } from '@/types/guestBooking';
import { fmtDate, apiMessage } from './shared';

const KIND: Record<string, string> = { GUEST_TRACKING: 'Tracking link to guest', RECIPIENT_CODE: 'Hand-over code to recipient' };
const variant = (s: SmsStatus) => (s === 'SENT' ? 'success' : s === 'DEAD' ? 'error' : s === 'SKIPPED' ? 'default' : 'warning');

/**
 * Guest SMS queue. A DEAD message means the tracking link or the hand-over code never reached its recipient: support should call the
 * guest. Numbers are masked, and message text is never stored. Re-queue is ADMIN / SUPER_ADMIN only (the server re-checks).
 */
const GuestSms: React.FC = () => {
  const { isAdmin } = useAuth();
  const [status, setStatus] = useState<SmsStatus | ''>('DEAD');
  const [data, setData] = useState<GuestSmsQueue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setData(await guestBookingsAPI.smsQueue({ status })); } catch (e) { setData(null); setError(apiMessage(e, 'Could not load the SMS queue.')); } finally { setLoading(false); }
  }, [status]);
  useEffect(() => { load(); }, [load]);

  const retry = async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    try { const r = await guestBookingsAPI.smsRetry(id); toast.success(r.message || 'Re-queued.'); load(); }
    catch (e) { toast.error(apiMessage(e, 'Could not re-queue this message.')); } finally { setBusyId(null); }
  };

  return (
    <div className="space-y-4 p-6">
      <div><Link to="/guest-bookings" className="text-sm text-primary-600">← Guest bookings</Link><h1 className="text-2xl font-bold text-gray-900">Guest SMS queue</h1>
        <Link to="/guest-bookings/email" className="text-sm text-primary-600">Email verification queue →</Link>
        <p className="text-sm text-gray-500">Tracking links and recipient hand-over codes. Failed messages are retried automatically; “failed” below means every retry was used.</p></div>
      {data?.stats.alerts.map((a) => <Alert key={a} variant="warning">{a}</Alert>)}
      {data ? <div className="grid gap-3 sm:grid-cols-2"><Card><p className="text-xs text-gray-500">Waiting to send</p><p className="text-2xl font-bold">{data.stats.pending}</p></Card><Card><p className="text-xs text-gray-500">Failed permanently</p><p className="text-2xl font-bold text-red-600">{data.stats.dead}</p></Card></div> : null}
      <Card><div className="max-w-xs"><Select label="Status" value={status} onChange={(e: any) => setStatus((e.target?.value ?? e) as SmsStatus | '')}
        options={[{ value: 'DEAD', label: 'Failed' }, { value: 'PENDING', label: 'Waiting' }, { value: 'SENT', label: 'Sent' }, { value: 'SKIPPED', label: 'Skipped' }, { value: '', label: 'All' }]} /></div></Card>
      {error ? <Alert variant="error">{error}</Alert> : null}
      <Card padding={false}>
        {loading ? <div className="flex justify-center p-10"><Spinner /></div> : (
          <Table>
            <TableHeader><TableRow><TableHead>Booking</TableHead><TableHead>Message</TableHead><TableHead>To</TableHead><TableHead>Status</TableHead><TableHead>Tries</TableHead><TableHead>Last error</TableHead><TableHead>Action</TableHead></TableRow></TableHeader>
            <TableBody>
              {!data || data.messages.length === 0 ? <tr><td colSpan={7} className="px-6 py-8 text-center text-gray-500">No messages in this view.</td></tr> : data.messages.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>{m.reference ? <Link className="font-medium text-primary-600" to={`/guest-bookings/${m.bookingId}`}>{m.reference}</Link> : '—'}<div className="text-xs text-gray-500">{fmtDate(m.createdAt)}</div></TableCell>
                  <TableCell>{KIND[m.kind] ?? m.kind}</TableCell><TableCell>{m.to}</TableCell>
                  <TableCell><Badge variant={variant(m.status)}>{m.status === 'DEAD' ? 'Failed' : m.status.charAt(0) + m.status.slice(1).toLowerCase()}</Badge></TableCell>
                  <TableCell>{m.attempts}</TableCell><TableCell><span className="text-xs text-gray-600">{m.lastError ?? '—'}</span></TableCell>
                  <TableCell>{m.status === 'DEAD' ? (isAdmin && m.canRetry ? <Button size="sm" variant="outline" disabled={busyId === m.id} onClick={() => retry(m.id)}>{busyId === m.id ? 'Queuing…' : 'Re-send'}</Button> : <span className="text-xs text-amber-700">Call the guest{m.canRetry ? '' : ' (number no longer stored)'}</span>) : null}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
};
export default GuestSms;
