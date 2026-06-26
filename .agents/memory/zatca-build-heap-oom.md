---
name: zatca-invoicing prod build heap OOM
description: The zatca-invoicing production build OOMs unless Node's heap cap is raised; how to react when publish fails with "heap out of memory".
---

# zatca-invoicing production build runs out of memory

The `zatca-invoicing` artifact is the largest app in the monorepo (~6000 modules,
heavy deps: pdf, exceljs, html2canvas, charts). Its production build
(`vite build`, run at publish time via `artifact.toml` → package.json `build`)
exhausts Node's default-ish heap and dies with:

```
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

The crash happens AFTER "N modules transformed" / "Generated an empty chunk",
during Rollup's chunk-generation/render phase — not during transform.

**Rule:** keep `NODE_OPTIONS=--max-old-space-size=<N>` in the build script high
enough for the current app size. 2048 MB was too low and caused a publish-build
failure; 4096 MB builds cleanly (~1m35s). If the app keeps growing and this OOMs
again, raise the cap further (the build container has more RAM headroom) or
split bundles via `rollupOptions.output.manualChunks`.

**Why:** the failure surfaces ONLY at publish (the dev server never builds), so
a green dev/typecheck does not catch it. Sourcemaps and the gzip-size report are
already disabled in vite.config — the remaining lever is the heap cap.

**How to apply:** when a publish/deploy build fails, fetch the failed build logs
(deployment skill: listDeploymentBuilds → getDeploymentBuild) and look at the
TAIL. "heap out of memory" on the zatca-invoicing step = bump the heap cap in
`artifacts/zatca-invoicing/package.json` build script. Verify by running the
prod build locally with `PORT=… BASE_PATH=/ NODE_ENV=production` as a temp
workflow (it exceeds the 120s bash limit).
