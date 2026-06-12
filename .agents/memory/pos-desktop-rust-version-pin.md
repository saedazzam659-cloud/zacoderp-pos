---
name: POS Desktop CI Rust toolchain + resolver pinning
description: Why the pos-desktop MSI build must pin an OLD Rust toolchain AND enable Cargo's MSRV-aware resolver, instead of chasing toolchain versions.
---

# POS Desktop CI Rust pin

The pos-desktop Tauri build has **no committed `Cargo.lock`** (only `Cargo.toml`),
so CI resolves the dependency tree to the newest versions on every build. That
creates a two-sided trap for `RUST_VERSION` in
`.github/workflows/pos-desktop-build.yml`:

- **Floating `"stable"` / any toolchain newer than the deps' MSRV** → `cargo
  check` hits an E0119 coherence hard error *inside* the `time` crate (pulled via
  tauri-utils). Newer stable Rust adds std impls that conflict with `time`.
- **Pinning a too-old toolchain** → the newest floating deps (`serde_with`,
  `time`/`time-core`/`time-macros`) declare a higher `rust-version` (e.g. 1.88)
  and the MSRV check rejects the toolchain before compiling.

Chasing the toolchain version alone is a **losing game** — every dep bump moves
the required floor and re-breaks the build (this burned several CI cycles).

**The real fix (do this, don't version-chase):**
1. Pin `RUST_VERSION` to a fixed OLD toolchain (1.85.0 — the edition2024 floor).
2. Set `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS: "fallback"` in the job `env`
   (requires cargo >= 1.84).
3. Keep `Cargo.toml` `rust-version` = "1.85" in lockstep (the resolver uses this
   field as the floor).

Then Cargo's MSRV-aware resolver **downgrades any dep whose MSRV exceeds 1.85** to
the newest version that still supports 1.85, so the tree can never drift onto a
Rust it can't compile, and the old toolchain never triggers the `time` E0119.

**Why:** there is no local cargo/rustc available (the Replit `rust-stable` module
install did NOT register in `.replit` modules; `which cargo` stays empty), so
neither tsc nor the architect catch Rust resolution/compile errors — they only
surface in CI. The resolver flag makes the build self-correcting against dep drift.

**How to apply:** the true long-term fix is to commit a `Cargo.lock` so the tree
stops floating entirely. Until then, the toolchain pin + `fallback` resolver is
the stable combination — do not switch back to floating `"stable"`.
