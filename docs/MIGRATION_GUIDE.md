# FIRST-TIME SETUP ON A FRESH SUPABASE DATABASE (M7)

Your database is empty, so create everything in one go. In `backend/.env` set `DATABASE_URL` (pooled, port 6543, `?pgbouncer=true&connection_limit=1`) and `DIRECT_URL` (direct, port 5432). Then:

    cd backend
    pnpm install
    CONFIRM_EMPTY_DB=yes pnpm db:init        # prisma migrate dev --create-only, appends prisma/sql/post_migrate.sql, migrate deploy, generate
    pnpm seed:admin

Add `PAUSE_BEFORE_APPLY=yes` to read the generated SQL before it runs. Later schema changes: `pnpm db:migrate --name what_changed` (dev) and `pnpm db:deploy` (production). Never run `db:init` twice.

post_migrate.sql adds the partial indexes and CHECKs, makes LedgerEntry append-only, and enables row-level security on every table so the Supabase public Data API can read nothing.
NOTE: this was written without being able to run Prisma against a database. Do the first run on a throw-away Supabase project.

(Everything below is the original guide for a database that already holds live data.)

---

# Applying the schema changes safely

M6 changes `prisma/schema.prisma`: new tables (`BankReceivingAccount`, `BankPayment`), new columns on `BankPartner` (callback secret),
`BankSettlement` (`paymentReference`, `receivedAmount`), `Ride` and `Delivery` (`paymentMethod`, default `CASH`), plus the earlier Fleet/Bank tables.

## ⚠ If your Supabase database already holds the live app's tables
Do **not** run `prisma migrate dev` against it. With no migration history it detects "drift" and offers to **reset the database (deletes all data)**.

1. Back up first (Supabase → Database → Backups, or `pg_dump`). Rehearse on a copy.
2. Produce only the difference between the live database and the new schema:
   `pnpm prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script > delta.sql`
   (uses `DIRECT_URL`). Read `delta.sql`. It must only contain CREATE TABLE/TYPE/INDEX and ADD COLUMN, no DROP.
3. Apply it in the Supabase SQL editor, then run `prisma/sql/fleet_bank_partial_indexes.sql` (partial unique indexes and the money safety constraints).
   If the `Wallet_balance_nonnegative` constraint fails, some wallet is already negative: `SELECT * FROM "Wallet" WHERE balance < 0;` and fix those first.
4. Baseline so future migrations work: `pnpm prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > baseline.sql`,
   save as `prisma/migrations/0_init/migration.sql`, then `pnpm prisma migrate resolve --applied 0_init`.

## Fresh database (staging)
`pnpm prisma migrate dev --create-only --name init`, append `prisma/sql/fleet_bank_partial_indexes.sql` to the generated file, then `pnpm prisma migrate dev`.


# M15 guest-booking schema on an EXISTING database (M16 procedure)

`backend/prisma/sql/m15_guest_booking.sql` is additive and re-runnable (`IF NOT EXISTS`, triggers dropped and recreated). It is **not** a fresh-install script: never run `db:init` against a database that already has data.
**Status: reviewed, not yet rehearsed.** Nobody has applied it to a restored copy yet; do that first.

1. Decide: fresh empty database (use the first-time setup above) or one with live data (continue here).
2. Back up the production database. Restore the backup into a separate staging project.
3. Read `m15_guest_booking.sql` next to the `Guest*` models and the new `Delivery` columns in `schema.prisma`. Check indexes, unique constraints (reference, quoteId, trackingTokenHash, `identityId+idempotencyKey`), the append-only trigger on `GuestAuditEvent`, and RLS.
4. On the staging copy, in order: `psql "$STAGING_DATABASE_URL" -f backend/prisma/sql/m15_guest_booking.sql`, then `-f backend/prisma/sql/m16_sms_outbox.sql` (new `SmsOutbox` table for durable guest SMS; same re-runnable rules).
5. `cd backend && pnpm exec prisma validate && pnpm exec prisma generate`, then `pnpm exec jest --runInBand` against the staging URL where tests allow it.
6. Spot-check: `\d "GuestOtp"` shows the `(phone, createdAt)` and `(ipHash, createdAt)` indexes (the OTP arbitration queries rely on them); try an UPDATE on `GuestAuditEvent` and confirm it is refused.
7. Record what was applied (date, operator, commit, row counts before/after) at the bottom of this file.
8. Production: same file, in a maintenance window, after step 7 is signed off. Keep `GUEST_BOOKING_ENABLED=false` until staging end-to-end passes.

Rollback: the migrations only add columns/tables/triggers (`SmsOutbox` included). To back out, restore the pre-migration backup (preferred), or drop the `Guest*` tables and the nine added `Delivery` columns in a transaction after confirming no guest data must be kept.

## M16.2: recipient hand-over code by email

Run **`m16_2_recipient_handover.sql`** after `m16_1_email_otp.sql`, then `prisma generate`. It adds two nullable columns (`Delivery.recipientEmail`, `EmailOutbox.bookingId`) and one index. Forward-only, additive, idempotent; rollback notes are at the bottom of the file. Rehearsed on PostgreSQL 16 (stub tables, run twice). Still to do: rehearse on a restored copy of the real database. See `docs/M16_2_RECIPIENT_HANDOVER.md`.
