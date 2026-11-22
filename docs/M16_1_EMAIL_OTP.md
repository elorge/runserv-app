# M16.1: Stabilisation and Email OTP (implementation notes)

Apply in order: `m15_guest_booking.sql` → `m16_sms_outbox.sql` → **`m16_1_email_otp.sql`** (forward-only, additive, idempotent; rollback notes at the bottom of the file; rehearsed on PostgreSQL 16). Then `prisma generate`.

## Behaviour
- **Channel**: email is primary. `GUEST_EMAIL_OTP_ENABLED` + `GUEST_OTP_CHANNEL` (both required). SMS OTP stays off unless `GUEST_SMS_OTP_ENABLED=true` and the list contains `sms`.
- **Identity**: keyed by verified email. The phone is an unverified contact (`contactPhone`). `verifiedChannel`, `emailVerifiedAt`, `phoneVerifiedAt` recorded separately.
- **Codes**: derived from `GUEST_OTP_HASH_SECRET` + challenge id + nonce (no JWT fallback). No code is stored in `GuestOtp`, `EmailOutbox`, audit or logs.
- **Race fix**: `pg_advisory_xact_lock` per identity+purpose and per IP; cooldown, caps and "one live challenge" are decided inside the lock.
- **Outbox**: `EmailOutbox` row written in the challenge transaction; worker retries with back-off, dead-letters, idempotent.
- **Routing**: Brevo takes sends 1-300 of the window, Resend 301-400, then jobs stay queued. Atomic conditional update on `EmailQuotaWindow`. Outage failover consumes Resend slots (400 not guaranteed during an outage). Timeouts are ambiguous: same provider only.
- **Webhooks**: `POST /api/email-webhooks/brevo` (bearer `BREVO_WEBHOOK_SECRET`) and `/resend` (Svix signature, `RESEND_WEBHOOK_SECRET`). Idempotent; never touch quota counters.
- **POD**: attempt is spent first by a conditional update (`podCodeAttempts < MAX`), so parallel guesses cannot exceed the cap; lock leaves a `POD_LOCKED` audit event.
- **Mobile**: email + contact phone screen; SecureStore write is read back and fails closed; session expiry drops the credential only, re-verify returns to the same booking.
- **Admin**: `/guest-bookings/email` (usage, queue, retry, pause/resume).
