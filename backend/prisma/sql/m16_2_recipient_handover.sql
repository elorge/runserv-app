-- M16.2: recipient hand-over code + tracking link by EMAIL (and, later, SMS). FORWARD-ONLY, ADDITIVE, safe to re-run.
-- Apply AFTER m15_guest_booking.sql, m16_sms_outbox.sql and m16_1_email_otp.sql. Rehearse on a restored copy first (docs/MIGRATION_GUIDE.md).
-- Does not edit any previously applied SQL. No data is rewritten: both columns are nullable and old rows keep working.

-- Where the recipient's hand-over code + tracking link are emailed. NULL for every existing delivery.
ALTER TABLE "Delivery" ADD COLUMN IF NOT EXISTS "recipientEmail" TEXT;

-- Booking-based email jobs (RECIPIENT_CODE, GUEST_TRACKING). OTP rows keep using "otpId" and leave this NULL.
ALTER TABLE "EmailOutbox" ADD COLUMN IF NOT EXISTS "bookingId" TEXT;
CREATE INDEX IF NOT EXISTS "EmailOutbox_bookingId_kind_createdAt_idx" ON "EmailOutbox"("bookingId","kind","createdAt");

-- ── ROLLBACK (manual; only after the code that reads these columns is rolled back) ───────────────────────────────
-- DROP INDEX IF EXISTS "EmailOutbox_bookingId_kind_createdAt_idx";
-- DELETE FROM "EmailOutbox" WHERE "bookingId" IS NOT NULL;   -- optional: queued recipient emails would otherwise be orphaned
-- ALTER TABLE "EmailOutbox" DROP COLUMN "bookingId";
-- ALTER TABLE "Delivery" DROP COLUMN "recipientEmail";
