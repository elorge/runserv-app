-- M16.1: email OTP channel, durable email outbox, two-provider quota counters. FORWARD-ONLY, ADDITIVE, safe to re-run.
-- Apply AFTER m15_guest_booking.sql and m16_sms_outbox.sql. Rehearse on a restored copy first (docs/MIGRATION_GUIDE.md).
-- Does not edit any previously applied SQL.

-- ── GuestIdentity: email-first identity, phone becomes an unverified contact ─────────────────────────────────────
ALTER TABLE "GuestIdentity" ALTER COLUMN "phone" DROP NOT NULL;   -- the unique index stays; Postgres allows many NULLs
ALTER TABLE "GuestIdentity"
  ADD COLUMN IF NOT EXISTS "email"           TEXT,
  ADD COLUMN IF NOT EXISTS "contactPhone"    TEXT,
  ADD COLUMN IF NOT EXISTS "verifiedChannel" TEXT NOT NULL DEFAULT 'PHONE',
  ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "phoneVerifiedAt" TIMESTAMPTZ(6);
-- Existing identities were all phone-verified: record that explicitly rather than inferring it later.
UPDATE "GuestIdentity" SET "phoneVerifiedAt" = "verifiedAt" WHERE "phone" IS NOT NULL AND "phoneVerifiedAt" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "GuestIdentity_email_key" ON "GuestIdentity"("email");

-- ── GuestOtp: channel + purpose bound challenges ─────────────────────────────────────────────────────────────────
ALTER TABLE "GuestOtp" ALTER COLUMN "phone" DROP NOT NULL;
ALTER TABLE "GuestOtp"
  ADD COLUMN IF NOT EXISTS "channel"      TEXT NOT NULL DEFAULT 'PHONE',
  ADD COLUMN IF NOT EXISTS "purpose"      TEXT NOT NULL DEFAULT 'GUEST_BOOKING_VERIFY',
  ADD COLUMN IF NOT EXISTS "identityKey"  TEXT,
  ADD COLUMN IF NOT EXISTS "email"        TEXT,
  ADD COLUMN IF NOT EXISTS "contactPhone" TEXT,
  ADD COLUMN IF NOT EXISTS "codeNonce"    TEXT,
  ADD COLUMN IF NOT EXISTS "supersededAt" TIMESTAMPTZ(6);
CREATE INDEX IF NOT EXISTS "GuestOtp_identityKey_purpose_createdAt_idx" ON "GuestOtp"("identityKey","purpose","createdAt");

-- ── Durable email outbox ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "EmailOutbox" (
  "id"                TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "kind"              TEXT NOT NULL,
  "otpId"             TEXT,
  "toEmail"           TEXT,
  "toMasked"          TEXT NOT NULL,
  "status"            TEXT NOT NULL DEFAULT 'PENDING',
  "attempts"          INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "provider"          TEXT,
  "routeReason"       TEXT,
  "slotHeld"          BOOLEAN NOT NULL DEFAULT false,
  "providerMessageId" TEXT,
  "errorCategory"     TEXT,
  "lastError"         TEXT,
  "deliveryStatus"    TEXT,
  "deliveryAt"        TIMESTAMPTZ(6),
  "sentAt"            TIMESTAMPTZ(6),
  "createdAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "EmailOutbox_status_nextAttemptAt_idx" ON "EmailOutbox"("status","nextAttemptAt");
CREATE INDEX IF NOT EXISTS "EmailOutbox_otpId_idx"                ON "EmailOutbox"("otpId");
CREATE INDEX IF NOT EXISTS "EmailOutbox_providerMessageId_idx"    ON "EmailOutbox"("providerMessageId");

-- ── Shared quota counters (one row per provider per window) ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "EmailQuotaWindow" (
  "provider"       TEXT NOT NULL,
  "windowKey"      TEXT NOT NULL,
  "reserved"       INTEGER NOT NULL DEFAULT 0,
  "accepted"       INTEGER NOT NULL DEFAULT 0,
  "exhaustedAt"    TIMESTAMPTZ(6),
  "unhealthyUntil" TIMESTAMPTZ(6),
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY ("provider","windowKey")
);

CREATE TABLE IF NOT EXISTS "EmailProviderControl" (
  "provider" TEXT PRIMARY KEY,
  "paused"   BOOLEAN NOT NULL DEFAULT false,
  "pausedAt" TIMESTAMPTZ(6),
  "pausedBy" TEXT
);

CREATE TABLE IF NOT EXISTS "EmailWebhookEvent" (
  "id"        TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "provider"  TEXT NOT NULL,
  "eventKey"  TEXT NOT NULL,
  "messageId" TEXT,
  "event"     TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "EmailWebhookEvent_provider_eventKey_key" ON "EmailWebhookEvent"("provider","eventKey");

-- Supabase: not readable through the public Data API (same policy as the other guest tables).
ALTER TABLE "EmailOutbox"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailQuotaWindow"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailProviderControl"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailWebhookEvent"     ENABLE ROW LEVEL SECURITY;

-- ── ROLLBACK (manual; only if nothing depends on the new columns) ────────────────────────────────────────────────
-- DROP TABLE "EmailWebhookEvent", "EmailProviderControl", "EmailQuotaWindow", "EmailOutbox";
-- DROP INDEX IF EXISTS "GuestOtp_identityKey_purpose_createdAt_idx";
-- ALTER TABLE "GuestOtp" DROP COLUMN "supersededAt", DROP COLUMN "codeNonce", DROP COLUMN "contactPhone", DROP COLUMN "email",
--   DROP COLUMN "identityKey", DROP COLUMN "purpose", DROP COLUMN "channel";            -- then: DELETE email rows first, re-add NOT NULL on phone
-- DROP INDEX IF EXISTS "GuestIdentity_email_key";
-- ALTER TABLE "GuestIdentity" DROP COLUMN "phoneVerifiedAt", DROP COLUMN "emailVerifiedAt", DROP COLUMN "verifiedChannel",
--   DROP COLUMN "contactPhone", DROP COLUMN "email";                                    -- then: DELETE email-only identities, re-add NOT NULL on phone
