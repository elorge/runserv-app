// The fleet's own API (/api/fleet/*). Every call is scoped to the caller's fleet on the server.
import api from './index';
import type {
  ApplyInput, FleetDocument, FleetProfile, FleetRole, Overview, PortalAssignment, PortalSettlement, PortalTrip, PortalVehicle, TeamMember, Compliance,
} from '@/types/fleetPortal';

const d = <T>(p: Promise<any>): Promise<T> => p.then((r) => r.data.data as T);
export { apiError } from './partnerships';

export const PAGE_SIZE = 25;

export interface VehicleInput {
  vehicleType: string; make: string; model: string; registrationNumber: string; modelYear?: number | null; colour?: string; subType?: string;
  seatingCapacity?: number | null; payloadCapacityKg?: number | null; insuranceExpiresAt?: string | null; roadworthyExpiresAt?: string | null; permitExpiresAt?: string | null;
}

export const fleetPortalAPI = {
  profile: (token?: string) => d<FleetProfile>(api.get('/fleet/profile', token ? { headers: { Authorization: `Bearer ${token}` }, validateStatus: (s) => s < 500 } : undefined)),
  /** Used before sign-in is complete (the applicant has no fleet yet), so the token is passed explicitly. */
  apply: (body: ApplyInput, token: string) => d<{ fleetPartner: { id: string; status: string } }>(api.post('/fleet/apply', body, { headers: { Authorization: `Bearer ${token}` } })),
  updateProfile: (body: Record<string, unknown>) => d<{ fleetPartner: FleetProfile['fleetPartner'] }>(api.put('/fleet/profile', body)),
  overview: () => d<Overview>(api.get('/fleet/overview')),

  vehicles: (params: { status?: string; page?: number; limit?: number }) => d<{ total: number; vehicles: PortalVehicle[] }>(api.get('/fleet/vehicles', { params: { limit: PAGE_SIZE, ...params } })),
  vehicle: (id: string) => d<{ vehicle: PortalVehicle & { assignments: { id: string; driverUserId: string; status: string; startsAt: string; endsAt: string | null }[] }; compliance: Compliance }>(api.get(`/fleet/vehicles/${id}`)),
  createVehicle: (body: VehicleInput) => d<{ vehicle: PortalVehicle }>(api.post('/fleet/vehicles', body)),
  updateVehicle: (id: string, body: Partial<VehicleInput>) => d<{ vehicle: PortalVehicle; sentForReview: boolean }>(api.put(`/fleet/vehicles/${id}`, body)),

  documents: (vehicleId?: string) => d<{ documents: FleetDocument[] }>(api.get('/fleet/documents', { params: { vehicleId } })).then((r) => r.documents),
  uploadFile: (file: File) => { const f = new FormData(); f.append('file', file); return d<{ url: string; publicId: string }>(api.post('/fleet/documents/upload', f, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 60000 })); },
  addDocument: (body: { vehicleId?: string; documentType: string; fileUrl: string; documentNumber?: string; issuedAt?: string; expiresAt?: string }) => d<{ document: FleetDocument }>(api.post('/fleet/documents', body)),

  drivers: (params: { status?: string; page?: number; limit?: number }) => d<{ assignments: PortalAssignment[] }>(api.get('/fleet/drivers', { params: { limit: 100, ...params } })).then((r) => r.assignments),
  assign: (body: { vehicleId: string; driverEmail: string }) => d<{ assignment: PortalAssignment }>(api.post('/fleet/assignments', body)),
  endAssignment: (id: string) => d<{ assignment: PortalAssignment }>(api.put(`/fleet/assignments/${id}/end`)),

  trips: (params: { status?: string; exceptions?: boolean; page?: number; limit?: number }) =>
    d<{ total: number; trips: PortalTrip[] }>(api.get('/fleet/trips', { params: { limit: PAGE_SIZE, ...params, exceptions: params.exceptions ? 'true' : undefined } })),

  settlements: () => d<{ settlements: PortalSettlement[] }>(api.get('/fleet/settlements')).then((r) => r.settlements),
  settlement: (id: string) => d<{ settlement: PortalSettlement; trips: PortalTrip[] }>(api.get(`/fleet/settlements/${id}`)),
  dispute: (id: string, note: string) => d<{ settlement: PortalSettlement }>(api.post(`/fleet/settlements/${id}/dispute`, { note })),

  team: () => d<{ users: TeamMember[] }>(api.get('/fleet/users')).then((r) => r.users),
  addMember: (body: { email: string; role: Exclude<FleetRole, 'OWNER'> }) => d<{ user: TeamMember }>(api.post('/fleet/users', body)),
  updateMember: (id: string, body: { role?: Exclude<FleetRole, 'OWNER'>; isActive?: boolean }) => d<{ user: TeamMember }>(api.put(`/fleet/users/${id}`, body)),
};
