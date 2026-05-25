---
name: Avoid openssl-sys vendored builds on Windows GitHub Actions
description: Why rusqlite's bundled-sqlcipher-vendored-openssl is a trap on windows-latest and what to use instead.
---

**Rule:** For Tauri/Rust apps targeting `x86_64-pc-windows-msvc` on GitHub Actions `windows-latest`, do NOT enable any Cargo feature that drags in `openssl-sys` vendored builds (e.g. rusqlite `bundled-sqlcipher-vendored-openssl`, native-tls vendored). Use `rustls-tls` for HTTP and plain `bundled` for rusqlite. If SQLCipher (DB encryption) is genuinely required, ship via a different route (precompiled SQLCipher DLL, or build off-CI).

**Why:** The Perl that ships preinstalled on `windows-latest` is Git-for-Windows' MSYS perl which is missing modules OpenSSL's `Configure` script needs (FindBin, File::Compare, etc.). It fails at "BEGIN failed--compilation aborted at ./Configure line 23" inside `openssl-sys` build.rs. Installing Strawberry Perl via choco and prepending it to GITHUB_PATH does NOT reliably fix it — openssl-sys's build script can still pick up the wrong perl, and even when it doesn't, the build adds ~5+ minutes and breaks unpredictably across runner image updates. We burned multiple build cycles + hours of user frustration chasing this before reverting to plain `bundled`.

**How to apply:** When adding a Rust crate to a Windows-CI-built app, search its feature flags for `vendored` / `vendored-openssl` and avoid. If a feature truly needs OpenSSL, prefer a system-installed OpenSSL via `vcpkg` over vendored, and call that out loudly in PR. Default to `rustls-tls` for `reqwest`.
