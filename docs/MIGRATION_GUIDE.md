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
