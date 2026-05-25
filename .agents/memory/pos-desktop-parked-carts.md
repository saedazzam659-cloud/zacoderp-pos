---
name: POS Desktop parked carts
description: Parked-cart rows are device-only scratchpad scoped to pos_session_id; never push to cloud.
---

"Parked carts" (السلال المعلّقة) are in-progress sales the cashier set aside. They are **device-only scratchpad** — never pushed to the cloud. The cloud is the source of truth for FINALIZED invoices only.

**Key rules:**
- Every row carries `pos_session_id`. Listing, deleting, and clearing are all scoped by it so a cashier handoff (logout) cannot leak the previous cashier's carts. `clearSessionParkedCarts(sid)` runs on every logout / deactivate.
- Resume handoff between `ParkedCarts.tsx` (list page) and `SalesScreen.tsx` (editor) goes through `sessionStorage` key `pos_desktop_resume_parked_cart_id` via `setResumeCartId`/`takeResumeCartId`. SalesScreen consumes (deletes) the key on mount so a hard refresh during handoff doesn't silently re-resume.
- On successful checkout, the resumed parked row is auto-deleted (`activeParkedId` cleared). Park-again on a resumed cart upserts the SAME row id.
- Storage: Tauri SQLite (`parked_carts` table) preferred; browser/dev OR any Tauri error falls back to `localStorage[pos_desktop_parked_carts_v1]`. `lib/parkedCarts.ts` is the only API surface.

Do NOT confuse "السلال المعلّقة" (parked carts, this feature) with "الفواتير غير المرفوعة" (offline invoices waiting for sync push — `PendingInvoices.tsx`). They are two completely different concepts and live in two different tables.
