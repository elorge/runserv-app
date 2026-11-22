import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Card, Button, Spinner, Alert, Badge } from '@/components/common';
import ProofPhotoViewer from '@/components/guestBookings/ProofPhotoViewer';
import { guestBookingsAPI } from '@/services/api/guestBookings';
import { useAuth } from '@/hooks/useAuth';
import type { GuestBookingDetail as Detail, ChannelStatus } from '@/types/guestBooking';
import { StatusBadge, fmtDate, money, apiMessage } from './shared';

const Row: React.FC<{ k: string; v: React.ReactNode }> = ({ k, v }) => <div className="flex justify-between gap-4 border-b py-1.5 text-sm"><span className="text-gray-500">{k}</span><span className="text-right font-medium">{v}</span></div>;

const STATE_LABEL: Record<string, { text: string; variant: 'success' | 'warning' | 'error' | 'info' | 'default' }> = {
  DISABLED: { text: 'Off (not attempted)', variant: 'default' }, NOT_PROVIDED: { text: 'No contact given', variant: 'warning' }, NOT_QUEUED: { text: 'Not queued', variant: 'warning' },
  QUEUED: { text: 'Queued', variant: 'info' }, RETRYING: { text: 'Retrying', variant: 'warning' }, ACCEPTED: { text: 'Accepted by provider', variant: 'success' },
  DELIVERED: { text: 'Delivered', variant: 'success' }, FAILED: { text: 'Failed', variant: 'error' }, SKIPPED: { text: 'Skipped (no longer needed)', variant: 'default' },
};
const Channel: React.FC<{ name: string; c: ChannelStatus }> = ({ name, c }) => {
  const s = STATE_LABEL[c.state] ?? { text: c.state, variant: 'default' as const };
  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="flex items-center justify-between"><span className="font-medium">{name}</span><Badge variant={s.variant}>{s.text}</Badge></div>
      <div className="mt-1 text-gray-500">{c.contact ?? 'No contact'}</div>
      {c.provider ? <div className="mt-1 text-xs text-gray-500">Provider: {c.provider}{c.providerMessageId ? ` · ref ${c.providerMessageId}` : ''}</div> : null}
      {c.deliveryStatus && c.deliveryStatus !== 'ACCEPTED' ? <div className="mt-1 text-xs text-gray-500">Provider report: {c.deliveryStatus.replace(/_/g, ' ').toLowerCase()}</div> : null}
      {c.lastError && ['FAILED', 'RETRYING'].includes(c.state) ? <div className="mt-1 text-xs text-red-600">{c.errorCategory ? `${c.errorCategory}: ` : ''}{c.lastError}</div> : null}
    </div>
  );
};

const GuestBookingDetail: React.FC = () => {
  const { id = '' } = useParams();
  const { isAdmin } = useAuth();
  const [b, setB] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setB(await guestBookingsAPI.get(id)); } catch (e) { setB(null); setError(apiMessage(e, 'Booking not found.')); } finally { setLoading(false); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const resend = async () => {
    if (!b || busy) return;
    if (reason.trim().length < 5) { toast.error('Enter a reason (at least 5 characters).'); return; }
    if (!window.confirm('Resend the hand-over code and tracking link to the recipient? They receive the SAME code.')) return;
    setBusy(true);
    try { const r = await guestBookingsAPI.resendRecipient(b.id, reason.trim()); toast.success(r.message || 'Re-queued.'); setReason(''); load(); }
    catch (e) { toast.error(apiMessage(e, 'The resend was refused.')); } finally { setBusy(false); }
  };

  const toggleBlock = async () => {
    if (!b || busy) return;
    if (!b.blocked && reason.trim().length < 5) { toast.error('Enter a reason (at least 5 characters).'); return; }
    if (!window.confirm(b.blocked ? 'Unblock this guest?' : 'Block this guest? Their sessions are revoked.')) return;
    setBusy(true);
    try { const r = b.blocked ? await guestBookingsAPI.unblock(b.identityId) : await guestBookingsAPI.block(b.identityId, reason.trim()); toast.success(r.message || 'Done.'); setReason(''); load(); }
    catch (e) { toast.error(apiMessage(e, 'The action was refused.')); } finally { setBusy(false); }
  };

  if (loading) return <div className="flex justify-center p-16"><Spinner /></div>;
  if (error || !b) return <div className="p-6"><Link to="/guest-bookings" className="text-sm text-primary-600">← Guest bookings</Link><Alert variant="error">{error || 'Booking not found.'}</Alert></div>;

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><Link to="/guest-bookings" className="text-sm text-primary-600">← Guest bookings</Link><h1 className="text-2xl font-bold text-gray-900">{b.reference}</h1></div>
        <div className="flex items-center gap-2"><StatusBadge status={b.status} />{b.blocked ? <Badge variant="error">Identity blocked</Badge> : null}{b.converted ? <Badge variant="info">Converted to account</Badge> : null}</div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card><h2 className="mb-2 font-semibold">Booking</h2>
          <Row k="Service" v={b.service === 'PARCEL' ? 'Parcel' : 'Ride'} /><Row k="Vehicle" v={b.vehicleType} /><Row k="Fare" v={money(b.fare, b.currency)} /><Row k="Created" v={fmtDate(b.createdAt)} />
          <Row k="Phone (masked)" v={b.phone} /><Row k="Verified" v={fmtDate(b.phoneVerifiedAt)} /><Row k="Market" v={b.countryCode ?? '—'} />
          <Row k="Tracking link" v={b.trackingRevoked ? 'Revoked' : `Active until ${fmtDate(b.trackingExpiresAt)}`} /><Row k="Assigned to" v={b.assignedTo ? `${b.assignedTo.name} (${b.assignedTo.role})` : 'Not assigned'} />
        </Card>
        <Card><h2 className="mb-2 font-semibold">Trip</h2>
          {b.trip ? (<><Row k="From" v={b.trip.pickupAddress} /><Row k="To" v={b.trip.dropoffAddress} /><Row k="Requested" v={fmtDate(b.trip.requestedAt)} /><Row k="Accepted" v={fmtDate(b.trip.acceptedAt)} /><Row k="Started" v={fmtDate(b.trip.startedAt)} /><Row k="Completed" v={fmtDate(b.trip.completedAt)} />
            {b.trip.cancelledAt ? <Row k="Cancelled" v={`${fmtDate(b.trip.cancelledAt)} — ${b.trip.cancellationReason ?? ''}`} /> : null}</>) : <p className="text-sm text-gray-500">No trip is attached yet.</p>}
        </Card>
      </div>

      {b.service === 'PARCEL' ? <Card><h2 className="mb-2 font-semibold">Proof of delivery</h2><ProofPhotoViewer booking={b} canOverride={isAdmin} onChanged={load} />
        {b.proof?.failedFee ? <p className="mt-2 text-sm text-amber-700">Recipient-side failure: return fee {money(b.proof.failedFee.amount, b.proof.failedFee.currency)} owed to the courier in cash.</p> : b.proof?.supportReview ? <p className="mt-2 text-sm text-amber-700">This failure needs support review before any charge.</p> : null}</Card> : null}

      {b.service === 'PARCEL' && b.communications ? (
        <Card><h2 className="mb-2 font-semibold">Recipient communications</h2>
          <p className="mb-3 text-sm text-gray-500">The hand-over code and tracking link go to the recipient. A message "accepted" by a provider is not proof the recipient has read it, and a sent notification is not a delivered parcel. The code is never shown here.</p>
          <div className="grid gap-3 sm:grid-cols-2"><Channel name="Email" c={b.communications.email} /><Channel name="SMS" c={b.communications.sms} /></div>
          {b.communications.overall === 'UNRESOLVED' ? <Alert variant="error">No channel has reached the recipient. Resend, then use the approved manual contact process. Never let the courier bypass the code.</Alert> : null}
          {b.communications.partial ? <p className="mt-2 text-sm text-amber-700">One channel failed; the other was accepted. Operations should still follow up on the failed channel.</p> : null}
          {isAdmin && b.proof && !b.proof.verified && !b.proof.failed && b.status !== 'CANCELLED' ? (
            <div className="mt-3 space-y-2">
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} aria-label="Resend reason" placeholder="Reason for resending (5–200 characters, audited)" className="w-full rounded-md border border-gray-300 p-2 text-sm" />
              <Button variant="outline" disabled={busy || (!b.communications.email.enabled && !b.communications.sms.enabled)} onClick={resend}>Resend code and tracking link</Button>
              <p className="text-xs text-gray-500">Same code, no rotation. At most one resend every {b.communications.resendCooldownS}s.</p>
            </div>
          ) : null}
        </Card>
      ) : null}

      {isAdmin ? (
        <Card><h2 className="mb-2 font-semibold">{b.blocked ? 'Unblock guest' : 'Block guest'}</h2>
          {!b.blocked ? <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} aria-label="Block reason" placeholder="Reason (5–200 characters, audited)" className="mb-2 w-full rounded-md border border-gray-300 p-2 text-sm" /> : null}
          <Button variant={b.blocked ? 'outline' : 'danger'} disabled={busy} onClick={toggleBlock}>{b.blocked ? 'Unblock' : 'Block this guest'}</Button></Card>
      ) : null}

      <Card><h2 className="mb-2 font-semibold">Audit trail</h2>
        {b.audit.length === 0 ? <p className="text-sm text-gray-500">No events.</p> : <ul className="text-sm">{b.audit.map((a) => <li key={a.id} className="flex justify-between border-b py-1"><span>{a.event.replace(/_/g, ' ')}</span><span className="text-gray-500">{fmtDate(a.at)}</span></li>)}</ul>}</Card>
    </div>
  );
};
export default GuestBookingDetail;
