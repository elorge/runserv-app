# Database migrations, integrity and recovery (WP-02)

**Package manager:** pnpm **10.28.0**, lockfile v9 (`packageManager` in each package.json). Older notes that say 9.15.0 are out of date. Install with `pnpm install --frozen-lockfile`; the backend lockfile was regenerated in this pass because it was missing `pg`.

## Two layers, one order
1. **Prisma layer** – tables, columns, enums, FKs. Produced by Prisma, never hand-written.
2. **SQL layer** – partial/exclusion indexes, CHECKs, append-only triggers, RLS, idempotent milestone additions. Files live in `backend/prisma/sql/` and are applied in the order of `backend/prisma/sql/ORDER.txt` (enforced by `tests/wp02SqlOrder.test.js`). Every file is re-runnable.

## Fresh install
```
cd backend && pnpm install --frozen-lockfile
pnpm prisma validate && pnpm prisma generate
pnpm db:baseline                # prisma migrate diff --from-empty ... > prisma/baseline.sql  (needs the Prisma engines: run in CI/your machine)
psql "$DIRECT_URL" -f prisma/baseline.sql
pnpm db:apply-sql               # ORDER.txt, idempotent
pnpm seed:admin
```
Commit the baseline as `prisma/migrations/0_init/migration.sql` and `pnpm prisma migrate resolve --applied 0_init` on every existing database so later `migrate deploy` works.

## Upgrade of a deployed database (M16.2.2 → this release)
1. Back up (`pg_dump -Fc`) and **restore into staging first**.
2. `pnpm prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script > delta.sql`; read it (must be additive: no DROP).
3. Apply `delta.sql`, then `pnpm db:apply-sql`.
4. `pnpm db:opening-balances` (dry run) → review with Finance → `-- --apply`. Then run a manual reconciliation (Admin → Finance → Reconciliation or `POST /api/admin/finance/reconciliation/run`): expect status OK.
5. Production: same steps in a maintenance window.

## Rehearsal evidence (this pass)
`bash scripts/rehearse-full.sh <deployed-schema.prisma>` on PostgreSQL 16 (scratch server, schema-derived baseline; **not** Prisma's own DDL):
| Step | Result |
|---|---|
| Fresh install, ORDER.txt applied twice | 16 files OK both passes (re-run 2026-11-25) |
| Found and fixed | `fleet_settlement_overlap.sql` failed on a second run (EXCLUDE constraint raises `duplicate_table`, not `duplicate_object`) |
| Ledger append-only | UPDATE, DELETE, TRUNCATE and duplicate idempotency key all refused |
| `Wallet_balance_nonnegative` | negative balance refused |
| Upgrade from the M16.2.2 schema + seed ledger rows | new SQL applied, existing rows untouched, **no schema drift** between upgraded and fresh |
| Dump → restore | dump 80 ms, restore 468 ms (test data only), ledger still append-only |

**Still to do outside this sandbox:** run with the real Prisma baseline, against a restored copy of the live database, and time it at real volume. Verify Supabase RLS with real user/staff/service identities.

## Backup / restore / failed-migration runbook
- Before any migration: `pg_dump -Fc "$DIRECT_URL" > pre_<date>.dump`; note row counts of Wallet, LedgerEntry, Payout.
- Failed migration: the SQL files are additive; fix forward by correcting the file and re-running (idempotent). Restore only if data was damaged: `createdb restored && pg_restore -d restored pre.dump`, verify counts + `pnpm db:check-ledger`, then switch the connection string.
- After any restore: run reconciliation; `ledger_unbalanced_groups` must be empty.
