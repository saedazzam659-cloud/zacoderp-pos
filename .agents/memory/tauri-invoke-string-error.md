---
name: Tauri invoke rejects with a raw string
description: Why standalone-mode forms show a generic fallback error instead of the real Rust message
---

A Tauri `#[tauri::command]` that returns `Err(String)` makes the JS `invoke()`
promise reject with the **raw string**, NOT an `Error` object. So a catch of the
form `setErr(e?.message ?? "فشل")` always falls to the generic fallback — `e` is a
string, `e.message` is `undefined` — and the real (usually clear Arabic) cause is
swallowed.

**Why:** this masks the actual standalone failure. Purchase/return/sale saves that
post a JE can legitimately `Err` with "الحساب 1300 غير موجود", a closed-period
message, or a missing payment account — but the user only ever sees "فشل", which
looks like a mystery bug and invites risky guess-fixes to the Rust posting logic.

**How to apply:** prefer the shared `errText(e, fallback)` helper exported from
`pages/_adminUi.tsx` (string-first, then `.message`, then fallback) in every form
catch that surfaces a Tauri command error; the inline `typeof e === "string" ? e :
(e?.message ?? "<fallback>")` is equivalent. When diagnosing a generic "فشل" save
failure, first make the error visible — do NOT assume a cause. Known still-swallowing
catch sites worth migrating: `SupplierSettlementAdmin`, `PurchasesAdmin`,
`SalesInvoicesAdmin`, `JournalEntries`. `PostingCenter` post/unpost already uses it.
