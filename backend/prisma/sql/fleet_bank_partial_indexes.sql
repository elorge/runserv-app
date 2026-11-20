-- Run AFTER the Prisma migration that creates the Fleet/Bank tables.
-- Prisma cannot express partial unique indexes, so add this to the generated
-- migration.sql (or run it as its own reviewed migration).
--
-- Guarantees at most one ACTIVE assignment per vehicle and per driver.

CREATE UNIQUE INDEX IF NOT EXISTS "FleetDriverAssignment_one_active_per_vehicle"
  ON "FleetDriverAssignment" ("vehicleId")
  WHERE "status" = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS "FleetDriverAssignment_one_active_per_driver"
  ON "FleetDriverAssignment" ("driverUserId")
  WHERE "status" = 'ACTIVE';

-- ── Money safety nets (safe to run twice) ─────────────────────────────────────────────────────────────────────────────
-- A wallet can never go below zero, whatever a bug or a race tries. The application already debits with one conditional
-- update; this makes the database refuse an overdraw even if some future code path forgets. If the statement fails, some
-- existing wallet is already negative: fix those rows first (SELECT * FROM "Wallet" WHERE balance < 0).
DO $$ BEGIN
  ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_balance_nonnegative" CHECK (balance >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Bank receipts: amounts must be positive; a settlement's received total can never be negative.
DO $$ BEGIN
  ALTER TABLE "BankPayment" ADD CONSTRAINT "BankPayment_amount_positive" CHECK (amount > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "BankSettlement" ADD CONSTRAINT "BankSettlement_received_nonnegative" CHECK ("receivedAmount" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
