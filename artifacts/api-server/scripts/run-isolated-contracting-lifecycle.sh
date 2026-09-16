#!/bin/sh
# Runs only against a throwaway loopback PostgreSQL cluster.  It deliberately
# refuses to run unless explicitly armed, and never inherits DATABASE_URL.
set -eu

if [ "${CONTRACTING_ISOLATED_LIFECYCLE:-}" != "1" ]; then
  echo "Refusing to run: set CONTRACTING_ISOLATED_LIFECYCLE=1." >&2
  exit 64
fi

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
DATA=$(mktemp -d /tmp/contracting-lifecycle-pg.XXXXXX)
PORT=""

cleanup() {
  if [ -n "$PORT" ]; then
    pg_ctl -D "$DATA" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf "$DATA"
}
trap cleanup EXIT HUP INT TERM

initdb -D "$DATA" -A trust -U postgres --no-locale >/dev/null

# A process-derived starting point prevents collisions across parallel agent
# jobs. pg_ctl is still the final arbiter: retrying on bind failure means no
# non-loopback or pre-existing database is ever contacted.
base=$((55432 + ($$ % 1000)))
i=0
while [ "$i" -lt 64 ]; do
  candidate=$((base + i))
  # The container has no writable /run/postgresql socket directory. Keep the
  # auxiliary Unix socket inside the disposable cluster while TCP listens only
  # on loopback.
  if pg_ctl -D "$DATA" -o "-h 127.0.0.1 -k $DATA -p $candidate" -w start >/dev/null 2>&1; then
    PORT=$candidate
    break
  fi
  i=$((i + 1))
done
if [ -z "$PORT" ]; then
  echo "Could not reserve an isolated loopback PostgreSQL port." >&2
  exit 1
fi

URL="postgresql://postgres@127.0.0.1:$PORT/postgres?sslmode=disable"
case "$URL" in
  postgresql://postgres@127.0.0.1:*) ;;
  *) echo "Internal safety check failed: non-loopback database URL." >&2; exit 1 ;;
esac

cd "$ROOT"
env -u DATABASE_URL DATABASE_URL="$URL" pnpm --filter @workspace/db push --force
env -u DATABASE_URL DATABASE_URL="$URL" CONTRACTING_ISOLATED_LIFECYCLE=1 \
  pnpm --filter @workspace/api-server exec node --import tsx --test \
  __tests__/contracting-lifecycle-isolated.test.ts