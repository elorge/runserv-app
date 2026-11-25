// M16: types for the Admin guest-booking pages. Shapes mirror backend/src/controllers/adminGuest.controller.js (masked phones only).
export type GuestService = 'RIDE' | 'PARCEL';

export interface GuestProof {
  required: boolean; verified: boolean; locked: boolean; failed: boolean;
  returnStatus: string | null; failedReason?: string | null;
  failedFee?: { amount: number; currency: string } | null; supportReview?: boolean;
}

export interface GuestBookingRow {
  id: string; reference: string; source: 'GUEST'; service: GuestService; vehicleType: string;
  fare: number; currency: string; createdAt: string; status: string | null;
  phone: string; phoneVerifiedAt: string | null; countryCode: string | null;
  identityId: string; blocked: boolean; converted: boolean;
  trackingRevoked: boolean; trackingExpiresAt: string | null;
  proof?: GuestProof;
}

export interface GuestAuditItem { id: string; event: string; at: string; meta: Record<string, unknown> | null }

// ── M16.2: recipient hand-over code + tracking link: per-channel NOTIFICATION state (never the code, never a full address) ──────────
export type ChannelState = 'DISABLED' | 'NOT_PROVIDED' | 'NOT_QUEUED' | 'QUEUED' | 'RETRYING' | 'ACCEPTED' | 'DELIVERED' | 'FAILED' | 'SKIPPED';
export interface ChannelStatus {
  enabled: boolean; contact: string | null; state: ChannelState;
  provider?: string | null; providerMessageId?: string | null; attempts?: number; errorCategory?: string | null; lastError?: string | null;
  deliveryStatus?: string | null; sentAt?: string | null; createdAt?: string | null;
}
// M16.2.1: code lifecycle. A state, never a value: the code, its hash and its nonce are never sent to Admin.
export type CodeState = 'NOT_REQUIRED' | 'VERIFIED' | 'LOCKED' | 'EXPIRED' | 'ACTIVE';
export interface CodeLifecycle { state: CodeState; version: number; expiresAt: string | null; rotatedAt: string | null; legacy: boolean; expiryPolicyConfigured: boolean }
export type RecoveryAction = 'ROTATE' | 'RESEND' | null;
export interface RecipientComms { email: ChannelStatus; sms: ChannelStatus; overall: 'OK' | 'PENDING' | 'UNRESOLVED'; partial: boolean; resendCooldownS: number; code?: CodeLifecycle; recovery?: RecoveryAction; needsAttention?: boolean }

// M16.2.1: recipient-attention work list (GET /recipient-attention). `source` and `deliveryId` are added by the backend for registered-customer parcels (Option B).
export interface AttentionItem {
  id: string; deliveryId?: string; source?: 'GUEST' | 'REGISTERED'; reference: string | null; deliveryStatus: string; createdAt: string;
  overall: 'OK' | 'PENDING' | 'UNRESOLVED'; recovery: 'ROTATE' | 'RESEND'; code: CodeLifecycle;
  email: { state: ChannelState; contact?: string | null }; sms: { state: ChannelState };
}

// M16.2.1: pilot metrics (GET /pilot-metrics). Aggregates only.
export interface ChannelMetrics {
  channel: 'email' | 'sms'; total: number; queued: number; accepted: number; deadLettered: number; skipped: number; retried: number;
  acceptedRatePct: number | null; deliveryReceiptRatePct: number | null; deliveredPct: number | null; deadLetterRatePct: number | null; medianSecondsToAcceptance: number | null;
  byProvider: Record<string, { total: number; accepted: number; deadLettered: number }>;
}
export interface PilotMetrics {
  since: string; sinceHours: number; email: ChannelMetrics; sms: ChannelMetrics;
  pod: { parcels: number; verified: number; wrongAttempts: number; expiredAttempts: number; lockouts: number; lockoutRatePct: number | null; resends: number; rotations: number; exceptionsRequested: number; exceptionsApproved: number };
  escalation: { parcelsNeedingManualAction: number; ratePct: number | null };
  tracking: { views: number; note: string };
}

export interface GuestBookingDetail extends GuestBookingRow {
  communications?: RecipientComms | null;
  quote?: Record<string, unknown> | null;
  fareTrace?: unknown;
  trip: null | {
    id: string; status: string; pickupAddress: string; dropoffAddress: string; distanceKm?: number | null; requestedAt: string;
    acceptedAt: string | null; startedAt: string | null; completedAt: string | null; cancelledAt: string | null; cancellationReason: string | null;
    podMethod?: string | null; podVerifiedAt?: string | null; podAttempts?: number; hasPodPhoto?: boolean;
    failedAt?: string | null; failedReason?: string | null; returnStatus?: string | null;
  };
  assignedTo: { id: string; name: string; role: string } | null;
  audit: GuestAuditItem[];
}

export interface GuestQueueParams { page?: number; limit?: number; service?: GuestService | ''; status?: string; q?: string }
export interface GuestQueueResult { bookings: GuestBookingRow[]; pagination: { total: number; page: number; pages: number } }

export interface GuestAbuse {
  since: string;
  counts: { event: string; count: number }[];
  noisySources: { source: string; count: number }[];
  recent: { id: string; event: string; at: string; source: string | null; meta: Record<string, unknown> | null }[];
}

export interface GuestActionResult { success: boolean; message?: string }

export type SmsStatus = 'PENDING' | 'PROCESSING' | 'SENT' | 'DEAD' | 'SKIPPED';
export interface GuestSmsMessage {
  id: string; kind: 'GUEST_TRACKING' | 'RECIPIENT_CODE'; status: SmsStatus; attempts: number; to: string; lastError: string | null;
  createdAt: string; sentAt: string | null; nextAttemptAt: string | null; bookingId: string; reference: string | null; canRetry: boolean;
}
export interface GuestSmsQueue { stats: { pending: number; dead: number; oldestAgeSeconds: number; alerts: string[] }; messages: GuestSmsMessage[] }

// ── M16.1: email queue + provider usage ──────────────────────────────────────────────────────────────────────────────────────
export interface EmailProviderUsage { provider: 'brevo' | 'resend'; enabled: boolean; paused: boolean; allocation: number; reserved: number; accepted: number; remaining: number; quotaExhausted: boolean; unhealthy: boolean; percentUsed: number }
export interface EmailUsage { windowKey: string; timezone: string; resetAt: string; hardCap: number; activeTier: 'brevo' | 'resend'; providers: EmailProviderUsage[] }
export interface GuestEmailMessage {
  id: string; kind: string; bookingId?: string | null; reference?: string | null; status: SmsStatus; attempts: number; to: string; provider: string | null; routeReason: string | null; errorCategory: string | null; lastError: string | null;
  deliveryStatus: string | null; deliveryAt: string | null; createdAt: string; sentAt: string | null; nextAttemptAt: string | null; canRetry: boolean;
}
export interface GuestEmailQueue { stats: { pending: number; dead: number; oldestAgeSeconds: number; alerts: string[]; usage: EmailUsage }; messages: GuestEmailMessage[] }
