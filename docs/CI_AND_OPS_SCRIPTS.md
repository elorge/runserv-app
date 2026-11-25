# CI and operations scripts (added 25 Nov 2026)

| Item | Command / file | What it does | Verified how |
|---|---|---|---|
| CI | `.github/workflows/ci.yml` | On push/PR: backend tests + real-PostgreSQL rehearsal; admin build; mobile tests | **Not yet run on GitHub** — first run may need small fixes |
| Staging gate | `API_URL=https://… pnpm staging:check` (backend) | Env rules, DB, ledger triggers, reconciliation clean, MFA on staff, `/health`; prints the manual checklist; writes `staging-check-report.json` | Syntax-checked only; needs a real staging DB |
| Backup drill | `SRC_URL=… SCRATCH_URL=… pnpm db:backup-drill` | Dump, restore into a scratch DB, compare table row counts, check ledger triggers and balance, print timings | Run OK against the local rehearsal DB; failed correctly on a DB lacking triggers |
| Seed guard | `prisma/seed-admin.js` | Outside production it now refuses unless `ALLOW_DEV_SEED=yes` AND the database host is local | Tested with a stubbed Prisma client |
| Env docs | `backend/.env.example` | The 22 previously undocumented variables added | — |

SCRATCH_URL must never be production. The drill does not replace testing a restore of your host's own backups (Supabase PITR).
