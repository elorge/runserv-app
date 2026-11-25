import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { Button } from '@/components/common';
import { guestBookingsAPI } from '@/services/api/guestBookings';
import type { RecoveryAction } from '@/types/guestBooking';
import { apiError } from '@/pages/GuestBookings/shared';

interface Props {
  /** Guest parcels are addressed by booking id; registered-customer parcels (Option B) by delivery id. */
  target: { source: 'GUEST'; bookingId: string } | { source: 'REGISTERED'; deliveryId: string };
  recovery?: RecoveryAction;
  disabled?: boolean;
  onDone: () => void;
  cooldownS?: number;
}

/**
 * Resend (same code) and Rotate (NEW code, the old one stops working). Both are ADMIN / SUPER_ADMIN only (the server re-checks), need a reason and
 * are audited. Rotate additionally needs an explicit confirmation. `recovery` is the server's recommendation: it highlights one button, never hides the other.
 */
const RecoveryActions: React.FC<Props> = ({ target, recovery, disabled, onDone, cooldownS }) => {
  const [reason, setReason] = useState('');
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [busy, setBusy] = useState<'resend' | 'rotate' | null>(null);
  const r = reason.trim();

  const run = async (kind: 'resend' | 'rotate') => {
    if (busy) return;
    if (kind === 'resend' && r.length < 5) { toast.error('Enter a reason (at least 5 characters).'); return; }
    if (kind === 'rotate' && r.length < 10) { toast.error('Enter a reason for rotating (at least 10 characters).'); return; }
    if (kind === 'rotate' && !confirmRotate) { toast.error('Tick the box to confirm the previous code will stop working.'); return; }
    if (kind === 'resend' && !window.confirm('Resend the hand-over code and tracking link? The recipient receives the SAME code.')) return;
    if (kind === 'rotate' && !window.confirm('Issue a NEW code? The earlier code stops working immediately and the recipient is told so.')) return;
    setBusy(kind);
    try {
      const api = guestBookingsAPI;
      const res = target.source === 'GUEST'
        ? (kind === 'resend' ? await api.resendRecipient(target.bookingId, r) : await api.rotateRecipient(target.bookingId, r))
        : (kind === 'resend' ? await api.resendRecipientByDelivery(target.deliveryId, r) : await api.rotateRecipientByDelivery(target.deliveryId, r));
      toast.success(res.message || 'Done.'); setReason(''); setConfirmRotate(false); onDone();
    } catch (e) { toast.error(apiError(e, kind === 'resend' ? 'The resend was refused.' : 'The rotation was refused.')); }
    finally { setBusy(null); }
  };

  return (
    <div className="space-y-2">
      <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} aria-label="Reason" placeholder="Reason (5–200 characters for resend, 10–200 for rotate; audited)" className="w-full rounded-md border border-gray-300 p-2 text-sm" />
      <label className="flex items-start gap-2 text-xs text-gray-700"><input type="checkbox" checked={confirmRotate} onChange={(e) => setConfirmRotate(e.target.checked)} className="mt-0.5" />
        <span>I confirm that rotating issues a new code and the previous code stops working at once.</span></label>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={recovery === 'RESEND' ? 'primary' : 'outline'} disabled={disabled || !!busy} onClick={() => run('resend')}>{busy === 'resend' ? 'Sending…' : 'Resend same code'}</Button>
        <Button size="sm" variant={recovery === 'ROTATE' ? 'danger' : 'outline'} disabled={disabled || !!busy} onClick={() => run('rotate')}>{busy === 'rotate' ? 'Rotating…' : 'Rotate code (new code)'}</Button>
      </div>
      {cooldownS ? <p className="text-xs text-gray-500">At most one resend or rotation every {cooldownS}s. Resend is refused for an expired or locked code: rotate instead.</p> : null}
    </div>
  );
};
export default RecoveryActions;
