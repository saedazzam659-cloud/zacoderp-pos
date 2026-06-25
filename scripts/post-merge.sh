#!/bin/bash
set -e

pnpm install --frozen-lockfile

# Schema reconciliation is handled by the api-server's ensureSchema self-healing
# migration, which runs on every boot (workflow reconciliation restarts the
# api-server after this script). This project intentionally avoids `drizzle-kit
# push` as a migration path: on the full multi-tenant schema it is slow, prompts
# interactively for unrelated accumulated drift (stdin is closed during
# post-merge, so it hangs), and bundles changes far outside any single task.
