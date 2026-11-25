#!/usr/bin/env bash
# Backup + restore drill. Proves a dump can be restored and that money invariants survive. Run on a schedule and before risky releases.
#   SRC_URL=<direct url of the database to back up>  SCRATCH_URL=<direct url of a SCRATCH server (NOT production)>  bash scripts/backup-drill.sh
# It dumps SRC (read-only), restores into a new database "runserv_drill" on SCRATCH, compares row counts of every table, and
# checks the LedgerEntry triggers and balance of debits vs credits. Prints timings (use them as your recovery-time estimate).
set -euo pipefail
: "${SRC_URL:?set SRC_URL (direct connection)}"; : "${SCRATCH_URL:?set SCRATCH_URL (scratch server, never production)}"
[ "$SRC_URL" != "$SCRATCH_URL" ] || { echo "SRC_URL and SCRATCH_URL must differ"; exit 1; }
DB=runserv_drill; DUMP="$(mktemp -d)/runserv.dump"
ms() { date +%s%3N; }
t0=$(ms); pg_dump -Fc --no-owner "$SRC_URL" -f "$DUMP"; t1=$(ms)
echo "dump: $(( t1 - t0 )) ms, $(stat -c%s "$DUMP") bytes"
psql "$SCRATCH_URL" -v ON_ERROR_STOP=1 -q -c "drop database if exists $DB" -c "create database $DB"
RURL="$(echo "$SCRATCH_URL" | sed -E "s#/[^/?]*(\?|$)#/$DB\1#")"
t2=$(ms); pg_restore --no-owner -d "$RURL" "$DUMP"; t3=$(ms)
echo "restore: $(( t3 - t2 )) ms"
Q="select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1"
bad=0
for t in $(psql "$SRC_URL" -At -c "$Q"); do
  a=$(psql "$SRC_URL" -At -c "select count(*) from \"$t\""); b=$(psql "$RURL" -At -c "select count(*) from \"$t\"")
  [ "$a" = "$b" ] || { echo "MISMATCH $t: source $a restored $b (writes during the dump can explain small differences)"; bad=1; }
done
trg=$(psql "$RURL" -At -c "select count(*) from pg_trigger where not tgisinternal and tgrelid='\"LedgerEntry\"'::regclass")
[ "$trg" -ge 2 ] || { echo "LedgerEntry triggers missing after restore"; bad=1; }
unb=$(psql "$RURL" -At -c "select coalesce(sum(case when direction='DEBIT' then amount else -amount end),0) from \"LedgerEntry\"")
echo "ledger debit-credit difference after restore: $unb (expected 0)"; [ "$unb" = "0" ] || [ "$unb" = "0.00" ] || bad=1
psql "$SCRATCH_URL" -q -c "drop database $DB"; rm -f "$DUMP"
[ $bad -eq 0 ] && echo "✔ backup drill passed" || { echo "✖ backup drill found problems"; exit 1; }
