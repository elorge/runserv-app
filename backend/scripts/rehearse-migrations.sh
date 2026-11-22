#!/usr/bin/env bash
# Migration rehearsal for the M15 -> M16 -> M16.1 -> M16.2 -> M16.2.1 chain, on a SCRATCH PostgreSQL database.
#   RUNSERV_PG_URL=postgres://user:pass@host:5432/scratch_db  bash scripts/rehearse-migrations.sh
# By default it creates minimal STUB User/Ride/Delivery tables (what the SQL files extend). To rehearse on a RESTORED COPY of the real database instead,
# restore the dump into the scratch database first and run with USE_STUBS=0: the stubs are then skipped and the real tables are used.
# Never point this at production. It applies each file twice (idempotency), then verifies the M16.2.1 columns, indexes and that legacy rows are untouched.
set -euo pipefail
: "${RUNSERV_PG_URL:?set RUNSERV_PG_URL to a scratch database}"
SQL_DIR="$(cd "$(dirname "$0")/../prisma/sql" && pwd)"
psql_() { psql "$RUNSERV_PG_URL" -v ON_ERROR_STOP=1 -q "$@"; }
if [ "${USE_STUBS:-1}" = "1" ]; then
  psql_ <<'SQL'
CREATE TABLE IF NOT EXISTS "User"     ("id" TEXT PRIMARY KEY, "phone" TEXT, "email" TEXT);
CREATE TABLE IF NOT EXISTS "Ride"     ("id" TEXT PRIMARY KEY, "status" TEXT);
CREATE TABLE IF NOT EXISTS "Delivery" ("id" TEXT PRIMARY KEY, "status" TEXT, "podCodeHash" TEXT, "podCodeAttempts" INTEGER NOT NULL DEFAULT 0, "podVerifiedAt" TIMESTAMPTZ(6), "partnerId" TEXT, "failedAt" TIMESTAMPTZ(6));
-- A parcel that already exists when M16.2.1 is deployed (legacy: no nonce). It must survive untouched.
INSERT INTO "Delivery"("id","status","podCodeHash") VALUES ('legacy-1','IN_TRANSIT','abc123') ON CONFLICT DO NOTHING;
SQL
fi
for pass in 1 2; do
  for f in m15_guest_booking.sql m16_sms_outbox.sql m16_1_email_otp.sql m16_2_recipient_handover.sql m16_2_1_pod_code_lifecycle.sql; do
    psql_ -f "$SQL_DIR/$f" >/dev/null && echo "pass $pass  OK  $f"
  done
done
echo "--- verification"
psql_ -At <<'SQL'
SELECT 'columns: ' || string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_name='Delivery' AND column_name IN ('podCodeNonce','podCodeVersion','podCodeExpiresAt','podCodeRotatedAt','podNotifyReservedAt','recipientEmail');
SELECT 'indexes: ' || string_agg(indexname, ',' ORDER BY indexname) FROM pg_indexes WHERE indexname IN ('Delivery_podCodeExpiresAt_idx','EmailOutbox_kind_status_createdAt_idx','EmailOutbox_bookingId_kind_createdAt_idx');
SELECT 'legacy row: nonce=' || coalesce("podCodeNonce",'NULL') || ' version=' || "podCodeVersion" || ' expires=' || coalesce("podCodeExpiresAt"::text,'NULL') || ' hash=' || "podCodeHash" FROM "Delivery" WHERE "id"='legacy-1';
SQL
echo "REHEARSAL OK"
