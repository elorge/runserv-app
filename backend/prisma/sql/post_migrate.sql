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

-- ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- M7: ledger that cannot be edited, row-level security for Supabase, integrity view
-- ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

-- The financial ledger is append-only. UPDATE, DELETE and TRUNCATE are refused by the database itself, whoever asks.
CREATE OR REPLACE FUNCTION ledger_block_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'LedgerEntry is append-only: correct a mistake with a new, opposite entry';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_no_update   ON "LedgerEntry";
DROP TRIGGER IF EXISTS ledger_no_truncate ON "LedgerEntry";
CREATE TRIGGER ledger_no_update   BEFORE UPDATE OR DELETE ON "LedgerEntry" FOR EACH ROW       EXECUTE FUNCTION ledger_block_change();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE         ON "LedgerEntry" FOR EACH STATEMENT EXECUTE FUNCTION ledger_block_change();

DO $$ BEGIN
  ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_amount_positive" CHECK (amount > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Every event's debits must equal its credits. This view must ALWAYS be empty; alert if it is not.
CREATE OR REPLACE VIEW ledger_unbalanced_groups AS
  SELECT "entryGroup", currency,
         SUM(CASE WHEN direction = 'DEBIT'  THEN amount ELSE 0 END) AS debits,
         SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END) AS credits
    FROM "LedgerEntry"
   GROUP BY "entryGroup", currency
  HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END) <> SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END);

-- A statement can only be imported once per bank (also enforced in the schema; kept here as documentation of intent).

-- ── Supabase: nothing is readable through the public Data API ───────────────────────────────────────────────────────
-- Supabase exposes every table in the "public" schema over its REST API to the anon / authenticated roles. This application talks to
-- the database only through its own server (as the owner role, which is not affected by row-level security), so switch RLS on for
-- every table with NO policies: the Data API can then read and write nothing, even with the public anon key.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated';
  END IF;
END $$;
