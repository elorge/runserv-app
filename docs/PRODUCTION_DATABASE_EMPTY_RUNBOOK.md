# Production database — brand-new, empty (path A)

Decision recorded 2026-11-24: the production database is **new and empty**. There is no customer, ride, delivery or financial data to migrate, so no baseline-resolve or upgrade step is needed and `OLD_SQL_COUNT` is irrelevant. If any data is ever loaded before launch, stop and use the existing-database path instead.

> Status: this is a procedure. It has **not** been run against a real Supabase/PostgreSQL project, and Prisma's own DDL has not been generated in this environment (Prisma engines are blocked here). Steps 3 and 4 must be done on a machine with normal network access, first against **staging**.

## Order
1. **Staging first.** Create a separate empty PostgreSQL 16 / Supabase project. Set `DATABASE_URL` (pooled app connection) and `DIRECT_URL` (direct connection for migrations) in the host's secret manager only. Never paste them in chat.
2. **Roles.** Use a migration role (owner) and a least-privilege application role. The app must not connect as a superuser.
3. **Generate the real migration history** (once, on a normal machine, empty scratch database):
   `cd backend && pnpm install --frozen-lockfile && npx prisma validate && npx prisma migrate dev --name init --create-only`
   Read the generated SQL, then commit `backend/prisma/migrations/` (including `migration_lock.toml`). Do **not** use `scripts/schema-to-rehearsal-sql.js` for production; it is rehearsal-only.
4. **Fresh install on staging:** `npx prisma migrate deploy` (creates every table from the committed history), then `pnpm run db:apply-sql` (applies the 16 files in `prisma/sql/ORDER.txt`; safe to run twice). Run it twice and confirm no error.
5. **Gates before any money flows:** `pnpm run db:check-ledger` exits 0 (an empty ledger passes); `pnpm run db:opening-balances` reports 0 accounts (nothing to back-fill); backend `npx jest` green; admin and mobile builds.
6. **Security checks on staging:** staff MFA (`REQUIRE_STAFF_MFA=true`, exactly lowercase), log-out-everywhere, row-level security with real anon/authenticated/service/staff identities, CORS, rate limits, webhook secrets (`SMS_WEBHOOK_SECRET`, payment and email webhook secrets), backups and a restore test, point-in-time recovery switched on.
7. **Repeat 3–5 for production** only after staging passes. First real action: create the first super-admin and enrol MFA.
8. **Providers in test mode, then a small pilot** with low limits; watch the reconciliation job, failed webhooks, SMS/email queues and push delivery.

## Rollback
Before go-live, the database is empty, so rollback is "drop and recreate". After go-live, take a backup before every deploy and rehearse the restore.
