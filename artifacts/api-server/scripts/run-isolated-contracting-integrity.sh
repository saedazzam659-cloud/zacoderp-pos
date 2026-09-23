#!/bin/sh
set -eu
[ "${CONTRACTING_INTEGRITY_PG:-}" = "1" ] || {
  echo "Refusing to run without CONTRACTING_INTEGRITY_PG=1" >&2
  exit 64
}
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
DATA=$(mktemp -d /tmp/contracting-integrity-pg.XXXXXX)
PORT=$((56432 + ($$ % 800)))
cleanup() {
  pg_ctl -D "$DATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$DATA"
}
trap cleanup EXIT HUP INT TERM
initdb -D "$DATA" -A trust -U postgres --no-locale >/dev/null
pg_ctl -D "$DATA" -o "-h 127.0.0.1 -k $DATA -p $PORT" -w start >/dev/null
URL="postgresql://postgres@127.0.0.1:$PORT/postgres?sslmode=disable"
cd "$ROOT"
env -u DATABASE_URL DATABASE_URL="$URL" pnpm --filter @workspace/db push --force
env -u DATABASE_URL DATABASE_URL="$URL" CONTRACTING_INTEGRITY_PG=1 \
  pnpm --filter @workspace/api-server exec node --import tsx --test \
  __tests__/contracting-project-integrity-pg.test.ts