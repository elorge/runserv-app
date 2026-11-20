import api from './index';
import type { DashboardData, PortalProfile, CompanyProfile, Invoice, StaffRow, Trip, WeekendRequest, ApprovalItem, Department, DirectoryEntry, Funding, BillingMode } from '@/types/company';

interface Page { total: number; page: number; pages: number }
const d = <T>(p: Promise<any>): Promise<T> => p.then((r) => r.data.data as T);

export interface TripQuery { period?: string; employeeId?: string; departmentId?: string; costCenter?: string; type?: string; status?: string; auditStatus?: string; weekend?: string; page?: number; limit?: number }

export const companyAPI = {
  profile: () => d<PortalProfile>(api.get('/corporate/profile')),
  updateSettings: (body: Record<string, unknown>) => d<{ company: CompanyProfile }>(api.put('/corporate/settings', body)),
  updateBranding: (body: Record<string, unknown>) => d<{ company: CompanyProfile }>(api.put('/corporate/branding', body)),
  dashboard: (period?: string) => d<DashboardData>(api.get('/corporate/dashboard', { params: { period } })),

  departments: () => d<{ departments: Department[] }>(api.get('/corporate/departments')).then((r) => r.departments),
  saveDepartment: (id: string | null, body: Record<string, unknown>) => (id ? api.put(`/corporate/departments/${id}`, body) : api.post('/corporate/departments', body)),

  directory: (params: { search?: string; status?: string; page?: number }) => d<{ entries: DirectoryEntry[]; pagination: Page }>(api.get('/corporate/directory', { params })),
  importDirectory: (rows: Record<string, unknown>[]) => d<{ created: number; updated: number; departmentsCreated: number; skipped: { row: number; reason: string }[] }>(api.post('/corporate/directory/import', { rows })),
  markExited: (id: string, reason?: string) => api.post(`/corporate/directory/${id}/exit`, { reason }),

  staff: (params: { requests?: boolean; status?: string; search?: string; departmentId?: string; page?: number; limit?: number }) =>
    d<{ employees: StaffRow[]; pagination: Page }>(api.get('/corporate/employees', { params: { ...params, requests: params.requests ? 'true' : undefined } })),
  reviewStaff: (id: string, body: { approve: boolean; departmentId?: string; supervisorId?: string | null; monthlyLimit?: number; note?: string }) => api.post(`/corporate/employees/${id}/review`, body),
  delist: (id: string, reason: string) => api.post(`/corporate/employees/${id}/delist`, { reason }),
  setRole: (id: string, role: string) => api.put(`/corporate/employees/${id}/role`, { role }),
  updateStaff: (id: string, body: Record<string, unknown>) => api.put(`/corporate/employees/${id}`, body),
  staffHistory: (id: string, period?: string) => d<{
    period: string; currency: string;
    employee: { id: string; name: string; phone: string; email: string; staffNumber: string | null; department: string | null; costCenter: string | null; supervisor: string | null; jobTitle: string | null; monthlyLimit: number; status: string };
    summary: { trips: number; spend: number; distanceKm: number; avgCostPerKm: number | null; weekendTrips: number; flagged: number; noPurpose: number };
    trips: Trip[];
  }>(api.get(`/corporate/employees/${id}/history`, { params: { period } })),

  weekendRequests: (status?: string) => d<{ requests: WeekendRequest[] }>(api.get('/corporate/weekend-requests', { params: { status, limit: 100 } })).then((r) => r.requests),
  reviewWeekend: (id: string, approve: boolean, note?: string) => api.post(`/corporate/weekend-requests/${id}/review`, { approve, note }),
  approvals: (status?: string) => d<{ approvals: ApprovalItem[] }>(api.get('/corporate/approvals', { params: { status, limit: 100 } })).then((r) => r.approvals),
  decideApproval: (id: string, approve: boolean, note?: string) => api.post(`/corporate/approvals/${id}/decide`, { approve, note }),

  trips: (q: TripQuery) => d<{ trips: Trip[]; pagination: Page; summary: { trips: number; spend: number; distanceKm: number; avgCostPerKm: number | null; currency: string } }>(api.get('/corporate/trips', { params: q })),
  auditTrip: (id: string, status: string, note?: string) => api.put(`/corporate/trips/${id}/audit`, { status, note: note || null }).then((r) => r.data.data.trip as Trip),

  billing: () => d<{
    period: string; currency: string; billingMode: BillingMode; verificationStatus: string; paymentTermsDays: number; subscriptionFee: number; funding: Funding;
    month: { trips: number; total: number; fromWallet: number; onCredit: number; distanceKm: number; willBeInvoicedOn: string }; invoices: Invoice[];
  }>(api.get('/corporate/billing')),
  invoice: (id: string) => d<{
    invoice: Invoice; company: { name: string; address: string | null; orgCode: string };
    payments: { id: string; amount: number; method: string; reference: string | null; receivedAt: string }[];
    byCostCenter: { costCenter: string; trips: number; total: number }[];
    byEmployee: { id: string; name: string; staffNumber: string | null; department: string | null; trips: number; distanceKm: number; total: number }[]; trips: Trip[];
  }>(api.get(`/corporate/invoices/${id}`)),
  walletTransactions: (page = 1) => d<{ transactions: { id: string; type: string; amount: number; balanceAfter: number; description: string; createdAt: string }[]; balance: number; pagination: Page }>(api.get('/corporate/wallet/transactions', { params: { page } })),
  initiateTopUp: (amount: number) => d<{ authorizationUrl: string; reference: string }>(api.post('/corporate/wallet/topup/initiate', { amount, callbackUrl: `${window.location.origin}/company/billing` })),
  verifyTopUp: (reference: string) => api.post('/corporate/wallet/topup/verify', { reference }),
};

export const errMsg = (e: any, fallback = 'Something went wrong') => e?.response?.data?.message || e?.message || fallback;
