import React from 'react';
import { Badge } from '@/components/common';
import type { CodeLifecycle, RecoveryAction } from '@/types/guestBooking';
import { fmtDate } from '@/pages/GuestBookings/shared';

const CODE: Record<string, { text: string; variant: 'success' | 'warning' | 'error' | 'info' | 'default' }> = {
  ACTIVE: { text: 'Active', variant: 'success' }, EXPIRED: { text: 'Expired', variant: 'error' }, LOCKED: { text: 'Locked (too many wrong codes)', variant: 'error' },
  VERIFIED: { text: 'Used: hand-over verified', variant: 'success' }, NOT_REQUIRED: { text: 'No code required', variant: 'default' },
};

/** Hand-over code LIFECYCLE for Admin: a state, a version and an expiry. The code itself is never available here. */
const CodeLifecycleView: React.FC<{ code: CodeLifecycle; recovery: RecoveryAction }> = ({ code, recovery }) => {
  const s = CODE[code.state] ?? { text: code.state, variant: 'default' as const };
  return (
    <div className="mt-3 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">Hand-over code</span><Badge variant={s.variant}>{s.text}</Badge></div>
      <div className="mt-1 text-xs text-gray-600">Version {code.version}{code.legacy ? ' · legacy code (created before the upgrade; rotate to move it to the new scheme)' : ''}
        {' · '}{code.expiresAt ? `expires ${fmtDate(code.expiresAt)}` : 'no expiry set'}{code.rotatedAt ? ` · rotated ${fmtDate(code.rotatedAt)}` : ''}</div>
      {!code.expiryPolicyConfigured ? <div className="mt-1 text-xs text-amber-700">Code expiry (POD_CODE_TTL_HOURS) is not configured on the server.</div> : null}
      {recovery === 'ROTATE' ? <div className="mt-1 text-xs font-medium text-red-700">Recommended: Rotate. This code can no longer work.</div> : recovery === 'RESEND' ? <div className="mt-1 text-xs font-medium text-amber-700">Recommended: Resend. The recipient has not received the code.</div> : null}
    </div>
  );
};
export default CodeLifecycleView;
