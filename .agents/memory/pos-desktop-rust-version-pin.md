---
name: POS Desktop CI Rust version pinning trap
description: Why the pos-desktop MSI build's Rust toolchain must be pinned to a fixed version, and how to choose it.
---

# POS Desktop CI Rust version pin

The pos-desktop Tauri build has **no committed `Cargo.lock`** (only `Cargo.toml`).
CI resolves the Rust dependency tree to the newest versions on every build, which
creates a two-sided version trap for the `RUST_VERSION` env in
`.github/workflows/pos-desktop-build.yml`:

- **Floating `"stable"` (newer than the deps' MSRV)** → `cargo check` hits an
  E0119 coherence hard error *inside* the `time` crate (pulled via tauri-utils).
- **Too-old pin (e.g. 1.85.0)** → newest transitive deps (`serde_with`,
  `time`/`time-core`/`time-macros`) declare a higher `rust-version` and the
  MSRV check rejects the toolchain before compiling.

**Rule:** pin `RUST_VERSION` to a FIXED version equal to the MSRV that the
currently-floating deps demand (read it from the failing `cargo check` log lines
like `time@0.3.43 requires rustc 1.88.0`). That exact version is also the one the
`time` crate was built/tested against, so it compiles without the E0119 regression
that only appears on *later* stables. Keep `Cargo.toml` `rust-version` in lockstep.

**Why:** there is no local cargo (see pos-desktop-no-local-cargo) so neither tsc
nor the architect catch this — it only surfaces in CI. When the build breaks again
after a dep bump, the fix is almost always to re-read the required-rustc line from
the log and bump the pin to match, NOT to chase the `time` crate.

**How to apply:** the real long-term fix is to commit a `Cargo.lock` so the tree
stops floating; until then, treat `RUST_VERSION` as a moving target tied to the
newest deps' MSRV.
