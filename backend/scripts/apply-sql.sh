#!/usr/bin/env bash
# Applies every hand-written SQL file in the authoritative order (prisma/sql/ORDER.txt). Idempotent. Needs DIRECT_URL (or RUNSERV_PG_URL).
set -euo pipefail
URL="${DIRECT_URL:-${RUNSERV_PG_URL:-}}"; : "${URL:?set DIRECT_URL (direct, non-pooled connection)}"
SQL="$(cd "$(dirname "$0")/../prisma/sql" && pwd)"
for f in $(grep -v '^#' "$SQL/ORDER.txt" | grep -v '^$'); do echo "applying $f"; psql "$URL" -v ON_ERROR_STOP=1 -q -f "$SQL/$f" >/dev/null; done
echo "done ($(grep -vc '^#\|^$' "$SQL/ORDER.txt") files)"
