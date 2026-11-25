// Runserv-staff API for fleets (/admin/fleet) and bank partners / campaigns (/admin/banks).
import api from './index';
import type {
  FleetStats, FleetPartner, FleetDetail, FleetVehicle, FleetSettlement, FleetDocument, FleetStatus, VerificationStatus, VehicleStatus, SettlementStatus,
  BankPartner, BankStatus, BankCampaign, BankOffer, CampaignReport, BankSettlement, BankAccount, BankPayment, ReceiptsSummary, PaymentInstructions, Dec,
} from '@/types/partnerships';

const d = <T>(p: Promise<any>): Promise<T> => p.then((r) => r.data.data as T);
export const apiError = (e: any, fallback = 'Something went wrong') =>
  e?.response?.data?.message || e?.response?.data?.errors?.[0]?.msg || e?.message || fallback;

export interface VehicleQuery { status?: string; vehicleType?: string; fleetPartnerId?: string; q?: string; compliance?: string; page?: number; limit?: number }

/** Required when marking a fleet settlement PAID. */
export interface PaymentEvidence { paymentReference: string; paymentMethod: 'BANK_TRANSFER' | 'MOBILE_MONEY' | 'OTHER'; paidAmount: number; paymentNote?: string }

export interface TripReconciliation {
  window: { start: string; end: string }; checked: number; truncated: boolean;
  missing: { rideId?: string | null; deliveryId?: string | null; driverUserId: string; fleetPartnerId: string; fare: string | number; currency?: string; completedAt: string }[];
  amountMismatch: { fleetTripId: string; rideId?: string | null; deliveryId?: string | null; recordedFare: string; actualFare: string }[];
  fieldMismatch: { fleetTripId: string; rideId?: string | null; deliveryId?: string | null; diffs: { field: string; recorded: string; expected: string }[] }[];
  ambiguous: { rideId?: string | null; deliveryId?: string | null; driverUserId: string; completedAt: string; note: string }[];
}

export const fleetAdminAPI = {
  stats: () => d<FleetStats>(api.get('/admin/fleet/stats')),
  list: (params: { status?: string; q?: string; page?: number; limit?: number }) => d<{ total: number; fleets: FleetPartner[] }>(api.get('/admin/fleet/partners', { params })),
  get: (id: string) => d<FleetDetail>(api.get(`/admin/fleet/partners/${id}`)),
  setStatus: (id: string, status: FleetStatus, reason?: string) => d<{ fleetPartner: FleetPartner }>(api.put(`/admin/fleet/partners/${id}/status`, { status, reason: reason || undefined })),
  setVerification: (id: string, status: VerificationStatus, notes?: string) => d<{ fleetPartner: FleetPartner }>(api.put(`/admin/fleet/partners/${id}/verification`, { status, notes: notes || undefined })),
  setTerms: (id: string, body: { commissionRate?: number; settlementTermsDays?: number; note?: string }) => d<{ fleetPartner: FleetPartner }>(api.put(`/admin/fleet/partners/${id}/terms`, body)),
  vehicles: (params: VehicleQuery) => d<{ total: number; page: number; pages: number; vehicles: FleetVehicle[] }>(api.get('/admin/fleet/vehicles', { params })),
  setVehicleStatus: (id: string, status: VehicleStatus, reason?: string) => d<{ vehicle: FleetVehicle }>(api.put(`/admin/fleet/vehicles/${id}/status`, { status, reason: reason || undefined })),
  reviewDocument: (id: string, approved: boolean, note?: string) => d<{ document: FleetDocument }>(api.put(`/admin/fleet/documents/${id}/review`, { approved, note: note || undefined })),
  settlements: (params: { status?: string; fleetPartnerId?: string; limit?: number }) => d<{ settlements: FleetSettlement[] }>(api.get('/admin/fleet/settlements', { params })).then((r) => r.settlements),
  createSettlement: (body: { fleetPartnerId: string; periodStart: string; periodEnd: string; adjustments?: number }) => d<{ settlement: FleetSettlement; tripCount: number }>(api.post('/admin/fleet/settlements', body)),
  reconcileTrips: (params: { since?: string; until?: string }) => d<TripReconciliation>(api.get('/admin/fleet/reconciliation/trips', { params })),
  repairTrips: (body: { since?: string; until?: string }) => d<TripReconciliation & { repaired: number; failed: { rideId?: string; deliveryId?: string; error: string }[] }>(api.post('/admin/fleet/reconciliation/trips/repair', body)),
  transitionSettlement: (id: string, status: SettlementStatus, evidence?: PaymentEvidence) => d<{ settlement: FleetSettlement }>(api.put(`/admin/fleet/settlements/${id}/status`, { status, ...(evidence || {}) })),
};

export type BankPartnerInput = Partial<Pick<BankPartner, 'legalName' | 'displayName' | 'countryCode' | 'logoUrl' | 'websiteUrl' | 'contactEmail' | 'contactPhone' | 'agreementReference' | 'agreementStartAt' | 'agreementEndAt'>>;
export type OfferInput = Partial<Omit<BankOffer, 'id' | 'campaignId' | 'isPublished'>>;
export type CampaignInput = { bankPartnerId?: string; name?: string; description?: string; startsAt?: string | null; endsAt?: string | null; budgetAmount?: number | null; landingPageUrl?: string | null; attributionWindowDays?: number };
export type CampaignAction = 'submit' | 'approve' | 'reject' | 'pause' | 'resume' | 'cancel';

export const bankAdminAPI = {
  partners: (status?: string) => d<{ partners: BankPartner[] }>(api.get('/admin/banks/partners', { params: { status: status || undefined, limit: 100 } })).then((r) => r.partners),
  createPartner: (body: BankPartnerInput) => d<{ partner: BankPartner }>(api.post('/admin/banks/partners', body)),
  updatePartner: (id: string, body: BankPartnerInput) => d<{ partner: BankPartner }>(api.put(`/admin/banks/partners/${id}`, body)),
  setPartnerStatus: (id: string, status: BankStatus, reason?: string) => d<{ partner: BankPartner }>(api.put(`/admin/banks/partners/${id}/status`, { status, reason: reason || undefined })),

  campaigns: (params: { status?: string; bankPartnerId?: string }) => d<{ campaigns: BankCampaign[] }>(api.get('/admin/banks/campaigns', { params: { ...params, limit: 100 } })).then((r) => r.campaigns),
  campaign: (id: string) => d<{ campaign: BankCampaign; problems: string[] }>(api.get(`/admin/banks/campaigns/${id}`)),
  createCampaign: (body: CampaignInput) => d<{ campaign: BankCampaign }>(api.post('/admin/banks/campaigns', body)),
  updateCampaign: (id: string, body: CampaignInput) => d<{ campaign: BankCampaign; returnedToDraft: boolean }>(api.put(`/admin/banks/campaigns/${id}`, body)),
  act: (id: string, action: CampaignAction, body: { confirmWrittenApproval?: boolean; note?: string; reason?: string } = {}) => d<{ campaign: BankCampaign }>(api.post(`/admin/banks/campaigns/${id}/${action}`, body)),
  report: (id: string) => d<CampaignReport>(api.get(`/admin/banks/campaigns/${id}/report`)),
  addOffer: (campaignId: string, body: OfferInput) => d<{ offer: BankOffer }>(api.post(`/admin/banks/campaigns/${campaignId}/offers`, body)),
  updateOffer: (id: string, body: OfferInput) => d<{ offer: BankOffer; campaignReturnedToDraft: boolean }>(api.put(`/admin/banks/offers/${id}`, body)),
  deleteOffer: (id: string) => d<{ deleted: boolean }>(api.delete(`/admin/banks/offers/${id}`)),

  settlements: (params: { status?: string; bankPartnerId?: string }) => d<{ settlements: BankSettlement[] }>(api.get('/admin/banks/settlements', { params })).then((r) => r.settlements),
  createSettlement: (body: { bankPartnerId: string; campaignId?: string; periodStart: string; periodEnd: string; agreedAmount: number; adjustmentsAmount?: number; invoiceReference?: string }) => d<{ settlement: BankSettlement }>(api.post('/admin/banks/settlements', body)),
  transitionSettlement: (id: string, status: SettlementStatus, bankTransactionRef?: string) => d<{ settlement: BankSettlement }>(api.put(`/admin/banks/settlements/${id}/status`, { status, bankTransactionRef: bankTransactionRef || undefined })),
  accounts: (bankPartnerId?: string) => d<{ accounts: BankAccount[] }>(api.get('/admin/banks/receiving-accounts', { params: { bankPartnerId } })).then((r) => r.accounts),
  addAccount: (body: { bankPartnerId: string; accountName: string; accountNumber: string; bankName?: string; currency?: string; label?: string; isPrimary?: boolean }) => d<{ account: BankAccount }>(api.post('/admin/banks/receiving-accounts', body)),
  updateAccount: (id: string, body: { isActive?: boolean; isPrimary?: boolean; label?: string }) => d<{ account: BankAccount }>(api.put(`/admin/banks/receiving-accounts/${id}`, body)),
  rotateSecret: (bankPartnerId: string) => d<{ secret: string; version: number; note: string }>(api.post(`/admin/banks/partners/${bankPartnerId}/webhook-secret`)),
  instructions: (settlementId: string) => d<PaymentInstructions>(api.get(`/admin/banks/settlements/${settlementId}/payment-instructions`)),
  receiptsSummary: () => d<ReceiptsSummary>(api.get('/admin/banks/payments/summary')),
  payments: (params: { status?: string; bankPartnerId?: string; source?: string; limit?: number }) => d<{ payments: BankPayment[] }>(api.get('/admin/banks/payments', { params })).then((r) => r.payments),
  matchPayment: (id: string, settlementId: string, note: string) => d<{ payment: BankPayment }>(api.post(`/admin/banks/payments/${id}/match`, { settlementId, note })),
  reversePayment: (id: string, note: string) => d<{ payment: BankPayment }>(api.post(`/admin/banks/payments/${id}/reverse`, { note })),
  approveReview: (id: string, note?: string) => d<{ payment: BankPayment }>(api.post(`/admin/banks/payments/${id}/approve`, { note: note || undefined })),
  rejectReview: (id: string, note: string) => d<{ payment: BankPayment }>(api.post(`/admin/banks/payments/${id}/reject`, { note })),
  statements: () => d<{ imports: StatementImportRow[] }>(api.get('/admin/banks/statements')).then((r) => r.imports),
  importStatement: (body: { bankPartnerId: string; receivingAccountId: string; fileName?: string; csvText: string }) => d<{ import: any }>(api.post('/admin/banks/statements/import', body)).then((r) => r.import),
  byAccount: () => d<{ accounts: AccountSummary[] }>(api.get('/admin/banks/payments/by-account')).then((r) => r.accounts),
  recordPayment: (body: { bankPartnerId: string; bankTransactionRef: string; amount: number; currency?: string; paidAt?: string; reference?: string; payerName?: string; confirmSeenOnStatement: true }) => d<{ duplicate: boolean; payment: BankPayment }>(api.post('/admin/banks/payments/manual', body)),
};

export interface StatementImportRow { id: string; bankPartnerId: string; fileName?: string | null; createdAt: string; rowsTotal?: number; creditsRecorded?: number; duplicates?: number; skipped?: number; [k: string]: unknown }
export interface AccountSummary { [k: string]: unknown }

/** Second-person approval queue for money staff entered by hand about a company (/admin/corporate/approvals). */
export interface PendingMoneyAction { id: string; kind: 'ORG_WALLET_CREDIT' | 'ORG_WALLET_ADJUST' | 'INVOICE_RECEIPT' | 'BANK_CREDIT_REVERSAL'; targetId: string; amount: Dec; currency: string; reason: string; status: string; requestedById: string; createdAt: string; payload?: Record<string, unknown> | null }
export const moneyApprovalsAPI = {
  list: (status: 'PENDING' | 'APPROVED' | 'REJECTED' = 'PENDING') => d<{ requests: PendingMoneyAction[] }>(api.get('/admin/corporate/approvals', { params: { status } })).then((r) => r.requests),
  approve: (id: string, note?: string) => d<unknown>(api.post(`/admin/corporate/approvals/${id}/approve`, { note: note || undefined })),
  reject: (id: string, note: string) => d<unknown>(api.post(`/admin/corporate/approvals/${id}/reject`, { note })),
};

export type DemoStatus = 'NEW' | 'CONTACTED' | 'DEMO_SCHEDULED' | 'WON' | 'LOST';
export interface DemoRequest { id: string; name: string; email: string; phone: string | null; organisation: string | null; interest: string; message: string | null; status: DemoStatus; notes: string | null; createdAt: string }
export const demoAdminAPI = {
  list: (status?: DemoStatus) => d<{ requests: DemoRequest[] }>(api.get('/admin/demo-requests', { params: { status } })).then((r) => r.requests),
  update: (id: string, body: { status?: DemoStatus; notes?: string }) => api.patch(`/admin/demo-requests/${id}`, body).then((r) => r.data),
};

export interface CompanyPayInstructions {
  currency: string; walletReference: string; narration: string;
  accounts: { id: string; bank: string; accountName: string; accountNumber: string; isPrimary: boolean }[];
  openInvoices: { invoiceId: string; invoiceNumber: string; reference: string; outstanding: number; dueDate: string | null }[];
}
export interface CompanyBankReceipt { id: string; amount: Dec; currency: string; paidAt: string; receivedAt: string; status: string; paymentReference: string | null; invoiceId: string | null; bankPartner?: { displayName: string } | null }
export const companyPayAPI = {
  instructions: () => d<CompanyPayInstructions>(api.get('/corporate/billing/pay-instructions')),
  receipts: () => d<{ receipts: CompanyBankReceipt[] }>(api.get('/corporate/billing/bank-receipts')).then((r) => r.receipts),
};
