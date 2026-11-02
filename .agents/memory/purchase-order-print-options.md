---
name: Purchase-order print options
description: Company-wide visibility settings and terms for the optional professional purchase-order print layout.
---

Keep the existing purchase-order list-summary print unchanged. Provide a separate detailed action per order and for selected orders; it must fetch the full order, including saved lines. The detailed print should show item notes, free quantity, and discounts, while header and line notes continue to follow the company `showNotes` setting.

**Why:** The user chose saved company settings so all staff print orders consistently, while preserving the familiar layout.

**How to apply:** Preserve the existing summary-print behavior and company settings. Treat missing legacy settings as defaults. Delivery address and receiver details are optional per-order fields; print them only when the company setting allows it, and keep purchase-order settings separate from invoice print preferences.

**Why:** Users need a clear one-order print action without changing what the list-level print button produces.

**How to apply:** Keep a dedicated detailed print control beside the summary flow; do not silently replace the summary report or alter existing company print preferences.
