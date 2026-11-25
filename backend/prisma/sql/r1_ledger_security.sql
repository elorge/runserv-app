-- R1/R3 (WP-01 + WP-03): reconciliation runs, token revocation. ADDITIVE and safe to run twice. Apply AFTER post_migrate.sql.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "sessionsRevokedAt" TIMESTAMPTZ(6);

CREATE TABLE IF NOT EXISTS "RevokedToken" (
  "id"        TEXT PRIMARY KEY,
  "userId"    TEXT NOT NULL,
  "reason"    TEXT NOT NULL DEFAULT 'LOGOUT',
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "RevokedToken_userId_idx"    ON "RevokedToken"("userId");
CREATE INDEX IF NOT EXISTS "RevokedToken_expiresAt_idx" ON "RevokedToken"("expiresAt");

CREATE TABLE IF NOT EXISTS "LedgerReconciliationRun" (
  "id"          TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "trigger"     TEXT NOT NULL DEFAULT 'SCHEDULED',
  "status"      TEXT NOT NULL DEFAULT 'RUNNING',
  "startedAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "finishedAt"  TIMESTAMPTZ(6),
  "startedById" TEXT,
  "summary"     JSONB,
  "exceptions"  JSONB,
  "error"       TEXT
);
CREATE INDEX IF NOT EXISTS "LedgerReconciliationRun_startedAt_idx" ON "LedgerReconciliationRun"("startedAt");
CREATE INDEX IF NOT EXISTS "LedgerReconciliationRun_status_idx"    ON "LedgerReconciliationRun"("status");
