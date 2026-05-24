# pos-desktop — Windows POS (Tauri + React + SQLite)

**Status:** scaffold (Steps 1‑5 of Task #174 delivered). Steps 6‑12 (Tauri compile, ZATCA local signing, peripheral integration, auto‑updater, MSI signing) are **TODO**.

This is **NOT** a workspace artifact and is **not** registered in the monorepo. It
cannot be built or run from inside Replit (Linux) — it requires a Windows
toolchain (Rust 1.78+, MSVC, Tauri CLI, WiX 3) and ships separately as a
GitHub‑Actions artifact (`win-x64.msi`).

## Files in this scaffold

- `src-tauri/Cargo.toml`              — Rust manifest (Tauri 2.x + rusqlite + reqwest)
- `src-tauri/tauri.conf.json`         — bundle config (win‑x64 only, MSI installer)
- `src-tauri/src/main.rs`             — entry point + IPC commands
- `src-tauri/src/db.rs`               — SQLite (SQLCipher) bootstrap + migrations
- `src-tauri/src/sync.rs`             — heartbeat + pull + push against cloud API
- `src-tauri/src/license.rs`          — license activation + fingerprint hashing
- `src-tauri/src/zatca.rs`            — TLV QR (Phase 1) encoder/decoder + tests
- `src-tauri/src/peripherals.rs`      — ESC/POS thermal printer + cash drawer (spooler + serial)
- `src/lib/peripherals.ts`            — TS shim that forwards to Rust peripherals commands
- `src/main.tsx` / `src/App.tsx`      — Vite + React 18 (shadcn/ui) shell
- `src/pages/Activation.tsx`          — 6‑step activation wizard
- `src/pages/PosShell.tsx`            — main POS shell (re‑uses logic from `artifacts/pos`)
- `vite.config.ts`, `package.json`, `tsconfig.json`, `index.html`

## How activation works (current cloud contract)

1. SuperAdmin generates licenses on `/admin/pos-devices` (route already live).
2. Customer downloads installer from `/download` (route live, MSI URL configurable per country).
3. On first run, app collects 4 hardware identifiers (CPU, motherboard, MAC, Windows
   install id), hashes them with the license key, and POSTs to
   `/api/device-licenses/activate` → receives device JWT.
4. Device JWT is stored in Windows Credential Manager.
5. Every subsequent boot calls `/api/sync/heartbeat` (active‑proof) + delta pull/push.

## Cloud endpoints already implemented (Task #174 Steps 2‑3)

| Endpoint | Purpose |
|---|---|
| `POST /api/device-licenses/activate` | first‑time pairing (key + fingerprint → device JWT) |
| `POST /api/device-licenses/validate` | resume on boot (validates JWT, returns plan + expiry) |
| `POST /api/device-licenses/deactivate` | clean uninstall |
| `POST /api/sync/heartbeat` | every 60s while online |
| `GET  /api/sync/pull` | delta pull (customers, items, settings) |
| `POST /api/sync/push` | batched offline invoices/receipts |
| `GET  /api/sync/status` | dashboard data for the desktop app's status screen |
| `GET  /api/public/download/release?country=XX&platform=win-x64` | resolved MSI URL for `/download` page |

All endpoints are feature‑gated by `companies.enable_offline_pos` (default `false`).
Toggle per company from `/admin/pos-devices` → company licenses tab.

## Building the MSI

A GitHub Actions workflow at `.github/workflows/pos-desktop-build.yml` builds the
Windows MSI on a `windows-latest` runner. **This cannot be built from Replit** —
the sandbox is Linux and lacks the MSVC toolchain.

### Triggers

| Trigger | Effect |
|---|---|
| Push to `main` touching `artifacts/pos-desktop/**` | Build + upload MSI as artifact (30-day retention) |
| Pull request touching `artifacts/pos-desktop/**`   | Build-only validation (catches Rust/TS regressions) |
| Push tag `pos-desktop-v*` (e.g. `pos-desktop-v1.0.0`) | Build + create **draft** GitHub Release with MSI attached |
| Manual run from the Actions tab | Optional `sign=true` / `release=true` inputs |

### Code-signing (optional)

The workflow is **opt-in** for signing — it produces an unsigned build by default
(end users will see a SmartScreen warning until your IT distributes the cert via
GPO, but the MSI installs fine). To enable signing, add these repo secrets:

| Secret | Description |
|---|---|
| `WINDOWS_CERT_BASE64`     | Base64-encoded `.pfx` Code Signing certificate |
| `WINDOWS_CERT_PASSWORD`   | Password for the `.pfx` |
| `WINDOWS_CERT_THUMBPRINT` | SHA-1 thumbprint (no spaces, uppercase) |
| `TAURI_SIGNING_PRIVATE_KEY` | (auto-updater) Tauri ed25519 signing key |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | password for the above |

Once all 3 `WINDOWS_CERT_*` secrets exist, the next build auto-detects them and
switches to signed mode. The signed `.msi` is timestamp-stamped against DigiCert
so it stays trusted after the cert expires.

### Cutting a release

```bash
# 1) Bump version in artifacts/pos-desktop/package.json + src-tauri/tauri.conf.json + Cargo.toml
# 2) Commit, then tag:
git tag pos-desktop-v1.0.0
git push origin pos-desktop-v1.0.0
# 3) Wait ~15 min for the Windows runner. A DRAFT release appears at
#    Releases tab with the .msi attached. Review, then publish.
# 4) Copy the asset URL → SuperAdmin UI → POS Devices → Releases tab → paste
#    per country (or use ALL as the fallback).
```

### What still needs to be done (Steps 7-12 of Task #174)

1. ~~Add `pos-desktop` to GitHub Actions matrix (`windows-latest` runner).~~ ✅ done
2. Implement `src-tauri/src/zatca.rs` — local ZATCA signing.
   - ✅ **TLV QR (Phase 1, Annex B)** ported with 5 inline tests, byte-equivalent
     to `artifacts/api-server/src/lib/zatca-tlv.ts` (verified against Node).
     Exposed as `invoke("generate_qr", …)` and `invoke("decode_qr", …)`.
   - ⏳ XAdES signer (Phase 2 tags 6-9) — port from `zatca-xades-signer.ts`
   - ⏳ UBL 2.1 invoice XML — port from `zatca-xml.ts`
   - ⏳ CSR generator — port from `zatca-csr.ts`
3. Wire Activation wizard to cloud endpoints (already typed in `src/lib/api.ts`).
4. Implement printer/cash‑drawer/barcode‑scanner native bridges via Tauri plugins.
5. Set up code‑signing certificate (set the 3 secrets above) + auto‑updater
   via Tauri's built‑in mechanism (set the 2 `TAURI_SIGNING_*` secrets).
6. Publish first release → upload `.msi` → paste URL into `/admin/pos-devices` → Releases tab.
