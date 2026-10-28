---
name: POS Desktop Windows build validation
description: Validation boundary for Tauri updater and Windows MSI lifecycle changes.
---

Do not treat a browser preview, TypeScript check, or Linux Cargo check as proof that POS Desktop updates work on Windows. Changes to the native updater require the repository's pinned Windows Actions build and a Windows MSI upgrade smoke test before a release is considered verified.

**Why:** The installer lifecycle, elevation, file replacement, and app relaunch are Windows-only behavior; the desktop workflow also pins a Rust toolchain and Cargo MSRV resolution that may differ from the local Replit environment.

**How to apply:** For changes under the POS Desktop Tauri updater, first verify the tagged Windows build and its online MSI, then test upgrading an existing installation and confirm the installed version and local data after automatic relaunch.
