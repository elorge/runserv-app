import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Card, Button, Badge, Spinner, Alert, Select, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/common';
import { guestBookingsAPI } from '@/services/api/guestBookings';
import { useAuth } from '@/hooks/useAuth';
import type { GuestEmailQueue, SmsStatus } from '@/types/guestBooking';
import { fmtDate, apiMessage } from './shared';

const REASON: Record<string, string> = {
  BREVO_ALLOCATION: 'Brevo allocation', BREVO_ALLOCATION_EXHAUSTED: 'Brevo allocation used up', BREVO_QUOTA_RESPONSE: 'Brevo reported its quota used',
  BREVO_PAUSED: 'Brevo paused', BREVO_DISABLED: 'Brevo off', TRANSIENT_FALLBACK: 'Brevo outage fallback',
};
const variant = (s: SmsStatus) => (s === 'SENT' ? 'success' : s === 'DEAD' ? 'error' : s === 'SKIPPED' ? 'default' : 'warning');
const bar = (pct: number) => (pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-green-500');

/**
 * Guest email verification queue + provider usage. Addresses are masked and codes are never shown. "Accepted" means the provider took the
 * message; only "Delivered" means a delivery event arrived. Pause/resume (ADMIN / SUPER_ADMIN) can only reduce sending: provider
 * allocations are fixed by the free-plan limits and cannot be raised from here.
 */
const GuestEmail: React.FC = () => {
  const { isAdmin } = useAuth();
  const [status, setStatus] = useState<SmsStatus | ''>('DEAD');
  const [data, setData] = useState<GuestEmailQueue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setData(await guestBookingsAPI.emailQueue({ status })); } catch (e) { setData(null); setError(apiMessage(e, 'Could not load the email queue.')); } finally { setLoading(false); }
  }, [status]);
  useEffect(() => { load(); }, [load]);

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    if (busy) return; setBusy(key);
    try { await fn(); toast.success(ok); load(); } catch (e) { toast.error(apiMessage(e, 'That did not work.')); } finally { setBusy(null); }
  };
  const u = data?.stats.usage;

  return (
    <div className="space-y-4 p-6">
      <div><Link to="/guest-bookings" className="text-sm text-primary-600">← Guest bookings</Link><h1 className="text-2xl font-bold text-gray-900">Guest email verification</h1>
        <p className="text-sm text-gray-500">Verification codes, recipient hand-over codes and tracking links sent by email through Brevo, then Resend. A failed message means every retry was used.</p></div>
      {data?.stats.alerts.map((a) => <Alert key={a} variant="warning">{a}</Alert>)}
      {u ? (
        <Card>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm text-gray-600">
            <span>Today ({u.windowKey}, {u.timezone}) · active tier: <b className="text-gray-900">{u.activeTier === 'brevo' ? 'Brevo' : 'Resend'}</b> · overall cap {u.hardCap}</span>
            <span>Counters reset {fmtDate(u.resetAt)}</span>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {u.providers.map((p) => (
              <div key={p.provider} className="rounded border border-gray-200 p-3">
                <div className="flex items-center justify-between"><b className="capitalize">{p.provider}</b>
                  <span className="flex items-center gap-2">{!p.enabled ? <Badge variant="default">Off</Badge> : p.paused ? <Badge variant="warning">Paused</Badge> : p.quotaExhausted ? <Badge variant="error">Quota used</Badge> : p.unhealthy ? <Badge variant="warning">Unhealthy</Badge> : <Badge variant="success">Active</Badge>}
                    {isAdmin && p.enabled ? <Button size="sm" variant="outline" disabled={busy === p.provider} onClick={() => act(p.provider, () => guestBookingsAPI.emailProvider(p.provider, !p.paused), p.paused ? 'Resumed.' : 'Paused.')}>{p.paused ? 'Resume' : 'Pause'}</Button> : null}</span></div>
                <div className="mt-2 h-2 w-full rounded bg-gray-100"><div className={`h-2 rounded ${bar(p.percentUsed)}`} style={{ width: `${Math.min(100, p.percentUsed)}%` }} /></div>
                <p className="mt-1 text-xs text-gray-600">{p.reserved} / {p.allocation} used · {p.remaining} left · {p.accepted} accepted</p>
              </div>
            ))}
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2"><div><p className="text-xs text-gray-500">Waiting to send</p><p className="text-2xl font-bold">{data!.stats.pending}</p></div><div><p className="text-xs text-gray-500">Failed permanently</p><p className="text-2xl font-bold text-red-600">{data!.stats.dead}</p></div></div>
        </Card>
      ) : null}
      <Card><div className="max-w-xs"><Select label="Status" value={status} onChange={(e: any) => setStatus((e.target?.value ?? e) as SmsStatus | '')}
        options={[{ value: 'DEAD', label: 'Failed' }, { value: 'PENDING', label: 'Waiting' }, { value: 'SENT', label: 'Sent' }, { value: 'SKIPPED', label: 'Skipped' }, { value: '', label: 'All' }]} /></div></Card>
      {error ? <Alert variant="error">{error}</Alert> : null}
      <Card padding={false}>
        {loading ? <div className="flex justify-center p-10"><Spinner /></div> : (
          <Table>
            <TableHeader><TableRow><TableHead>Created</TableHead><TableHead>Message / to</TableHead><TableHead>Status</TableHead><TableHead>Provider / route</TableHead><TableHead>Delivery</TableHead><TableHead>Tries</TableHead><TableHead>Last error</TableHead><TableHead>Action</TableHead></TableRow></TableHeader>
            <TableBody>
              {!data || data.messages.length === 0 ? <tr><td colSpan={8} className="px-6 py-8 text-center text-gray-500">No messages in this view.</td></tr> : data.messages.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>{fmtDate(m.createdAt)}</TableCell><TableCell>{({ GUEST_OTP: 'Verification code', RECIPIENT_CODE: 'Recipient hand-over code + link', GUEST_TRACKING: 'Sender tracking link' } as Record<string, string>)[m.kind] ?? m.kind}<div className="text-xs text-gray-500">{m.to}{m.reference && m.bookingId ? <> · <a className="text-primary-600" href={`/guest-bookings/${m.bookingId}`}>{m.reference}</a></> : null}</div></TableCell>
                  <TableCell><Badge variant={variant(m.status)}>{m.status === 'DEAD' ? 'Failed' : m.status.charAt(0) + m.status.slice(1).toLowerCase()}</Badge></TableCell>
                  <TableCell className="capitalize">{m.provider ?? '—'}<div className="text-xs normal-case text-gray-500">{m.routeReason ? (REASON[m.routeReason] ?? m.routeReason) : ''}</div></TableCell>
                  <TableCell>{m.deliveryStatus === 'DELIVERED' ? 'Delivered' : m.deliveryStatus === 'ACCEPTED' ? 'Accepted (not yet confirmed)' : m.deliveryStatus ?? '—'}</TableCell>
                  <TableCell>{m.attempts}</TableCell><TableCell><span className="text-xs text-gray-600">{m.errorCategory ? `${m.errorCategory}: ` : ''}{m.lastError ?? '—'}</span></TableCell>
                  <TableCell>{m.status === 'DEAD' ? (isAdmin && m.canRetry ? <Button size="sm" variant="outline" disabled={busy === m.id} onClick={() => act(m.id, () => guestBookingsAPI.emailRetry(m.id), 'Re-queued.')}>Re-send</Button> : <span className="text-xs text-amber-700">{m.bookingId ? 'Open the booking to resend or correct the contact' : 'Ask the guest to request a new code'}</span>) : null}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
};
export default GuestEmail;
