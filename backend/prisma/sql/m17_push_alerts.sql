-- WP-08: push device tokens + durable ops alerts. ADDITIVE and safe to run twice.
CREATE TABLE IF NOT EXISTS "DeviceToken" (
  "id"         TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "userId"     TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "platform"   TEXT NOT NULL,
  "appVariant" TEXT,
  "token"      TEXT NOT NULL,
  "deviceId"   TEXT,
  "lastSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "revokedAt"  TIMESTAMPTZ(6),
  "createdAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "DeviceToken_token_key"           ON "DeviceToken"("token");
CREATE INDEX        IF NOT EXISTS "DeviceToken_userId_revokedAt_idx" ON "DeviceToken"("userId","revokedAt");
CREATE INDEX        IF NOT EXISTS "DeviceToken_deviceId_idx"         ON "DeviceToken"("deviceId");

CREATE TABLE IF NOT EXISTS "OpsAlert" (
  "id"               TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "kind"             TEXT NOT NULL,
  "dedupeKey"        TEXT NOT NULL,
  "severity"         TEXT NOT NULL DEFAULT 'WARNING',
  "title"            TEXT NOT NULL,
  "message"          TEXT NOT NULL,
  "data"             JSONB,
  "status"           TEXT NOT NULL DEFAULT 'OPEN',
  "occurrences"      INTEGER NOT NULL DEFAULT 1,
  "attempts"         INTEGER NOT NULL DEFAULT 0,
  "createdAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "lastSeenAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "firstNotifiedAt"  TIMESTAMPTZ(6),
  "lastNotifiedAt"   TIMESTAMPTZ(6),
  "escalatedAt"      TIMESTAMPTZ(6),
  "acknowledgedById" TEXT,
  "acknowledgedAt"   TIMESTAMPTZ(6),
  "resolvedById"     TEXT,
  "resolvedAt"       TIMESTAMPTZ(6),
  "resolutionNote"   TEXT
);
CREATE INDEX IF NOT EXISTS "OpsAlert_status_createdAt_idx" ON "OpsAlert"("status","createdAt");
CREATE INDEX IF NOT EXISTS "OpsAlert_dedupeKey_status_idx" ON "OpsAlert"("dedupeKey","status");
CREATE INDEX IF NOT EXISTS "OpsAlert_kind_idx"             ON "OpsAlert"("kind");
-- At most one unresolved alert per dedupeKey (Prisma cannot express a partial index; the service also checks first and handles P2002).
CREATE UNIQUE INDEX IF NOT EXISTS "OpsAlert_open_dedupeKey_key" ON "OpsAlert"("dedupeKey") WHERE "status" <> 'RESOLVED';

CREATE TABLE IF NOT EXISTS "OpsAlertDelivery" (
  "id"            TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "alertId"       TEXT NOT NULL REFERENCES "OpsAlert"("id") ON DELETE CASCADE,
  "channel"       TEXT NOT NULL,
  "round"         INTEGER NOT NULL DEFAULT 0,
  "status"        TEXT NOT NULL DEFAULT 'PENDING',
  "attempts"      INTEGER NOT NULL DEFAULT 0,
  "lastError"     TEXT,
  "nextAttemptAt" TIMESTAMPTZ(6),
  "sentAt"        TIMESTAMPTZ(6),
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "OpsAlertDelivery_alertId_idx"             ON "OpsAlertDelivery"("alertId");
CREATE INDEX IF NOT EXISTS "OpsAlertDelivery_status_nextAttemptAt_idx" ON "OpsAlertDelivery"("status","nextAttemptAt");
