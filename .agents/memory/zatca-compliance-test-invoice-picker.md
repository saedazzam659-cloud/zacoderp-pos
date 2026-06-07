---
name: ZATCA compliance-test invoice selection
description: Why the step-3 compliance test must pick an issued invoice by internal DB id, not a typed number
---

The ZATCA integration page step-3 "الفحص التجريبي" (compliance test) calls
`POST /api/companies/:id/compliance-check`, which resolves the invoice by its
**internal DB primary key** (`invoicesTable.id`), and also requires the invoice
to already be ISSUED (server rejects with "يجب إصدار الفاتورة أولاً" when
`xmlContent` is missing — drafts have none).

**Rule:** never expose this as a free-typed field. Users type the *displayed*
invoice number (e.g. `INV-2026-26-785154` or `51-156`), which is NOT the DB id,
and a `type=number` input also silently strips the letters/dashes — guaranteeing
"الفاتورة غير موجودة". Use a Select populated from
`GET /api/invoices?companyId=X&status=issued`, value = `String(invoice.id)`.

**Why:** the id↔number mismatch plus issued-only precondition are invisible to
the user; a picker encodes both constraints and removes the guesswork.

**How to apply:** any UI that feeds an invoice into a by-id server endpoint
should pick from a fetched list (value = id, label = invoiceNumber), filter to
the statuses the endpoint accepts, and show a distinct empty-state vs loading
state (fetchJsonArray returns `[]` on any failure, so don't conflate a network
error with "no invoices"). Clear a stale selection when the list changes.
