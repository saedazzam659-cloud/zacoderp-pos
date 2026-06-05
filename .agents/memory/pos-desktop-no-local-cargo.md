---
name: POS Desktop Rust compiles only in CI
description: pos-desktop Rust (src-tauri) is never built locally; compile errors surface only in GitHub Actions on tag push — review Rust by hand before tagging.
---

The POS Desktop Tauri backend (`artifacts/pos-desktop/src-tauri/`) is NOT built in the Replit environment — there is no cargo toolchain and `tauri build` runs only in `.github/workflows/pos-desktop-build.yml` on Windows. `tsc --noEmit` and architect review do NOT catch Rust compile errors.

**Why:** a release tag once shipped with a Rust E0428 ("defined multiple times") — a second `fn default_true() -> bool { true }` was added in `accounting.rs` while an identical module-level helper already existed near the top. tsc passed, architect approved, the tag built, and CI failed at the `Cargo check (Rust)` step. The whole MSI build aborts on the first cargo error, so any later Rust errors stay hidden until the first is fixed and re-tagged.

**How to apply:** before pushing a `pos-desktop-v*` tag, hand-review new Rust for the classics cargo would catch:
- duplicate module-level helpers (serde `default = "..."` fns like `default_true`, `default_credit`) — grep `fn <name>` per file and check for >1 in the same module.
- unused imports (CI `cargo check` errors, and clippy `-D warnings`).
- column/param count drift between the CREATE TABLE, the `*_COLS` const, `row_to_tax`-style mappers, and INSERT/UPDATE `params![]`.
- **second call site drift**: most commands have TWO Rust call sites — the Tauri `generate_handler!` in `main.rs` (auto-binds JS args, so adding a param needs no edit there) AND the manual string-match dispatcher in `lan.rs` (LAN shared-DB mode), which passes args positionally via `s_opt`/`i_opt`/`f_opt`/`b_opt`. Adding/removing a param on a command in `customers.rs`/`accounting.rs`/etc. that also has a `lan.rs` arm → CI E0061 "takes N args but M supplied" unless the `lan.rs` arm is updated too. Struct args (e.g. `Option<CustomerProfile>`) are passed in `lan.rs` via `args.get("profile").and_then(|v| serde_json::from_value(v.clone()).ok())`, NOT a typed helper. After ANY command-signature change, grep `lan.rs` for that command name.
Bump the version (package.json + tauri.conf.json + Cargo.toml in lockstep) and re-tag rather than reusing a consumed tag.
