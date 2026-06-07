---
name: ZATCA compliance-test invoice selection
description: Why the step-3 compliance test picks an invoice by internal DB id, shows draft+issued, and auto-issues a chosen draft
---

The ZATCA integration page step-3 "الفحص التجريبي" (compliance test) calls
`POST /api/companies/:id/compliance-check`, which resolves the invoice by its
**internal DB primary key** (`invoicesTable.id`), and requires the invoice to
already be ISSUED (server rejects when `xmlContent` is missing — drafts have
none).

**Rule:** never expose this as a free-typed field. Users type the *displayed*
invoice number (e.g. `INV-2026-26-785154` or `51-156`), which is NOT the DB id,
and a `type=number` input also silently strips letters/dashes — guaranteeing
"الفاتورة غير موجودة". Use a Select populated from `GET /api/invoices?companyId=X`
(no status filter), value = `String(invoice.id)`.

**Picker shows draft + issued (auto-issue on test):** the picker filters to
`status === "draft" || "issued"` (excludes cancelled). Most onboarding companies
have only ONE invoice and it's a *draft* — filtering to `status=issued` made the
picker empty and the user stuck (they didn't know they had to leave the page and
issue it first). Now, when a **draft** is selected and the test is run, the UI
first calls `POST /api/invoices/:id/issue` (generates UBL XML + QR, flips
draft→issued, consumes the invoice counter + hash chain) and THEN runs the
compliance check. Drafts are labelled in the dropdown and a blue note warns the
invoice will be auto-issued.

**Issue step must tolerate a 400:** `/issue` returns `400 "يمكن إصدار المسودات
فقط"` if the row is no longer a draft (issued by another tab / stale client
status). Treat 400 as success and fall through to the compliance check; only
404/500 abort. Invalidate the picker query in BOTH onSuccess and onError of the
check mutation (the invoice may have been issued before the check failed).

**Why:** the id↔number mismatch + issued-only precondition + the
draft-not-issued blocker are all invisible to the user; the picker + auto-issue
encode every constraint and remove the guesswork.

**How to apply:** any UI feeding an invoice into a by-id server endpoint should
pick from a fetched list (value = id, label = invoiceNumber), and distinguish
empty-states: `allInvoices.length===0` → "create an invoice first"; list non-empty
but no testable rows → "existing invoices are cancelled". `fetchJsonArray` returns
`[]` on any failure, so don't conflate a network error with "no invoices". Clear a
stale selection when the list changes.
