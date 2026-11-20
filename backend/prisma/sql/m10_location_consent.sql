-- M10: live-location consent, last accepted GPS fix, and pickup source/accuracy.
-- ADDITIVE and safe to re-run: only for a database that was created BEFORE M10. A fresh `pnpm db:init` already has these columns.
ALTER TABLE "DriverProfile"
  ADD COLUMN IF NOT EXISTS "locationConsentAt"        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "locationConsentVersion"   TEXT,
  ADD COLUMN IF NOT EXISTS "locationConsentRevokedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastLocationAt"           TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "locationAccuracy"         DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "locationHeading"          DOUBLE PRECISION;

ALTER TABLE "DeliveryPartnerProfile"
  ADD COLUMN IF NOT EXISTS "locationConsentAt"        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "locationConsentVersion"   TEXT,
  ADD COLUMN IF NOT EXISTS "locationConsentRevokedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastLocationAt"           TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "locationAccuracy"         DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "locationHeading"          DOUBLE PRECISION;

ALTER TABLE "Ride"
  ADD COLUMN IF NOT EXISTS "pickupSource"     TEXT,
  ADD COLUMN IF NOT EXISTS "pickupAccuracyM"  DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "pickupCapturedAt" TIMESTAMP(3);

ALTER TABLE "Delivery"
  ADD COLUMN IF NOT EXISTS "pickupSource"     TEXT,
  ADD COLUMN IF NOT EXISTS "pickupAccuracyM"  DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "pickupCapturedAt" TIMESTAMP(3);

-- Drivers who were online before M10 have never consented: take them offline and forget their stored position,
-- so nobody is shown (or dispatched) on a position they never agreed to share.
UPDATE "DriverProfile"          SET "isOnline" = false, "currentLat" = NULL, "currentLng" = NULL WHERE "locationConsentAt" IS NULL AND ("isOnline" = true OR "currentLat" IS NOT NULL);
UPDATE "DeliveryPartnerProfile" SET "isOnline" = false, "currentLat" = NULL, "currentLng" = NULL WHERE "locationConsentAt" IS NULL AND ("isOnline" = true OR "currentLat" IS NOT NULL);
