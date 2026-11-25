#!/usr/bin/env bash
# WP-02 full rehearsal on a SCRATCH PostgreSQL server (never production).
#   PGHOST=/tmp PGPORT=54329 PGUSER=postgres bash scripts/rehearse-full.sh [path/to/OLD_schema.prisma]
# 1. FRESH INSTALL : baseline DDL from schema.prisma  -> prisma/sql/ORDER.txt applied twice (idempotency) -> invariants
# 2. UPGRADE       : baseline from the OLD (deployed) schema + only the SQL that existed then -> seed rows -> new SQL files -> compare with FRESH (any column/index/table
#                    the fresh install has that the upgraded database lacks is reported = schema/SQL drift)
# 3. RECOVERY      : pg_dump the upgraded DB, restore into a new DB, compare row counts + ledger invariants, report timings.
# The baseline here comes from scripts/schema-to-rehearsal-sql.js (rehearsal only). Production uses Prisma's own diff output (docs/DB_MIGRATIONS.md).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"; SQL="$HERE/prisma/sql"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"; PSQL=("$BIN/psql" -v ON_ERROR_STOP=1 -q -X)
OLD_SCHEMA="${1:-}"; OLD_SQL_COUNT="${OLD_SQL_COUNT:-11}"   # upgrade rehearsal only (path B, a database that already has data): how many ORDER.txt entries the DEPLOYED database already had. UNCONFIRMED — set it from the real deployed database. Irrelevant for a brand-new empty database.
ORDER=($(grep -v '^#' "$SQL/ORDER.txt" | grep -v '^$'))
mk() { "$BIN/dropdb" --if-exists "$1" 2>/dev/null || true; "$BIN/createdb" "$1"; }
ms() { date +%s%3N; }
apply() { local db=$1; shift; for f in "$@"; do "${PSQL[@]}" -d "$db" -f "$SQL/$f" >/dev/null 2>&1 || { echo "FAIL $f on $db"; "${PSQL[@]}" -d "$db" -f "$SQL/$f" 2>&1 | grep -i error | head -3; exit 1; }; done; }
snapshot() { "${PSQL[@]}" -At -d "$1" -c "select 'col '||table_name||'.'||column_name||' '||data_type from information_schema.columns where table_schema='public' union select 'idx '||indexname from pg_indexes where schemaname='public' union select 'con '||conname from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public' union select 'trg '||tgname from pg_trigger where not tgisinternal order by 1"; }

echo "== 1. FRESH INSTALL"; t0=$(ms); mk rs_fresh
node "$HERE/scripts/schema-to-rehearsal-sql.js" "$HERE/prisma/schema.prisma" | "${PSQL[@]}" -d rs_fresh
for pass in 1 2; do apply rs_fresh "${ORDER[@]}"; echo "  pass $pass: ${#ORDER[@]} files OK"; done
echo "  duration $(( $(ms) - t0 )) ms"
"${PSQL[@]}" -At -d rs_fresh <<'SQL'
insert into "LedgerEntry"(id,"entryGroup",account,currency,direction,amount,"refType","refId","idempotencyKey") values ('t1','g','A','NGN','DEBIT',5,'T','1','k:0'),('t2','g','B','NGN','CREDIT',5,'T','1','k:1');
select 'ledger_unbalanced_groups rows: '||count(*) from ledger_unbalanced_groups;
SQL
for stmt in "update \"LedgerEntry\" set amount=9 where id='t1'" "delete from \"LedgerEntry\" where id='t1'" "truncate \"LedgerEntry\"" "insert into \"LedgerEntry\"(id,\"entryGroup\",account,currency,direction,amount,\"refType\",\"refId\",\"idempotencyKey\") values ('t3','g2','A','NGN','DEBIT',1,'T','2','k:0') ,('t4','g2','A','NGN','DEBIT',1,'T','2','k:0')"; do
  if "${PSQL[@]}" -d rs_fresh -c "$stmt" >/dev/null 2>&1; then echo "  !! allowed: $stmt"; exit 1; else echo "  refused OK: ${stmt:0:48}"; fi
done
"${PSQL[@]}" -d rs_fresh -c "insert into \"User\"(id,email,\"updatedAt\") values ('u1','a@b.c',now()) on conflict do nothing" >/dev/null 2>&1 || true
"${PSQL[@]}" -d rs_fresh -c "insert into \"Wallet\"(id,\"userId\",balance,currency,\"updatedAt\") values ('w1','u1',1,'NGN',now())" >/dev/null 2>&1 && \
  { if "${PSQL[@]}" -d rs_fresh -c "update \"Wallet\" set balance=-1 where id='w1'" >/dev/null 2>&1; then echo "  !! negative wallet allowed"; exit 1; else echo "  refused OK: negative wallet balance"; fi; } || echo "  (wallet fixture skipped: required columns differ)"

if [ -n "$OLD_SCHEMA" ]; then
  echo "== 2. UPGRADE from deployed baseline"; t0=$(ms); mk rs_upg
  node "$HERE/scripts/schema-to-rehearsal-sql.js" "$OLD_SCHEMA" | "${PSQL[@]}" -d rs_upg
  apply rs_upg "${ORDER[@]:0:$OLD_SQL_COUNT}"
  "${PSQL[@]}" -d rs_upg -c "insert into \"LedgerEntry\"(id,\"entryGroup\",account,currency,direction,amount,\"refType\",\"refId\",\"idempotencyKey\") values ('o1','og','WALLET:x','NGN','CREDIT',10,'T','1','old:0'),('o2','og','PLATFORM:CLEARING','NGN','DEBIT',10,'T','1','old:1')" >/dev/null
  before=$("${PSQL[@]}" -At -d rs_upg -c 'select count(*) from "LedgerEntry"')
  echo "  deployed baseline loaded (ledger rows: $before)"
  apply rs_upg "${ORDER[@]:$OLD_SQL_COUNT}"; apply rs_upg "${ORDER[@]}"
  after=$("${PSQL[@]}" -At -d rs_upg -c 'select count(*) from "LedgerEntry"'); [ "$before" = "$after" ] && echo "  existing data untouched ($after ledger rows)"
  echo "  duration $(( $(ms) - t0 )) ms"
  snapshot rs_fresh > /tmp/rs_fresh.snap; snapshot rs_upg > /tmp/rs_upg.snap
  echo "  schema drift (in FRESH but missing after UPGRADE by SQL files alone):"
  comm -23 /tmp/rs_fresh.snap /tmp/rs_upg.snap | sed 's/^/    /' | head -60
  echo "  (the above are changes in schema.prisma since the deployed baseline that the SQL files do NOT create: they come from 'prisma migrate diff' output, see docs/DB_MIGRATIONS.md)"
  echo "== 3. RECOVERY (dump -> restore)"; t0=$(ms)
  "$BIN/pg_dump" -Fc rs_upg > /tmp/rs_upg.dump; echo "  dump $(( $(ms) - t0 )) ms, $(stat -c%s /tmp/rs_upg.dump) bytes"; t1=$(ms)
  mk rs_restored; "$BIN/pg_restore" -d rs_restored /tmp/rs_upg.dump; echo "  restore $(( $(ms) - t1 )) ms"
  a=$("${PSQL[@]}" -At -d rs_restored -c 'select count(*) from "LedgerEntry"'); [ "$a" = "$after" ] && echo "  restored ledger rows match ($a)"
  "${PSQL[@]}" -d rs_restored -c "update \"LedgerEntry\" set amount=1" >/dev/null 2>&1 && { echo "  !! ledger editable after restore"; exit 1; } || echo "  ledger still append-only after restore"
fi
echo "REHEARSAL COMPLETE"
