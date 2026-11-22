// Shared types + tiny helpers for the Payment providers screens.
export interface ProviderRow {
  providerKey: string; name: string; countryCode: string; activeEnvironment: 'SANDBOX' | 'LIVE';
  configured: boolean; enabled: boolean; effective: boolean; effectiveReason: string; onboardingStatus: string;
  capabilities: { currencies?: string[]; services?: string[]; minAmount?: number | null; maxAmount?: number | null } | null;
  credentials: Record<string, boolean>; secretsRotatedAt: string | null; secretEntryAvailable: boolean;
  callbackUrl?: string | null; lastVerifiedAt?: string | null;
}
export interface ExceptionRow { id: string; provider: string; kind: string; paymentId: string | null; createdAt: string; status: string; detail?: unknown }
export interface ChangeRequest { id: string; providerKey: string; countryCode: string; environment: string; reason: string; status: string; requestedById: string }
export interface PaymentEventRow {
  id: string; createdAt: string; eventType: string; source: string; verification: string; outcome: string | null;
  fromStatus: string | null; toStatus: string | null; meta: unknown;
}

export const ONBOARDING_LABEL: Record<string, string> = {
  PLANNED: 'Planned', AWAITING_ONBOARDING: 'Awaiting onboarding', SANDBOX_ACCESS: 'Sandbox access',
  CERTIFICATION: 'Certification', PRODUCTION_APPROVED: 'Production approved',
};
export const ONBOARDING_ORDER = Object.keys(ONBOARDING_LABEL);
export const SERVICES = ['RIDE', 'DELIVERY'] as const;
export const SECRET_LABEL: Record<string, string> = {
  subscriptionKey: 'Subscription key', apiUser: 'API user', apiKey: 'API key', callbackSecret: 'Callback secret',
};

export const errMsg = (err: any, fallback = 'Action failed') => err?.response?.data?.message || fallback;

/** Minimal RFC-4180-ish CSV parser (quoted fields, escaped quotes, CRLF). */
export const parseCsv = (text: string): string[][] => {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(c => c.trim() !== '')) rows.push(row); row = []; }
    else cell += ch;
  }
  row.push(cell); if (row.some(c => c.trim() !== '')) rows.push(row);
  return rows;
};

export interface StatementRow { reference: string; amount: string; currency: string; status: string }
/** Turns a provider statement CSV into reconciliation rows. Header names are matched loosely. */
export const statementFromCsv = (text: string): { rows: StatementRow[]; error?: string } => {
  const table = parseCsv(text);
  if (table.length < 2) return { rows: [], error: 'The file has no data rows.' };
  const head = table[0].map(h => h.trim().toLowerCase().replace(/[^a-z]/g, ''));
  const find = (...names: string[]) => head.findIndex(h => names.includes(h));
  const iRef = find('reference', 'referenceid', 'externalid', 'transactionid', 'financialtransactionid', 'ref');
  const iAmt = find('amount', 'value');
  const iCur = find('currency', 'ccy');
  const iSt = find('status', 'state');
  if (iRef < 0 || iAmt < 0 || iSt < 0) return { rows: [], error: 'Header must include reference, amount and status columns (currency optional).' };
  const rows = table.slice(1).map(r => ({ reference: (r[iRef] || '').trim(), amount: (r[iAmt] || '').trim(), currency: iCur >= 0 ? (r[iCur] || '').trim().toUpperCase() : '', status: (r[iSt] || '').trim() })).filter(r => r.reference);
  if (!rows.length) return { rows: [], error: 'No rows with a reference were found.' };
  if (rows.length > 5000) return { rows: [], error: 'Too many rows (max 5000 per run). Split the file.' };
  return { rows };
};
