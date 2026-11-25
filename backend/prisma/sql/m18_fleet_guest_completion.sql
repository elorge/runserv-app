-- M18 (WP-05 fleet + WP-07 guest delivery). ADDITIVE and idempotent: safe to run twice. Rehearse on a restored copy first.

-- ── WP-07: SmsOutbox tracks registered parcels and provider receipts ────────────────────────────────────────
ALTER TABLE "SmsOutbox" ALTER COLUMN "bookingId" DROP NOT NULL;
ALTER TABLE "SmsOutbox" ADD COLUMN IF NOT EXISTS "deliveryId"        TEXT;
ALTER TABLE "SmsOutbox" ADD COLUMN IF NOT EXISTS "provider"          TEXT;
ALTER TABLE "SmsOutbox" ADD COLUMN IF NOT EXISTS "providerMessageId" TEXT;
ALTER TABLE "SmsOutbox" ADD COLUMN IF NOT EXISTS "deliveryStatus"    TEXT;
ALTER TABLE "SmsOutbox" ADD COLUMN IF NOT EXISTS "deliveryAt"        TIMESTAMPTZ(6);
ALTER TABLE "SmsOutbox" ADD COLUMN IF NOT EXISTS "idempotencyKey"    TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "SmsOutbox_kind_deliveryId_key"  ON "SmsOutbox"("kind","deliveryId");
CREATE UNIQUE INDEX IF NOT EXISTS "SmsOutbox_idempotencyKey_key"   ON "SmsOutbox"("idempotencyKey");
CREATE INDEX        IF NOT EXISTS "SmsOutbox_deliveryId_idx"        ON "SmsOutbox"("deliveryId");
CREATE INDEX        IF NOT EXISTS "SmsOutbox_providerMessageId_idx" ON "SmsOutbox"("providerMessageId");
