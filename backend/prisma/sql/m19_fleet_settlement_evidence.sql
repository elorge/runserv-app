-- m19: fleet settlements can only be PAID with payment evidence (reference, method, amount, who recorded it).
-- Idempotent. Existing PAID rows (legacy, no evidence) are tolerated: the CHECK is NOT VALID, so it guards new/updated rows only.
ALTER TABLE "FleetSettlement" ADD COLUMN IF NOT EXISTS "paymentReference" TEXT;
ALTER TABLE "FleetSettlement" ADD COLUMN IF NOT EXISTS "paymentMethod" TEXT;
ALTER TABLE "FleetSettlement" ADD COLUMN IF NOT EXISTS "paidAmount" DECIMAL(14,2);
ALTER TABLE "FleetSettlement" ADD COLUMN IF NOT EXISTS "paymentProofRef" TEXT;
ALTER TABLE "FleetSettlement" ADD COLUMN IF NOT EXISTS "paymentNote" TEXT;
ALTER TABLE "FleetSettlement" ADD COLUMN IF NOT EXISTS "paidById" TEXT;
ALTER TABLE "FleetSettlement" ADD COLUMN IF NOT EXISTS "payoutAccountMasked" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "FleetSettlement_paymentReference_key" ON "FleetSettlement"("paymentReference");

DO $$ BEGIN
  ALTER TABLE "FleetSettlement" ADD CONSTRAINT "FleetSettlement_paid_needs_evidence"
    CHECK ("status" <> 'PAID' OR ("paymentReference" IS NOT NULL AND "paidAmount" IS NOT NULL AND "paidAmount" = "netAmount" AND "paidAt" IS NOT NULL)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
