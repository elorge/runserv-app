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
