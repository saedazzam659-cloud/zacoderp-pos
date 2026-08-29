---
name: Document archive draft keys, source links, and voucher journal split
description: JournalScanArchive draft-key lifecycle, source-document attachment reuse, and the canonical voucher isMulti discriminator
---

## Archive draft key
- `JournalScanArchive` loads cloud files (`/api/document-archives?screenKey=&docKey=`) and the local LS index (`zacode-archive-index`) purely by `jeKey`, and AUTO-OPENS when files exist.
- A constant new-mode key makes every new form show the previous document's attachments. Every create-mode form needs a unique draft key; a form that stays mounted after save must also rotate that key before the next draft.
- **Rekey on first save is mandatory**: files archived while the form is a draft would otherwise be unreachable from edit mode (edit uses `existing.code`). On create success: `renameArchivedKey(draftKey, data.code)` (lib/localArchive) + `PATCH /api/document-archives/rekey {screenKey, oldDocKey, newDocKey}` (company-scoped, userAllowed-gated).
- **How to apply:** any screen that embeds JournalScanArchive with a new/edit mode needs the same trio (unique draft key, local rename, cloud rekey).

## Source-document attachments on generated journal entries
- A generated journal entry must show the archive rows of its source document by reference; never copy the object or insert a second archive row.
- Resolve the source from the authoritative reverse `journal_entry_id` relationship, tenant/branch scope the journal lookup, then apply the source screen's archive ACL and mode before listing.
- **Why:** copying doubles backup size and allows the invoice and journal copies to drift or be deleted independently.
- **How to apply:** new archived operations that generate JEs must extend the source resolver with their canonical screen key and saved document key.

## Simple vs multi voucher journals
- `accountId == null` is NOT a valid multi discriminator — simple *party-mode* vouchers also store null. Canonical `isMulti` = allocation-line existence, computed in BOTH list endpoints (payment + receipt) and consumed exclusively (`v.isMulti === true`).
- Lists: `PaymentVouchers`/`ReceiptVouchers` take `variant="simple"|"multi"` (named exports `*VouchersMulti` routed at `/cash/*-vouchers/multi`); scope rows BEFORE search/stats; formBase drives add/edit/copy routes.
- Multi forms must navigate back/after-save to the `/multi` list, and all four forms' prev/next `navList` must filter by their own kind.
