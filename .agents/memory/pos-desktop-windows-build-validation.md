---
name: POS Desktop Windows build validation
description: Validation boundary for Tauri updater and Windows MSI lifecycle changes.
---

Do not treat a browser preview, TypeScript check, or Linux Cargo check as proof that POS Desktop updates work on Windows. Changes to the native updater require the repository's pinned Windows Actions build and a Windows MSI upgrade smoke test before a release is considered verified.

**Why:** The installer lifecycle, elevation, file replacement, and app relaunch are Windows-only behavior; the desktop workflow also pins a Rust toolchain and Cargo MSRV resolution that may differ from the local Replit environment.

**How to apply:** For changes under the POS Desktop Tauri updater, first verify the tagged Windows build and its online MSI, then test upgrading an existing installation and confirm the installed version and local data after automatic relaunch.

Do not treat a Windows MSI build request as authorization to publish a release. For build-only validation, use an isolated candidate branch based on the latest released source, include only the requested POS Desktop changes, and run the workflow with `release=false`. Do not push a potentially divergent Replit workspace branch directly to `main`.

**Why:** The user expects a Windows installer artifact, not a published app or GitHub Release. Replit's local branch can contain unrelated commits absent from GitHub, and the MSI workflow creates a draft release for tags or when explicitly requested.

**How to apply:** Check the latest release and local/GitHub divergence first. Build from a temporary branch at the chosen release, bump the candidate version there, and dispatch the artifact-only workflow. Create no tag or Release unless the user explicitly asks.
