---
name: POS Desktop release mechanism
description: How POS Desktop tags trigger Windows MSI builds and draft releases
---

# POS Desktop release / GitHub tagging

The Windows workflow starts when a `pos-desktop-v*` tag is pushed. It builds the online and
offline MSI variants and creates a **draft GitHub Release**; the draft is not published
automatically.

## Recheck the current push path
The prior stale-credential / user-only push assumption is outdated. On 2026-11-09, a
tag-only push through the current Replit internal `origin` succeeded and launched the Windows
workflow. Check the current remote and tag state each session rather than assuming either the
GitHub integration or Git pane is required.

## Keep divergent history out of the release
When workspace `main` is substantially ahead of the latest POS Desktop tag, do not push it just
to trigger a Windows build. Base a release commit on the latest POS Desktop tag, port only the
required POS Desktop changes, and push only the new version tag. Do not publish the draft unless
the user asks.

**Why:** a tag-only build can run without exposing unrelated monorepo history or generated files;
the workflow produces a draft, so build verification does not change the live download channels.

**How to apply:** keep `package.json`, `Cargo.toml`, and `tauri.conf.json` versions aligned; verify
the frontend build and manually review Rust column/parameter mappings because Cargo is available
only in Windows CI; confirm the Actions result before claiming an MSI exists.
