// Types for the Fleet Partner Portal (the fleet's own web area, /api/fleet/*).
// Prisma Decimals arrive as strings: money fields are `Dec` and wrapped in Number() before use.
import type { Compliance, Dec, FleetDocument, FleetStatus, SettlementStatus, VehicleStatus, VerificationStatus } from './partnerships';

export type { Compliance, Dec, FleetDocument, FleetStatus, SettlementStatus, VehicleStatus, VerificationStatus };

export type FleetRole = 'OWNER' | 'ADMIN' | 'FLEET_MANAGER' | 'OPERATIONS' | 'FINANCE' | 'VIEWER';

export const FLEET_ROLE_LABEL: Record<FleetRole, string> = {
  OWNER: 'Owner', ADMIN: 'Admin', FLEET_MANAGER: 'Fleet manager', OPERATIONS: 'Operations', FINANCE: 'Finance', VIEWER: 'Viewer',
};

export const FLEET_ROLE_HELP: Record<FleetRole, string> = {
  OWNER: 'Everything for the fleet.',
  ADMIN: 'Everything except changing the owner.',
  FLEET_MANAGER: 'Vehicles, documents, drivers, assignments and trips. No finance.',
  OPERATIONS: 'Daily driver assignments and trips. No finance, no vehicle changes.',
  FINANCE: 'Statements, settlements and trip earnings. No driver identity details.',
  VIEWER: 'Read-only: overview, vehicles and trips (without money).',
};

/** Mirrors the server's role matrix (backend/src/services/fleetAccess.js). The server enforces it on every request. */
export interface FleetPermissions {
  view: boolean; manageUsers: boolean; manageSettings: boolean; manageVehicles: boolean; manageDocuments: boolean;
  assignDrivers: boolean; seeTrips: boolean; seeFinance: boolean; seeDriverIdentity: boolean;
}

/** What the signed-in session knows about the user's fleet. Refreshed from /fleet/profile while the portal is open. */
export interface FleetSession { id: string; name: string; status: FleetStatus; verificationStatus: VerificationStatus; role: FleetRole; permissions: FleetPermissions }

export interface FleetProfile {
  role: FleetRole; permissions: FleetPermissions;
  fleetPartner: {
    id: string; legalName: string; tradingName: string | null; rcNumber: string | null; taxId: string | null; email: string; phone: string; address: string | null;
    countryCode: string; currency: string; status: FleetStatus; verificationStatus: VerificationStatus; verificationNotes: string | null; supportEmail: string | null;
    // Finance roles only:
    commissionRate?: Dec; settlementTermsDays?: number; payoutAccountName?: string | null; payoutBankCode?: string | null; payoutAccountNumber?: string | null;
  };
}

export interface PortalAlert { vehicleId: string; registrationNumber: string; blockers: string[]; warnings: string[] }
export interface Overview {
  activeVehicles: number; activeDrivers: number; tripsInProgress: number; tripsCompleted30d: number; alerts: PortalAlert[];
  gross30d?: number; net30d?: number; // only for roles that may see finance
}

export interface PortalVehicle {
  id: string; vehicleType: string; subType: string | null; make: string; model: string; modelYear: number | null; colour: string | null;
  registrationNumber: string; seatingCapacity: number | null; payloadCapacityKg: Dec; status: VehicleStatus; isActive: boolean;
  insuranceExpiresAt: string | null; roadworthyExpiresAt: string | null; permitExpiresAt: string | null;
  compliance: Compliance; assignments?: { id: string; driverUserId: string }[];
}

export interface PortalAssignment {
  id: string; vehicleId: string; driverUserId: string; status: 'ACTIVE' | 'ENDED' | 'REVOKED'; startsAt: string; endsAt: string | null;
  vehicle: { id: string; registrationNumber: string; vehicleType: string; make: string; model: string };
  driver: { id: string; firstName: string; lastName: string; phone?: string; email?: string };
}

export type TripStatus = 'OFFERED' | 'ACCEPTED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'DISPUTED';
export interface PortalTrip {
  id: string; serviceType: string; status: TripStatus; currency: string; createdAt: string; completedAt: string | null; cancelledAt: string | null; cancellationReason: string | null;
  driver?: { id: string; firstName: string; lastName: string }; vehicle?: { id: string; registrationNumber: string; make: string; model: string };
  fareAmount?: Dec; platformFeeAmount?: Dec; fleetNetAmount?: Dec; // absent unless the role may see finance
}

export interface PortalSettlement {
  id: string; periodStart: string; periodEnd: string; grossAmount: Dec; platformFeeAmount: Dec; adjustmentsAmount: Dec; netAmount: Dec;
  currency: string; status: SettlementStatus; reference: string | null; paidAt: string | null; createdAt: string;
}

export interface TeamMember { id: string; role: FleetRole; isActive: boolean; invitedAt: string; acceptedAt: string | null; user: { id: string; firstName: string; lastName: string; email: string } }

export interface ApplyInput { legalName: string; tradingName?: string; rcNumber?: string; taxId?: string; email: string; phone: string; address?: string }

export const DOCUMENT_TYPES: { value: string; label: string; vehicleField?: 'insuranceExpiresAt' | 'roadworthyExpiresAt' | 'permitExpiresAt' }[] = [
  { value: 'insurance', label: 'Insurance', vehicleField: 'insuranceExpiresAt' },
  { value: 'roadworthy', label: 'Roadworthiness certificate', vehicleField: 'roadworthyExpiresAt' },
  { value: 'permit', label: 'Operating permit', vehicleField: 'permitExpiresAt' },
  { value: 'registration', label: 'Vehicle registration' },
  { value: 'other', label: 'Other' },
];
