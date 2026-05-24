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

## Next steps (when picked up)

1. Add `pos-desktop` to GitHub Actions matrix (`windows-latest` runner).
2. Implement `src-tauri/src/zatca.rs` — local ZATCA Phase 2 UBL 2.1 signing
   (port logic from `artifacts/api-server/src/lib/zatca`).
3. Wire Activation wizard to cloud endpoints (already typed in `src/lib/api.ts`).
4. Implement printer/cash‑drawer/barcode‑scanner native bridges via Tauri plugins.
5. Set up code‑signing certificate + auto‑updater via Tauri's built‑in mechanism.
6. Publish first release → upload .msi → paste URL into `/admin/pos-devices` → Releases tab.
