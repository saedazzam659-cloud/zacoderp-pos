---
name: Artifact environment in workspace builds
description: Environment-variable requirements for package builds run recursively from the monorepo root.
---

Root recursive builds may run an artifact's package build script without injecting that artifact service's `[services.env]` values.

**Why:** Vite evaluates its config during `vite build`, even though dev-server ports are unused; requiring runtime-only variables at config import time can stop the whole workspace build.

**How to apply:** Preserve values supplied by the managed artifact service, but use artifact-specific defaults for build-time config values such as `PORT` and `BASE_PATH` when the root workspace build omits them. Verify with `pnpm run build`.
