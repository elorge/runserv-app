// M16: typed wrappers for /api/admin/guest-bookings. Authorisation is enforced by the backend (market guard + scope + role);
// hiding a button in the UI is not a control. Every call can therefore fail with 403/404 and the pages must show that.
import api from './index';
import type { GuestEmailQueue, EmailUsage, GuestSmsQueue, SmsStatus, GuestAbuse, GuestActionResult, AttentionItem, PilotMetrics, GuestBookingDetail, GuestQueueParams, GuestQueueResult } from '@/types/guestBooking';

const unwrap = <T,>(res: any): T => (res?.data?.data ?? res?.data) as T;

export const guestBookingsAPI = {
  /** GET /admin/guest-bookings — filter by service, status, reference fragment; paginated. */
  list: async (params: GuestQueueParams = {}): Promise<GuestQueueResult> =>
    unwrap(await api.get('/admin/guest-bookings', { params: { ...params, service: params.service || undefined, status: params.status || undefined, q: params.q || undefined } })),

  /** GET /admin/guest-bookings/:id */
  get: async (id: string): Promise<GuestBookingDetail> => unwrap(await api.get(`/admin/guest-bookings/${id}`)),

  /** POST /admin/guest-bookings/lookup — booking reference + the phone number the guest used. */
  lookup: async (reference: string, phone: string): Promise<GuestBookingDetail> =>
    unwrap(await api.post('/admin/guest-bookings/lookup', { reference: reference.trim().toUpperCase(), phone: phone.trim() })),

  /** GET /admin/guest-bookings/abuse — last 24 h of abuse signals. */
  abuse: async (): Promise<GuestAbuse> => unwrap(await api.get('/admin/guest-bookings/abuse')),

  /** M16.1: GET /admin/guest-bookings/email: durable email queue + Brevo/Resend usage. Addresses are masked; codes are never returned. */
  emailQueue: async (params: { status?: SmsStatus | ''; provider?: string } = {}): Promise<GuestEmailQueue> =>
    unwrap(await api.get('/admin/guest-bookings/email', { params: { status: params.status || undefined, provider: params.provider || undefined } })),
  emailRetry: async (id: string): Promise<GuestActionResult> => (await api.post(`/admin/guest-bookings/email/${id}/retry`, {})).data,
  emailProvider: async (provider: string, pause: boolean): Promise<EmailUsage> => unwrap(await api.post(`/admin/guest-bookings/email/providers/${provider}/${pause ? 'pause' : 'resume'}`, {})),

  /** GET /admin/guest-bookings/sms — durable SMS queue (tracking links, recipient codes). Numbers are masked. */
  smsQueue: async (params: { status?: SmsStatus | ''; kind?: string } = {}): Promise<GuestSmsQueue> =>
    unwrap(await api.get('/admin/guest-bookings/sms', { params: { status: params.status || undefined, kind: params.kind || undefined } })),

  /** POST /admin/guest-bookings/sms/:id/retry — ADMIN / SUPER_ADMIN only; only DEAD messages with a stored number. */
  smsRetry: async (id: string): Promise<GuestActionResult> => (await api.post(`/admin/guest-bookings/sms/${id}/retry`, {})).data,

  /** POST /identities/:id/block — ADMIN / SUPER_ADMIN only. Reason 5–200 chars. */
  block: async (identityId: string, reason: string): Promise<GuestActionResult> => (await api.post(`/admin/guest-bookings/identities/${identityId}/block`, { reason })).data,
  unblock: async (identityId: string): Promise<GuestActionResult> => (await api.post(`/admin/guest-bookings/identities/${identityId}/unblock`, {})).data,

  /** M16.2: POST /:id/recipient-notification/resend — ADMIN / SUPER_ADMIN only. Re-sends the SAME code (never a new one) on every enabled channel. Reason 5–200 chars; cooldown + audit server-side. */
  resendRecipient: async (bookingId: string, reason: string): Promise<GuestActionResult> => (await api.post(`/admin/guest-bookings/${bookingId}/recipient-notification/resend`, { reason })).data,

  /** POST /deliveries/:id/pod-override — ADMIN / SUPER_ADMIN only. Reason 10–300 chars; audited server-side. */
  podOverride: async (deliveryId: string, reason: string): Promise<GuestActionResult> => (await api.post(`/admin/guest-bookings/deliveries/${deliveryId}/pod-override`, { reason })).data,

  /** M16.2.1: POST /:id/recipient-notification/rotate — ADMIN / SUPER_ADMIN only. Issues a NEW code; the old one stops working. Reason 10–200 chars + confirm:true. */
  rotateRecipient: async (bookingId: string, reason: string): Promise<GuestActionResult> => (await api.post(`/admin/guest-bookings/${bookingId}/recipient-notification/rotate`, { reason, confirm: true })).data,

  /** M16.2.1 (Option B): the same two actions for a registered customer's parcel, addressed by DELIVERY id. */
  resendRecipientByDelivery: async (deliveryId: string, reason: string): Promise<GuestActionResult> => (await api.post(`/admin/guest-bookings/deliveries/${deliveryId}/recipient-notification/resend`, { reason })).data,
  rotateRecipientByDelivery: async (deliveryId: string, reason: string): Promise<GuestActionResult> => (await api.post(`/admin/guest-bookings/deliveries/${deliveryId}/recipient-notification/rotate`, { reason, confirm: true })).data,

  /** M16.2.1: manual hand-over exception = REQUEST (reason 10–300 + evidence 10–300), then a DIFFERENT operator APPROVES (podOverride) or REJECTS. */
  exceptionRequest: async (deliveryId: string, reason: string, evidence: string): Promise<GuestActionResult> => (await api.post(`/admin/guest-bookings/deliveries/${deliveryId}/handover-exception/request`, { reason, evidence })).data,
  exceptionReject: async (deliveryId: string, reason: string): Promise<GuestActionResult> => (await api.post(`/admin/guest-bookings/deliveries/${deliveryId}/handover-exception/reject`, { reason })).data,

  /** M16.2.1: GET /recipient-attention — parcels whose recipient has no working path to the code. */
  attention: async (): Promise<{ items: AttentionItem[] }> => unwrap(await api.get('/admin/guest-bookings/recipient-attention')),

  /** M16.2.1: GET /pilot-metrics?hours= */
  pilotMetrics: async (hours = 168): Promise<PilotMetrics> => unwrap(await api.get('/admin/guest-bookings/pilot-metrics', { params: { hours } })),
};
