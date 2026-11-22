-- M16: durable SMS outbox for guest bookings. ADDITIVE and safe to re-run. Rehearse on a restored copy first (docs/MIGRATION_GUIDE.md).
CREATE TABLE IF NOT EXISTS "SmsOutbox" (
  "id"            TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "kind"          TEXT NOT NULL,
  "bookingId"     TEXT NOT NULL,
  "toPhone"       TEXT,
  "toMasked"      TEXT NOT NULL,
  "countryCode"   TEXT,
  "status"        TEXT NOT NULL DEFAULT 'PENDING',
  "attempts"      INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "lastError"     TEXT,
  "sentAt"        TIMESTAMPTZ(6),
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "SmsOutbox_kind_bookingId_key"      ON "SmsOutbox"("kind","bookingId");
CREATE INDEX        IF NOT EXISTS "SmsOutbox_status_nextAttemptAt_idx" ON "SmsOutbox"("status","nextAttemptAt");
CREATE INDEX        IF NOT EXISTS "SmsOutbox_bookingId_idx"            ON "SmsOutbox"("bookingId");

-- Supabase: not readable through the public Data API (same policy as the other guest tables).
ALTER TABLE "SmsOutbox" ENABLE ROW LEVEL SECURITY;
