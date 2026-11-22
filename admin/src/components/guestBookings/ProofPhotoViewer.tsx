import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { Button, Badge } from '@/components/common';
import SecureDocLink from '@/components/common/SecureDocLink';
import { guestBookingsAPI } from '@/services/api/guestBookings';
import type { GuestBookingDetail } from '@/types/guestBooking';

interface Props { booking: GuestBookingDetail; canOverride: boolean; onChanged: () => void }

/**
 * Proof-of-delivery review. The photo is opened ONLY through the audited short-lived signed link (documents/access, source DELIVERY_PROOF):
 * no permanent storage URL is ever shown, stored or requested here. The override is shown only to ADMIN / SUPER_ADMIN (the server re-checks).
 */
const ProofPhotoViewer: React.FC<Props> = ({ booking, canOverride, onChanged }) => {
  const trip = booking.trip;
  const proof = booking.proof;
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (booking.service !== 'PARCEL' || !trip || !proof) return null;

  const overridable = proof.required && !proof.verified && !proof.failed;
  const valid = reason.trim().length >= 10 && reason.trim().length <= 300;

  const submit = async () => {
    if (!valid || busy) return;
    if (!window.confirm('Record proof of delivery as support? This is audited and lets the courier complete the delivery.')) return;
    setBusy(true);
    try { const r = await guestBookingsAPI.podOverride(trip.id, reason.trim()); toast.success(r.message || 'Proof recorded.'); setReason(''); onChanged(); }
    catch (e: any) { toast.error(e?.response?.data?.message || 'Could not record the override.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={proof.verified ? 'success' : proof.failed ? 'error' : proof.locked ? 'warning' : 'default'}>
          {proof.verified ? 'Hand-over verified' : proof.failed ? `Failed: ${proof.failedReason ?? 'reason not recorded'}` : proof.locked ? 'Locked after wrong codes' : 'Awaiting hand-over'}
        </Badge>
        {trip.podMethod ? <Badge variant="info">{trip.podMethod === 'SUPPORT_OVERRIDE' ? 'Support override' : trip.podMethod}</Badge> : null}
        {typeof trip.podAttempts === 'number' ? <span className="text-xs text-gray-500">Wrong-code attempts: {trip.podAttempts}</span> : null}
      </div>

      {trip.hasPodPhoto ? (
        <SecureDocLink access={{ source: 'DELIVERY_PROOF', id: trip.id, field: 'podPhotoUrl', reason: 'Guest booking proof review' }} className="text-sm font-medium text-primary-600 underline">
          Open proof photo (secure link, audited)
        </SecureDocLink>
      ) : <p className="text-sm text-gray-500">No proof photo was uploaded.</p>}

      {canOverride && overridable ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="mb-2 text-sm font-medium text-amber-900">Support override</p>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={300} aria-label="Override reason"
            placeholder="Why is the hand-over being recorded without the code? (10–300 characters, stored in the audit trail)"
            className="w-full rounded-md border border-gray-300 p-2 text-sm" />
          <div className="mt-2 flex justify-end"><Button variant="danger" size="sm" disabled={!valid || busy} onClick={submit}>{busy ? 'Saving…' : 'Record proof as support'}</Button></div>
        </div>
      ) : null}
    </div>
  );
};
export default ProofPhotoViewer;
