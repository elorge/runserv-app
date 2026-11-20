-- M13: driver-licence eligibility + transactional outbox. ADDITIVE and safe to re-run (for a database created BEFORE M13).
ALTER TABLE "DriverProfile"
  ADD COLUMN IF NOT EXISTS "licenseClass"              TEXT,
  ADD COLUMN IF NOT EXISTS "licenseExpiresAt"          DATE,
  ADD COLUMN IF NOT EXISTS "licenseVerificationStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN IF NOT EXISTS "licenseVerifiedAt"         TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "licenseVerifiedById"       TEXT,
  ADD COLUMN IF NOT EXISTS "licenseRejectedReason"     TEXT;

CREATE TABLE IF NOT EXISTS "OutboxEvent" (
  "id"            TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "type"          TEXT NOT NULL,
  "aggregateType" TEXT NOT NULL,
  "aggregateId"   TEXT NOT NULL,
  "payload"       JSONB NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'PENDING',
  "attempts"      INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError"     TEXT,
  "processedAt"   TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "OutboxEvent_type_aggregateType_aggregateId_key" ON "OutboxEvent"("type","aggregateType","aggregateId");
CREATE INDEX IF NOT EXISTS "OutboxEvent_status_nextAttemptAt_idx" ON "OutboxEvent"("status","nextAttemptAt");
