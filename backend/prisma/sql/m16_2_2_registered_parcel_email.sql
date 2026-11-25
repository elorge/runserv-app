-- M16.2.2 (Option B): registered customers' parcels on the recipient EMAIL flow.
-- FORWARD-ONLY, ADDITIVE, safe to re-run. Apply AFTER m16_2_1_pod_code_lifecycle.sql, then run `prisma generate`.
-- A registered parcel has no GuestBooking, so its RECIPIENT_CODE email row must point at the delivery itself.
-- No existing row is rewritten (the column is NULL for every guest row and for every row that already exists).

ALTER TABLE "EmailOutbox" ADD COLUMN IF NOT EXISTS "deliveryId" TEXT;
CREATE INDEX IF NOT EXISTS "EmailOutbox_deliveryId_kind_createdAt_idx" ON "EmailOutbox"("deliveryId","kind","createdAt");

-- ── ROLLBACK (manual; only after the code that reads this column is rolled back) ─────────────────────────────────
-- DROP INDEX IF EXISTS "EmailOutbox_deliveryId_kind_createdAt_idx";
-- ALTER TABLE "EmailOutbox" DROP COLUMN "deliveryId";
-- NOTE: registered parcels created while Option B was live keep a nonce-derived code the old derivation cannot reproduce. Rotate or finish them first.
