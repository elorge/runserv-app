// Types for the organisation (company) portal.
export type WeekendPolicy = 'APPROVAL_REQUIRED' | 'OPEN_SATURDAY' | 'OPEN_WEEKEND' | 'CLOSED';
export type AuditStatus = 'UNREVIEWED' | 'VERIFIED' | 'FLAGGED';
export type OrgRole = 'ORG_ADMIN' | 'HR' | 'MANAGER' | 'FINANCE' | 'STAFF';
export type BillingMode = 'PREPAID' | 'POSTPAID' | 'HYBRID';

export const ROLE_LABEL: Record<OrgRole, string> = { ORG_ADMIN: 'Organisation admin', HR: 'HR', MANAGER: 'Manager', FINANCE: 'Finance', STAFF: 'Staff' };

export interface Permissions { manageSettings: boolean; manageRoles: boolean; manageStaff: boolean; seeCompanyCost: boolean; seeBilling: boolean; audit: boolean; approveTrips: boolean }

export interface CompanyProfile {
  id: string; name: string; brandName: string | null; orgCode: string; status: 'PENDING' | 'ACTIVE' | 'SUSPENDED'; currency: string; timezone: string;
  logoUrl: string | null; brandColor: string | null; brandAccent: string | null; tagline: string | null; supportEmail: string | null;
  weekendPolicy: WeekendPolicy; requireTripPurpose: boolean; allowDeliveries: boolean; maxTripAmount: number | null; approvalThreshold: number | null;
  email: string; phone: string; address: string | null; billingEmail: string | null;
  billingMode?: BillingMode; creditLimit?: number; paymentTermsDays?: number; lowBalanceThreshold?: number; verificationStatus?: string;
}
export interface PortalProfile { company: CompanyProfile; member: { id: string; role: OrgRole; name: string }; permissions: Permissions; pendingRequests: number; pendingApprovals: number; pendingWeekend: number }

export interface Invoice {
  id: string; number: string; period: string; status: 'ISSUED' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'VOID';
  tripCount: number; distanceKm: number; tripsAmount: number; subscription: number; total: number; paid: number; outstanding: number; currency: string;
  issuedAt: string; dueDate: string; paidAt: string | null;
}
export interface Funding { mode?: BillingMode; walletBalance: number; walletAvailable: number; creditLimit: number; creditExposure: number; creditAvailable: number; held?: number }

export interface DashboardData {
  period: string; currency: string; timezone: string; scope: 'COMPANY' | 'TEAM';
  totals: { trips: number; rides: number; deliveries: number; distanceKm: number; spend: number; weekendTrips: number; flagged: number; unreviewed: number; verified: number; avgCostPerKm: number };
  inProgress: number; activeStaff: number;
  byDepartment: { departmentId: string | null; department: string; costCenter: string; budget: number | null; trips: number; spend: number; distanceKm: number }[];
  topStaff: { employeeId: string; name: string; staffNumber: string | null; department: string; trips: number; spend: number; distanceKm: number }[];
  daily: { date: string; trips: number; spend: number }[];
  funding?: Funding; invoices?: Invoice[]; outstandingTotal?: number;
}

export interface Department {
  id: string; name: string; costCenter: string; monthlyBudget: number | null; maxTripAmount: number | null; approvalThreshold: number | null; isActive: boolean;
  head: { id: string; name: string } | null; staffCount: number; monthSpend: number; monthTrips: number;
}

export interface StaffRow {
  id: string; role: OrgRole; staffNumber: string | null; claimedDepartment: string | null; jobTitle: string | null;
  inviteStatus: 'PENDING' | 'ACTIVE' | 'REJECTED' | 'DELISTED'; isActive: boolean; monthlyLimit: number;
  requestedAt: string | null; joinedAt: string | null; exitedAt: string | null; exitReason: string | null; reviewNote: string | null;
  user: { firstName: string; lastName: string; phone: string | null; email: string };
  department: { id: string; name: string; costCenter: string } | null; supervisor: { id: string; name: string } | null;
  directoryMatch: 'EXACT' | 'NAME_MISMATCH' | 'NOT_FOUND' | 'EXITED' | null;
  directory: { fullName: string; department: string | null; departmentId: string | null; jobTitle: string | null; status: string } | null;
  monthSpend: number; monthTrips: number; monthDistanceKm: number;
}

export interface DirectoryEntry { id: string; staffNumber: string; fullName: string; email: string | null; phone: string | null; jobTitle: string | null; supervisorStaffNumber: string | null; status: 'ACTIVE' | 'EXITED'; department: { name: string } | null; onRunserv: boolean }

export interface Trip {
  id: string; type: 'RIDE' | 'DELIVERY'; status: string; date: string;
  employee: { id: string; name: string; staffNumber: string | null; department: string | null; phone?: string };
  costCenter: string | null; departmentId: string | null;
  from: string | null; to: string | null; distanceKm: number | null; fare: number; currency: string; costPerKm: number | null;
  funding: { wallet: number; credit: number };
  purposeCategory: string | null; purpose: string | null; weekendTrip: boolean;
  driver: { firstName: string; plate: string | null } | null;
  audit: { status: AuditStatus; note: string | null; at: string | null };
  invoice: { number: string; period: string; status: string } | null;
}

export interface WeekendRequest { id: string; date: string; reason: string; status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'; reviewNote: string | null; createdAt: string; employee: { name: string; staffNumber: string | null; department: string | null } }
export interface ApprovalItem { id: string; status: string; serviceType: string; pickup: string; dropoff: string; fare: number; distanceKm: number | null; purpose: string | null; decisionNote: string | null; createdAt: string; expiresAt: string; employee: { name: string; staffNumber: string | null; department: string | null; costCenter: string | null } }

export const PURPOSE_LABELS: Record<string, string> = { CLIENT_VISIT: 'Client visit', MARKETING_CALL: 'Marketing call', SITE_VISIT: 'Site visit', OFFICE_ERRAND: 'Office errand', AIRPORT: 'Airport', MEETING: 'Meeting', OTHER: 'Other' };
