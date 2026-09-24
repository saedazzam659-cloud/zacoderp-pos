#!/bin/sh
# Isolated integration test: creates its own loopback cluster, never uses the
# inherited DATABASE_URL, and removes the cluster on all exits.
set -eu
if [ "${CONTRACTING_ISOLATED_LIFECYCLE:-}" != "1" ]; then
  echo "Refusing to run without CONTRACTING_ISOLATED_LIFECYCLE=1" >&2
  exit 64
fi
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
DATA=$(mktemp -d /tmp/contracting-voucher-pg.XXXXXX)
PORT=""
cleanup() {
  if [ -n "$PORT" ]; then pg_ctl -D "$DATA" -m immediate stop >/dev/null 2>&1 || :; fi
  rm -rf "$DATA"
}
trap cleanup EXIT HUP INT TERM
initdb -D "$DATA" -A trust -U postgres --no-locale >/dev/null
base=$((56500 + ($$ % 500)))
i=0
while [ "$i" -lt 64 ]; do
  candidate=$((base + i))
  if pg_ctl -D "$DATA" -o "-h 127.0.0.1 -k $DATA -p $candidate" -w start >/dev/null 2>&1; then
    PORT=$candidate
    break
  fi
  i=$((i + 1))
done
if [ -z "$PORT" ]; then echo "No free loopback PostgreSQL port" >&2; exit 1; fi
URL="postgresql://postgres@127.0.0.1:$PORT/postgres?sslmode=disable"
cd "$ROOT"
env -u DATABASE_URL DATABASE_URL="$URL" pnpm --filter @workspace/db push --force
env -u DATABASE_URL DATABASE_URL="$URL" CONTRACTING_ISOLATED_LIFECYCLE=1 \
  pnpm --filter @workspace/api-server exec node --import tsx --test \
  __tests__/contracting-voucher-isolated.test.ts