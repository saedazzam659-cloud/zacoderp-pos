---
name: POS Desktop release mechanism
description: How POS Desktop MSI releases are cut, and why the Replit main agent cannot do it itself
---

# POS Desktop release / GitHub tagging

POS Desktop MSI releases are produced by `.github/workflows/pos-desktop-build.yml`, which
builds the Windows MSI and creates a **draft GitHub Release** when a tag matching
`pos-desktop-v*` is pushed to the GitHub repo (`saedazzam659-cloud/zacoderp-pos`).

## The Replit main agent CANNOT cut a release itself
- The sandbox blocks **all** git write operations for the main agent — commit, `git tag`,
  `git fetch`, anything writing under `.git/`. Error seen:
  "Destructive git operations are not allowed in the main agent."
- `git push` is *attempted* (not sandbox-blocked) but the GitHub creds stored in the repo's
  `origin` remote are a stale PAT → "Invalid username or token. Password authentication is not
  supported." No GitHub integration/connection is configured either (`listConnections('github')`
  → 401).

## So cutting a release is a USER-driven operation
1. Agent bumps the version in 3 files and lets the platform auto-commit:
   `artifacts/pos-desktop/package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`.
2. User pushes `main` to GitHub via the Replit **Git pane** (re-authorizing GitHub if prompted).
3. User creates + **publishes** a release on GitHub with the EXACT tag `pos-desktop-vX.Y.Z`
   targeting `main`. Publishing is what actually creates/pushes the tag — "Save draft" does
   NOT create the tag, so the workflow won't fire. The build workflow then attaches the MSI to
   that release.

**Why:** keeps GitHub push credentials with the user; the agent has no valid push path. The tag
must point at a commit that already contains both the version bump and whatever feature/fix the
release is meant to ship, so always push `main` BEFORE creating the tag.
