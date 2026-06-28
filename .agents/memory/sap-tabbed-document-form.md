---
name: SAP-style tabbed document form
description: Per-company tabbed vs classic layout for sales/purchase document entry forms; view-only details tab invariants.
---

# SAP-style 3-tab document entry form

Sales document entry forms (sales invoice, quotation, sales order — all share `SalesDocumentForm`) render in one of two layouts chosen per company via `companies.invoice_form_layout` (`"tabbed"` DEFAULT | `"classic"`). Tabs RTL: البيانات الأساسية | الأصناف (Save+Print at TOP) | التفاصيل.

**Rule — only PRESENTATION differs between layouts.** Every save/post/validation path is identical; `classic` must stay byte-for-byte the legacy single-page behavior. Gate purely on `useTabbedLayout`, never fork business logic.

**Rule — view-only opens force the tabbed shell.** `useTabbedLayout = _co?.invoiceFormLayout !== "classic" || viewMode`. Double-click a SalesAuditGrid row → navigates `?view=1`; the form reads it into `viewMode`, forces `activeTab="details"`, and sets `editLock = isPostedLock || viewMode`.
**Why:** classic-default companies otherwise get NO details tab on double-click, so the interactive التفاصيل surface would be unreachable. Forcing tabbed only affects the read-only view path, not classic editing.

**Rule — the التفاصيل (details) TabsContent must live OUTSIDE any `<fieldset disabled>`.** Read-only is applied with per-tab `<fieldset disabled={editLock}>` wrapping ONLY the basic-tab content and the items-tab LINES (not the top ActionBar). The details cards/modals stay clickable for posted invoices and in view mode precisely because they are not descendants of a disabled fieldset.
**Why:** a single outer disabled fieldset (the old approach) would freeze the details cards too.

**Rule — linked-operation cards open IN-SCREEN modals, never navigate away.** JE / receipt-voucher / sales-return / source-quotation each open a `Dialog`; the modal carries a secondary "فتح … كاملاً" button that navigates if the user wants the full screen. Lazy-fetch modal data with `enabled: !!id && openFlag`.

**How to apply:** when porting this pattern to `PurchaseOrderForm` (standalone, NOT shared with SalesDocumentForm), replicate all four rules. Per the approved rollout, sales invoice ships and gets sign-off FIRST, then generalize.
