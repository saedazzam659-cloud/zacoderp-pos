---
name: Voucher multi-line print (popup-safe async)
description: How the cash voucher (سند قبض/صرف) print renders multi-allocation lines and stays popup-blocker-safe when it must fetch lines.
---

Receipt/payment vouchers are treasury-anchored MULTI-ALLOCATION docs (one cash/bank side + many lines). The printed voucher (`lib/cashVoucherPrint.ts`) must render EVERY allocation line, not a single counter-account.

**Rule:** `buildCashVoucherHtml` renders one table row per `lines[]` entry (المبلغ = net, الإجمالي = net + per-line tax; payments carry VAT, receipts none) and foots Σnet / Σtotal. When `lines` is absent it falls back to the legacy single-account row — never remove that fallback (old vouchers + fetch failures rely on it).

**Popup-safety (the non-obvious part):** the voucher LIST GET returns headers ONLY (no lines); GET `/:id` returns `{...row, lines}`. So list-print must fetch lines async, but `window.open` after an `await` gets blocked. Pattern = two phase: `openCashVoucherWindow()` opens a blank placeholder window SYNCHRONOUSLY inside the click handler, THEN `await` the fetch, THEN `writeCashVoucher(win, args)`. The forms already hold `existing.lines` synchronously, so they can call `printCashVoucher` directly.

**Why:** browsers block `window.open` that isn't in the synchronous call stack of a user gesture; opening first + writing later is the only reliable way to print data that must be fetched.

**How to apply:** any list-row print of a doc whose lines aren't in the list payload → open window sync, fetch, write. Reuse `openCashVoucherWindow`/`writeCashVoucher`.
