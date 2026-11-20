// Small shared bits for the company portal pages.
import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { Badge } from '@/components/common';
import type { AuditStatus } from '@/types/company';

export const StatCard: React.FC<{ label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'default' | 'warn' | 'good' | 'bad' }> =
  ({ label, value, sub, tone = 'default' }) => {
    const ring = { default: 'border-gray-100', warn: 'border-amber-200 bg-amber-50/40', good: 'border-emerald-200 bg-emerald-50/40', bad: 'border-red-200 bg-red-50/40' }[tone];
    return (
      <div className={`rounded-xl border bg-white p-4 shadow-sm ${ring}`}>
        <p className="text-xs font-medium text-gray-500">{label}</p>
        <p className="text-2xl font-bold text-gray-900 mt-1 tabular-nums">{value}</p>
        {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
      </div>
    );
  };

export const PageHeader: React.FC<{ title: string; subtitle?: string; right?: React.ReactNode }> = ({ title, subtitle, right }) => (
  <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
    <div>
      <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
      {subtitle && <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>}
    </div>
    <div className="flex items-center gap-2">{right}</div>
  </div>
);

/** <input type="month"> wrapper that speaks 'YYYY-MM'. */
export const MonthPicker: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => (
  <input type="month" value={value} max={new Date().toISOString().slice(0, 7)}
    onChange={(e) => e.target.value && onChange(e.target.value)}
    className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary-500" />
);

export const currentPeriod = () => new Date().toISOString().slice(0, 7);

export const monthLabel = (period: string) => {
  const [y, m] = period.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
};

export const AuditBadge: React.FC<{ status: AuditStatus }> = ({ status }) => (
  <Badge variant={status === 'VERIFIED' ? 'success' : status === 'FLAGGED' ? 'error' : 'default'}>
    {status === 'UNREVIEWED' ? 'Not reviewed' : status === 'VERIFIED' ? 'Verified' : 'Flagged'}
  </Badge>
);

export const CopyChip: React.FC<{ text: string; label?: string }> = ({ text, label }) => {
  const [done, setDone] = useState(false);
  return (
    <button type="button" onClick={() => { navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-900 text-white font-mono text-sm hover:bg-gray-800">
      {label ?? text} {done ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5 text-white/60" />}
    </button>
  );
};

export const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-center text-sm text-gray-400 py-10">{children}</div>
);

export const fmtKm = (n: number | null | undefined) => (n == null ? '—' : `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 })} km`);
export const fmtDT = (d: string) => new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
