-- M15: verified guest booking, proof of delivery, failed-delivery handling.
-- ADDITIVE and safe to re-run. Apply to a database that already holds the live tables (see docs/MIGRATION_GUIDE.md), or let
-- `prisma migrate dev` generate the same DDL from schema.prisma. Read it, rehearse on a copy, take a backup first.

-- ── Delivery: proof of delivery + failed delivery ───────────────────────────────────────────────────────────────
ALTER TABLE "Delivery"
  ADD COLUMN IF NOT EXISTS "podCodeHash"     TEXT,
  ADD COLUMN IF NOT EXISTS "podCodeAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "podVerifiedAt"   TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "podMethod"       TEXT,
  ADD COLUMN IF NOT EXISTS "podPhotoUrl"     TEXT,
  ADD COLUMN IF NOT EXISTS "failedAt"        TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "failedReason"    TEXT,
  ADD COLUMN IF NOT EXISTS "returnStatus"    TEXT,
  ADD COLUMN IF NOT EXISTS "returnedAt"      TIMESTAMPTZ(6);

-- ── Guest tables ─────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "GuestIdentity" (
  "id"          TEXT PRIMARY KEY,
  "phone"       TEXT NOT NULL,
  "countryCode" TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "verifiedAt"  TIMESTAMPTZ(6) NOT NULL,
  "convertedAt" TIMESTAMPTZ(6),
  "blockedAt"   TIMESTAMPTZ(6),
  "blockReason" TEXT,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GuestIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX IF NOT EXISTS "GuestIdentity_phone_key"  ON "GuestIdentity"("phone");
CREATE UNIQUE INDEX IF NOT EXISTS "GuestIdentity_userId_key" ON "GuestIdentity"("userId");
CREATE INDEX IF NOT EXISTS "GuestIdentity_createdAt_idx"     ON "GuestIdentity"("createdAt");

CREATE TABLE IF NOT EXISTS "GuestOtp" (
  "id"          TEXT PRIMARY KEY,
  "phone"       TEXT NOT NULL,
  "countryCode" TEXT NOT NULL,
  "codeHash"    TEXT NOT NULL,
  "attempts"    INTEGER NOT NULL DEFAULT 0,
  "expiresAt"   TIMESTAMPTZ(6) NOT NULL,
  "consumedAt"  TIMESTAMPTZ(6),
  "ipHash"      TEXT,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "GuestOtp_phone_createdAt_idx"  ON "GuestOtp"("phone","createdAt");
CREATE INDEX IF NOT EXISTS "GuestOtp_ipHash_createdAt_idx" ON "GuestOtp"("ipHash","createdAt");
CREATE INDEX IF NOT EXISTS "GuestOtp_expiresAt_idx"        ON "GuestOtp"("expiresAt");

CREATE TABLE IF NOT EXISTS "GuestSession" (
  "id"         TEXT PRIMARY KEY,
  "identityId" TEXT NOT NULL,
  "tokenHash"  TEXT NOT NULL,
  "expiresAt"  TIMESTAMPTZ(6) NOT NULL,
  "revokedAt"  TIMESTAMPTZ(6),
  "createdAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GuestSession_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "GuestIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "GuestSession_tokenHash_key"  ON "GuestSession"("tokenHash");
CREATE INDEX IF NOT EXISTS "GuestSession_identityId_idx"        ON "GuestSession"("identityId");
CREATE INDEX IF NOT EXISTS "GuestSession_expiresAt_idx"         ON "GuestSession"("expiresAt");

CREATE TABLE IF NOT EXISTS "GuestBooking" (
  "id"                TEXT PRIMARY KEY,
  "reference"         TEXT NOT NULL,
  "identityId"        TEXT NOT NULL,
  "service"           TEXT NOT NULL,
  "rideId"            TEXT,
  "deliveryId"        TEXT,
  "idempotencyKey"    TEXT NOT NULL,
  "requestHash"       TEXT NOT NULL,
  "quoteId"           TEXT NOT NULL,
  "fare"              DECIMAL(14,2) NOT NULL,
  "currency"          TEXT NOT NULL,
  "vehicleType"       TEXT NOT NULL,
  "trackingTokenHash" TEXT NOT NULL,
  "trackingNonce"     TEXT NOT NULL,
  "trackingExpiresAt" TIMESTAMPTZ(6) NOT NULL,
  "trackingRevokedAt" TIMESTAMPTZ(6),
  "quoteSnapshot"     JSONB,
  "createdAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GuestBooking_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "GuestIdentity"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "GuestBooking_rideId_fkey"     FOREIGN KEY ("rideId")     REFERENCES "Ride"("id")     ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "GuestBooking_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "Delivery"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "GuestBooking_one_target" CHECK (("rideId" IS NOT NULL) <> ("deliveryId" IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS "GuestBooking_reference_key"               ON "GuestBooking"("reference");
CREATE UNIQUE INDEX IF NOT EXISTS "GuestBooking_rideId_key"                  ON "GuestBooking"("rideId");
CREATE UNIQUE INDEX IF NOT EXISTS "GuestBooking_deliveryId_key"              ON "GuestBooking"("deliveryId");
CREATE UNIQUE INDEX IF NOT EXISTS "GuestBooking_quoteId_key"                 ON "GuestBooking"("quoteId");
CREATE UNIQUE INDEX IF NOT EXISTS "GuestBooking_trackingTokenHash_key"       ON "GuestBooking"("trackingTokenHash");
CREATE UNIQUE INDEX IF NOT EXISTS "GuestBooking_identityId_idempotencyKey_key" ON "GuestBooking"("identityId","idempotencyKey");
CREATE INDEX IF NOT EXISTS "GuestBooking_identityId_createdAt_idx"           ON "GuestBooking"("identityId","createdAt");
CREATE INDEX IF NOT EXISTS "GuestBooking_createdAt_idx"                      ON "GuestBooking"("createdAt");

CREATE TABLE IF NOT EXISTS "GuestAuditEvent" (
  "id"         TEXT PRIMARY KEY,
  "event"      TEXT NOT NULL,
  "identityId" TEXT,
  "bookingId"  TEXT,
  "ipHash"     TEXT,
  "meta"       JSONB,
  "createdAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "GuestAuditEvent_identityId_createdAt_idx" ON "GuestAuditEvent"("identityId","createdAt");
CREATE INDEX IF NOT EXISTS "GuestAuditEvent_bookingId_idx"            ON "GuestAuditEvent"("bookingId");
CREATE INDEX IF NOT EXISTS "GuestAuditEvent_event_createdAt_idx"      ON "GuestAuditEvent"("event","createdAt");

-- Guest audit trail is append-only, like PaymentEvent.
CREATE OR REPLACE FUNCTION guest_audit_block_change() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'GuestAuditEvent is append-only'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS guest_audit_no_update   ON "GuestAuditEvent";
DROP TRIGGER IF EXISTS guest_audit_no_truncate ON "GuestAuditEvent";
CREATE TRIGGER guest_audit_no_update   BEFORE UPDATE OR DELETE ON "GuestAuditEvent" FOR EACH ROW       EXECUTE FUNCTION guest_audit_block_change();
CREATE TRIGGER guest_audit_no_truncate BEFORE TRUNCATE         ON "GuestAuditEvent" FOR EACH STATEMENT EXECUTE FUNCTION guest_audit_block_change();

-- Supabase: nothing here is readable through the public Data API (same policy as post_migrate.sql).
ALTER TABLE "GuestIdentity"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GuestOtp"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GuestSession"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GuestBooking"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GuestAuditEvent" ENABLE ROW LEVEL SECURITY;
