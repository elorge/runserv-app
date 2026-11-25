import React from 'react';
import { Badge } from '@/components/common';
import HandoverExceptionPanel from './HandoverExceptionPanel';
import { useAuth } from '@/hooks/useAuth';
import SecureDocLink from '@/components/common/SecureDocLink';
import type { GuestBookingDetail } from '@/types/guestBooking';

interface Props { booking: GuestBookingDetail; canOverride: boolean; onChanged: () => void }

/**
 * Proof-of-delivery review. The photo is opened ONLY through the audited short-lived signed link (documents/access, source DELIVERY_PROOF):
 * no permanent storage URL is ever shown, stored or requested here. The override is shown only to ADMIN / SUPER_ADMIN (the server re-checks).
 */
const ProofPhotoViewer: React.FC<Props> = ({ booking, canOverride, onChanged }) => {
  const trip = booking.trip;
  const proof = booking.proof;
  const { user } = useAuth();
  if (booking.service !== 'PARCEL' || !trip || !proof) return null;

  const overridable = proof.required && !proof.verified && !proof.failed;

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

      {canOverride && overridable && trip.status === 'IN_TRANSIT' ? <HandoverExceptionPanel deliveryId={trip.id} audit={booking.audit} currentUserId={user?.id} onChanged={onChanged} /> : null}
    </div>
  );
};
export default ProofPhotoViewer;
