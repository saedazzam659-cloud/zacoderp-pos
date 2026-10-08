---
name: Expo source archive contract
description: Non-obvious archive layout requirement when submitting an authorized Android build through Expo's API.
---

Expo's uploaded source archive must wrap its contents in a top-level `project/` directory, with the application directory specified relative to that extracted project root.

**Why:** An otherwise valid monorepo archive without the wrapper failed during build hooks with an uninformative error, before compilation. Adding the wrapper allowed the same source and signing configuration to build.

**How to apply:** Check the archive layout before starting a remote build. Finalize and verify application changes before taking the archive snapshot; later workspace changes do not reach an already-submitted build.

For Launch's local uploader in this Replit workspace, `.gitignore` and `.easignore` did not exclude untracked archived AABs from its 500 MB scan. A temporary snapshot limited to the mobile app and its required shared API-client package reduced the project to a manageable size and reached the Expo-auth step. The root monorepo contains unrelated export and database archives, so do not submit the entire repository.

The local Launch CLI also rejected the injected `EXPO_TOKEN` robot identity for personal Expo login. Omitting `EXPO_TOKEN` from the login child process allowed Launch to start its browser OAuth flow; do not change or reveal the saved secret.

**Why:** This environment's local Launch packaging and auth behavior differs from a normal EAS upload: ignore files were not applied to the size scan, and the workspace robot identity was not the user's Expo account.

**How to apply:** Stage only the app and required workspace packages in a temporary snapshot, keep archived binaries and unrelated monorepo exports out, and run personal Launch login with `EXPO_TOKEN` omitted for that process only.

Do not use the stripped Launch bundle as an EAS CLI working directory. It omits the pnpm workspace root and lockfile, so local Expo config resolution fails before EAS can query or build the project. For EAS, package the workspace manifests and lockfile with the app and its required workspace dependencies, then install the filtered workspace dependencies before invoking EAS CLI.

**Why:** EAS resolves Expo config plugins locally, while the Launch handoff archive is intentionally optimized for Launch upload and is not a complete installable pnpm workspace. An app-only Expo upload without the root pnpm lockfile was detected as Yarn 1 and failed to resolve pnpm `catalog:` dependencies.

**How to apply:** Keep Launch and EAS source bundles distinct. For EAS work, include the workspace root metadata and required local packages; exclude secrets, node_modules, and unrelated monorepo source.

For an app already published to Play, confirm EAS's remote Android version code before a production build. If no remote value or local `android.versionCode` exists, EAS may initialize the sequence at 1; seed it from the last Play Console version before auto-incrementing.

**Why:** EAS remote versioning is independent of Play Console and cannot infer an existing store version when the app config omits it.

**How to apply:** Run the read-only remote version query first; if the value is behind the store, synchronize the remote value to the last published version before creating the next AAB.