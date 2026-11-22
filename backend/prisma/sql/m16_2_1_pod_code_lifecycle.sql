-- M16.2.1: hand-over code lifecycle (random per-code nonce, expiry, rotation) + atomic resend reservation.
-- FORWARD-ONLY, ADDITIVE, safe to re-run. Apply AFTER m16_2_recipient_handover.sql. Rehearse on a restored copy first (docs/MIGRATION_GUIDE.md).
-- No existing row is rewritten: a delivery with a NULL "podCodeNonce" keeps the legacy code derivation until an admin rotates it,
-- so a parcel already in flight at deploy time is never broken. New guest parcels get a nonce at booking.

ALTER TABLE "Delivery" ADD COLUMN IF NOT EXISTS "podCodeNonce"          TEXT;
ALTER TABLE "Delivery" ADD COLUMN IF NOT EXISTS "podCodeVersion"        INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Delivery" ADD COLUMN IF NOT EXISTS "podCodeExpiresAt"      TIMESTAMPTZ(6);
ALTER TABLE "Delivery" ADD COLUMN IF NOT EXISTS "podCodeRotatedAt"      TIMESTAMPTZ(6);
ALTER TABLE "Delivery" ADD COLUMN IF NOT EXISTS "podNotifyReservedAt"   TIMESTAMPTZ(6);

-- Operations: "which parcels still need a code and have an expired one" / metrics by kind and age.
CREATE INDEX IF NOT EXISTS "Delivery_podCodeExpiresAt_idx" ON "Delivery"("podCodeExpiresAt") WHERE "podCodeHash" IS NOT NULL AND "podVerifiedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "EmailOutbox_kind_status_createdAt_idx" ON "EmailOutbox"("kind","status","createdAt");

-- ── ROLLBACK (manual; only after the code that reads these columns is rolled back) ───────────────────────────────
-- DROP INDEX IF EXISTS "EmailOutbox_kind_status_createdAt_idx";
-- DROP INDEX IF EXISTS "Delivery_podCodeExpiresAt_idx";
-- ALTER TABLE "Delivery" DROP COLUMN "podNotifyReservedAt", DROP COLUMN "podCodeRotatedAt", DROP COLUMN "podCodeExpiresAt", DROP COLUMN "podCodeVersion", DROP COLUMN "podCodeNonce";
-- NOTE: rolling back after a rotation leaves codes the old derivation cannot reproduce: rotate nothing before rollback, or reissue by hand.
