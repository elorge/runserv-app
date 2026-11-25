import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { Button, Alert } from '@/components/common';
import { guestBookingsAPI } from '@/services/api/guestBookings';
import type { GuestAuditItem } from '@/types/guestBooking';
import { apiError, fmtDate } from '@/pages/GuestBookings/shared';

interface Props { deliveryId: string; audit: GuestAuditItem[]; currentUserId?: string; onChanged: () => void }

const EVENTS = ['MANUAL_HANDOVER_EXCEPTION_REQUESTED', 'MANUAL_HANDOVER_EXCEPTION_APPROVED', 'MANUAL_HANDOVER_EXCEPTION_REJECTED'];
const WINDOW_MS = 24 * 3600 * 1000;

/** The newest request for this delivery that has no later decision and is inside the server's 24 h window (mirrors openExceptionRequest on the server, which decides). */
export const findOpenRequest = (audit: GuestAuditItem[], deliveryId: string, now = Date.now()) => {
  const evs = audit.filter((a) => EVENTS.includes(a.event) && (a.meta as any)?.deliveryId === deliveryId && now - new Date(a.at).getTime() <= WINDOW_MS);
  const req = evs.filter((a) => a.event === 'MANUAL_HANDOVER_EXCEPTION_REQUESTED').sort((a, b) => +new Date(b.at) - +new Date(a.at))[0];
  if (!req) return null;
  return evs.some((a) => a.event !== 'MANUAL_HANDOVER_EXCEPTION_REQUESTED' && +new Date(a.at) >= +new Date(req.at)) ? null : req;
};

/**
 * Manual hand-over exception, two steps by two operators: REQUEST (reason + evidence), then a DIFFERENT authorised operator APPROVES or REJECTS.
 * Approving records proof by support and lets the courier complete without the code. A courier can never reach this. The server enforces every rule here.
 */
const HandoverExceptionPanel: React.FC<Props> = ({ deliveryId, audit, currentUserId, onChanged }) => {
  const open = findOpenRequest(audit, deliveryId);
  const meta = (open?.meta ?? {}) as Record<string, any>;
  const mine = !!open && !!currentUserId && meta.adminId === currentUserId;
  const [reason, setReason] = useState(''); const [evidence, setEvidence] = useState(''); const [decision, setDecision] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<{ message?: string }>, fallback: string, after: () => void) => {
    if (busy) return; setBusy(true);
    try { const r = await fn(); toast.success(r.message || 'Done.'); after(); onChanged(); }
    catch (e) { toast.error(apiError(e, fallback)); } finally { setBusy(false); }
  };
  const request = () => {
    if (reason.trim().length < 10 || evidence.trim().length < 10) { toast.error('Reason and evidence each need at least 10 characters.'); return; }
    if (!window.confirm('Request a manual hand-over exception? A second authorised operator must approve it.')) return;
    run(() => guestBookingsAPI.exceptionRequest(deliveryId, reason.trim(), evidence.trim()), 'The request was refused.', () => { setReason(''); setEvidence(''); });
  };
  const approve = () => {
    if (decision.trim().length < 10) { toast.error('Enter an approval reason (at least 10 characters).'); return; }
    if (!window.confirm('Approve the exception? Proof is recorded as a support override and the courier can complete the delivery without the code.')) return;
    run(() => guestBookingsAPI.podOverride(deliveryId, decision.trim()), 'The approval was refused.', () => setDecision(''));
  };
  const reject = () => {
    if (decision.trim().length < 5) { toast.error('Enter a rejection reason (at least 5 characters).'); return; }
    run(() => guestBookingsAPI.exceptionReject(deliveryId, decision.trim()), 'The rejection was refused.', () => setDecision(''));
  };

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
      <p className="mb-1 text-sm font-medium text-amber-900">Manual hand-over exception (two operators)</p>
      <p className="mb-2 text-xs text-amber-800">Use only when the recipient cannot give the code and the approved manual process has been followed. One operator requests; a different operator approves. The courier never sees this.</p>
      {open ? (
        <div className="space-y-2">
          <Alert variant="warning">Open request from {fmtDate(open.at)}{mine ? ' (you)' : ''}.<br />Reason: {String(meta.reason ?? '—')}<br />Evidence: {String(meta.evidence ?? '—')}</Alert>
          {mine ? <p className="text-xs text-amber-900">You requested this, so another authorised operator must approve it. You can still reject (withdraw) it.</p> : null}
          <textarea value={decision} onChange={(e) => setDecision(e.target.value)} rows={2} maxLength={300} aria-label="Decision reason" placeholder="Decision reason (approve: 10–300 characters, reject: 5–300; audited)" className="w-full rounded-md border border-gray-300 p-2 text-sm" />
          <div className="flex justify-end gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={reject}>Reject</Button><Button size="sm" variant="danger" disabled={busy || mine} onClick={approve}>Approve (record proof as support)</Button></div>
        </div>
      ) : (
        <div className="space-y-2">
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={300} aria-label="Exception reason" placeholder="Why can the code not be used? (10–300 characters)" className="w-full rounded-md border border-gray-300 p-2 text-sm" />
          <textarea value={evidence} onChange={(e) => setEvidence(e.target.value)} rows={2} maxLength={300} aria-label="Exception evidence" placeholder="Evidence: how was the recipient verified? (10–300 characters)" className="w-full rounded-md border border-gray-300 p-2 text-sm" />
          <div className="flex justify-end"><Button size="sm" variant="danger" disabled={busy} onClick={request}>Request exception</Button></div>
        </div>
      )}
      <p className="mt-2 text-xs text-gray-600">The page only shows what the audit trail holds; the server decides. Requests expire after 24 hours.</p>
    </div>
  );
};
export default HandoverExceptionPanel;
