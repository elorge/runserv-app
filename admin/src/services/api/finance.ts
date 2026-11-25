// WP-01/WP-08 staff API: ledger reconciliation (/admin/finance) and operations alerts (/admin/alerts).
import api from './index';
const d = <T>(p: Promise<any>): Promise<T> => p.then((r) => r.data.data as T);

export interface ReconException { type: string; kind: string; id: string; currency?: string; balance?: number; ledger?: number | null; variance?: number }
export interface ReconRun { id: string; trigger: string; status: 'RUNNING' | 'OK' | 'EXCEPTIONS' | 'FAILED'; startedAt: string; finishedAt?: string | null; summary?: any; exceptions?: ReconException[]; error?: string | null }
export interface LedgerRow { id: string; entryGroup: string; account: string; currency: string; direction: 'DEBIT' | 'CREDIT'; amount: string | number; refType: string; refId: string; memo?: string | null; createdAt: string }
export interface OpsAlert { id: string; kind: string; severity: string; status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED'; title: string; message?: string; createdAt: string; occurrences?: number; resolutionNote?: string | null }

export const financeAPI = {
  latest: () => d<{ run: ReconRun | null }>(api.get('/admin/finance/reconciliation/latest')).then((r) => r.run),
  runs: (cursor?: string) => d<{ items: ReconRun[]; nextCursor: string | null }>(api.get('/admin/finance/reconciliation/runs', { params: { cursor } })),
  run: (id: string) => d<{ run: ReconRun }>(api.get(`/admin/finance/reconciliation/runs/${id}`)).then((r) => r.run),
  start: () => d<{ run: ReconRun }>(api.post('/admin/finance/reconciliation/run')).then((r) => r.run),
  ledger: (params: { account?: string; refType?: string; refId?: string; cursor?: string }) => d<{ items: LedgerRow[]; nextCursor: string | null }>(api.get('/admin/finance/ledger', { params })),
};
export const alertsAPI = {
  list: (params: { status?: string; kind?: string; cursor?: string }) => d<{ alerts: OpsAlert[]; nextCursor: string | null; openCount: number }>(api.get('/admin/alerts', { params })),
  acknowledge: (id: string) => d<unknown>(api.post(`/admin/alerts/${id}/acknowledge`)),
  resolve: (id: string, note: string) => d<unknown>(api.post(`/admin/alerts/${id}/resolve`, { note })),
};

export interface AuditRow { id: string; createdAt: string; action: string; entityType: string; entityId?: string | null; userId?: string | null; ipAddress?: string | null; details?: any; user?: { firstName?: string; lastName?: string; email?: string; role?: string } | null }
export const auditAPI = {
  list: (params: Record<string, string | undefined>) => d<{ items: AuditRow[]; nextCursor: string | null }>(api.get('/admin/audit-logs', { params })),
  facets: () => d<{ actions: string[]; entityTypes: string[] }>(api.get('/admin/audit-logs/facets')),
  exportCsv: (params: Record<string, string | undefined>) => api.get('/admin/audit-logs/export', { params, responseType: 'blob' }).then((r) => r.data as Blob),
};
