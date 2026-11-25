import React from 'react';
import { Badge } from '@/components/common';

export const statusVariant = (s: string | null): 'default' | 'success' | 'warning' | 'error' | 'info' => {
  if (!s) return 'default';
  if (['COMPLETED', 'DELIVERED'].includes(s)) return 'success';
  if (['CANCELLED', 'FAILED', 'RETURNED_TO_SENDER'].includes(s)) return 'error';
  if (['REQUESTED', 'PENDING', 'SEARCHING'].includes(s)) return 'warning';
  return 'info';
};
export const StatusBadge: React.FC<{ status: string | null }> = ({ status }) => <Badge variant={statusVariant(status)}>{status ? status.replace(/_/g, ' ') : 'Unknown'}</Badge>;
export const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleString() : '—');
export const money = (n: number, c: string) => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: c }).format(n); } catch { return `${c} ${n}`; } };
export const apiMessage = (e: any, fallback: string) => e?.response?.data?.message || fallback;

/** Server refusal with its machine code (when the server exposes one) and cooldown. Falls back to the message text. */
export const apiError = (e: any, fallback: string) => {
  const d = e?.response?.data ?? {};
  const code: string | undefined = d.code;
  const wait = Number(d.retryAfterS);
  const hints: Record<string, string> = {
    SECOND_APPROVER_REQUIRED: 'A different authorised operator must approve this request.',
    EXCEPTION_NOT_REQUESTED: 'Request the exception first, with a reason and evidence.',
    CONFIRM_REQUIRED: 'Tick the confirmation box: the previous code will stop working.',
    CODE_EXPIRED: 'The code has expired. Rotate it to issue a new one.',
    CODE_LOCKED: 'The delivery is locked after too many wrong codes. Rotate the code.',
    RESEND_COOLDOWN: 'A notification was queued a moment ago. Wait before trying again.',
  };
  const base = d.message || (code && hints[code]) || fallback;
  return `${base}${Number.isFinite(wait) && wait > 0 ? ` (try again in ${wait}s)` : ''}${code ? ` [${code}]` : ''}`;
};
