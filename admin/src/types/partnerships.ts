// Types for the Fleet and Bank Offers admin areas. Prisma Decimals arrive from the API as strings,
// so money / rate fields are typed `number | string` and always wrapped in Number() before use.

export type Dec = number | string | null;

export type FleetStatus = 'PENDING' | 'UNDER_REVIEW' | 'ACTIVE' | 'SUSPENDED' | 'REJECTED' | 'DEACTIVATED';
export type VerificationStatus = 'UNVERIFIED' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED';
export type VehicleStatus = 'PENDING' | 'ACTIVE' | 'IN_SERVICE' | 'MAINTENANCE' | 'SUSPENDED' | 'RETIRED';
export type SettlementStatus = 'PENDING' | 'RECONCILING' | 'APPROVED' | 'PAID' | 'DISPUTED' | 'CANCELLED';

export interface FleetStats { activeFleets: number; pendingFleets: number; activeVehicles: number; pendingVehicles: number; openSettlements: number }

export interface FleetPartner {
  id: string; legalName: string; tradingName: string | null; rcNumber: string | null; email: string; phone: string; address: string | null;
  countryCode: string; currency: string; status: FleetStatus; verificationStatus: VerificationStatus; verificationNotes: string | null; verifiedAt: string | null;
  commissionRate: Dec; settlementTermsDays: number; createdAt: string;
  _count?: { vehicles: number; assignments: number };
}

export interface DocState { state: 'VALID' | 'EXPIRING' | 'EXPIRED' | 'MISSING'; expiresAt: string | null; mandatory: boolean }
export interface Compliance { docs: Record<string, DocState>; blockers: string[]; warnings: string[] }

export interface FleetVehicle {
  id: string; fleetPartnerId: string; vehicleType: 'CAR' | 'MOTORCYCLE' | 'VAN' | string; make: string; model: string; modelYear: number | null; colour: string | null;
  registrationNumber: string; status: VehicleStatus; isActive: boolean;
  insuranceExpiresAt: string | null; roadworthyExpiresAt: string | null; permitExpiresAt: string | null;
  compliance: Compliance; fleetPartner?: { id: string; legalName: string; tradingName: string | null; status: FleetStatus };
}

export interface FleetDocument {
  id: string; fleetPartnerId: string; vehicleId: string | null; documentType: string; fileUrl: string; documentNumber: string | null;
  expiresAt: string | null; verifiedAt: string | null; isApproved: boolean; rejectionNote: string | null; createdAt: string;
}

export interface FleetMember { id: string; role: string; isActive?: boolean; user: { id: string; firstName: string; lastName: string; email: string } }

export interface FleetDetail { fleet: FleetPartner & { members: FleetMember[]; documents: FleetDocument[] }; vehicles: FleetVehicle[] }

export interface FleetSettlement {
  id: string; fleetPartnerId: string; periodStart: string; periodEnd: string; grossAmount: Dec; platformFeeAmount: Dec; adjustmentsAmount: Dec; netAmount: Dec;
  currency: string; status: SettlementStatus; reference: string | null; paidAt: string | null; createdAt: string; fleetPartner?: { id: string; legalName: string };
  paymentReference?: string | null; paymentMethod?: string | null; paidAmount?: Dec | null; paymentProofRef?: string | null; paymentNote?: string | null; payoutAccountMasked?: string | null;
}

// ── Bank Offers ───────────────────────────────────────────────────────────────
export type BankStatus = 'PROSPECT' | 'DUE_DILIGENCE' | 'CONTRACT_PENDING' | 'ACTIVE' | 'PAUSED' | 'TERMINATED';
export type CampaignStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'SCHEDULED' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'EXPIRED' | 'CANCELLED';
export type OfferType = 'DISCOUNT' | 'CASHBACK' | 'SPONSORED_RIDE' | 'SPONSORED_DELIVERY' | 'DEFERRED_PAYMENT' | 'CREDIT' | 'ACCOUNT_OPENING';
export type EligibilityType = 'PUBLIC' | 'EXISTING_BANK_CUSTOMERS' | 'NEW_BANK_CUSTOMERS' | 'INVITATION_ONLY' | 'BANK_APPROVAL_REQUIRED';

export interface BankPartner {
  id: string; legalName: string; displayName: string; countryCode: string; logoUrl: string | null; websiteUrl: string | null; contactEmail: string | null; contactPhone: string | null;
  status: BankStatus; agreementReference: string | null; agreementStartAt: string | null; agreementEndAt: string | null; createdAt: string; _count?: { campaigns: number };
}

export interface BankOffer {
  id: string; campaignId: string; title: string; shortDescription: string | null; termsAndConditions: string; offerType: OfferType; eligibilityType: EligibilityType;
  discountPercent: Dec; discountAmount: Dec; maxBenefitAmount: Dec; minTripAmount: Dec; redemptionLimit: number | null; perCustomerLimit: number | null;
  requiresBankApproval: boolean; accountOpeningUrl: string | null; isPublished: boolean; displayPriority: number;
}

export interface BankCampaign {
  id: string; bankPartnerId: string; name: string; campaignCode: string; description: string | null; status: CampaignStatus; startsAt: string | null; endsAt: string | null;
  budgetAmount: Dec; spentAmount: Dec; currency: string; landingPageUrl: string | null; attributionWindowDays: number; approvedAt: string | null; createdById: string; createdAt: string;
  bankPartner?: Partial<BankPartner> & { id: string; displayName: string }; offers?: BankOffer[]; _count?: { offers: number };
}

export interface CampaignReport {
  campaign: { id: string; name: string; status: CampaignStatus; startsAt: string | null; endsAt: string | null; currency: string };
  totals: { impressions: number; views: number; clicks: number; applicationsStarted: number; submitted: number; verifiedConversions: number; declined: number; redemptions: number };
  funnelNote: string;
  budget: { amount: number | null; spent: number; remaining: number | null };
  redemptionsByStatus: Record<string, { count: number; benefit: number }>;
}

export interface BankSettlement {
  id: string; bankPartnerId: string; campaignId: string | null; periodStart: string; periodEnd: string; agreedAmount: Dec; adjustmentsAmount: Dec; netAmount: Dec;
  currency: string; status: SettlementStatus; invoiceReference: string | null; paymentReference?: string | null; receivedAmount?: Dec; paidAt: string | null; createdAt: string; bankPartner?: { id: string; displayName: string };
}

export interface BankAccount { id: string; bankPartnerId: string; accountName: string; accountNumber: string; bankName: string; currency: string; label: string | null; isActive: boolean; isPrimary: boolean; createdAt: string; bank?: { id: string; displayName: string } }
export type BankPaymentStatus = 'MATCHED' | 'UNMATCHED' | 'HELD' | 'PENDING_REVIEW' | 'REVERSED';
export interface BankPayment {
  id: string; bankPartnerId: string; settlementId: string | null; source: 'WEBHOOK' | 'MANUAL' | 'STATEMENT'; bankTransactionRef: string; paymentReference: string | null; amount: Dec; currency: string;
  payerName: string | null; paidAt: string; receivedAt: string; status: BankPaymentStatus; exceptionReason: string | null; resolutionNote: string | null; enteredById?: string | null; proposal?: { kind: string; id: string } | null; reviewFrom?: string | null; reviewNote?: string | null;
  bankPartner?: { id: string; displayName: string }; settlement?: { id: string; paymentReference: string | null; netAmount: Dec; receivedAmount: Dec; status: SettlementStatus } | null;
}
export interface ReceiptsSummary {
  receivedThisMonth: { count: number; amount: number }; exceptions: Record<string, { count: number; amount: number }>;
  outstandingByBank: { bankPartnerId: string; bank: string; currency: string; outstanding: number }[]; banksWithoutSecret: { id: string; displayName: string }[];
}
export interface PaymentInstructions { settlementId: string; bank: string; currency: string; amountDue: number; reference: string; account: { name: string; number: string; bank: string }; narration: string }
