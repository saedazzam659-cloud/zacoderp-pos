---
name: Voucher archive draft key + simple/multi journal split
description: JournalScanArchive draft-key collision fix and the canonical isMulti discriminator for voucher journals
---

## Archive draft key
- `JournalScanArchive` loads cloud files (`/api/document-archives?screenKey=&docKey=`) and the local LS index (`zacode-archive-index`) purely by `jeKey`, and AUTO-OPENS when files exist.
- A constant new-mode key ("PV-new-draft") makes every new form show the previous voucher's attachments. Fix: per-mount unique key via `newDraftKeyRef = useRef(\`PV-new-<ts>-<rand>\`)`.
- **Rekey on first save is mandatory**: files archived while the form is a draft would otherwise be unreachable from edit mode (edit uses `existing.code`). On create success: `renameArchivedKey(draftKey, data.code)` (lib/localArchive) + `PATCH /api/document-archives/rekey {screenKey, oldDocKey, newDocKey}` (company-scoped, userAllowed-gated).
- **How to apply:** any screen that embeds JournalScanArchive with a new/edit mode needs the same trio (unique draft key, local rename, cloud rekey).

## Simple vs multi voucher journals
- `accountId == null` is NOT a valid multi discriminator — simple *party-mode* vouchers also store null. Canonical `isMulti` = allocation-line existence, computed in BOTH list endpoints (payment + receipt) and consumed exclusively (`v.isMulti === true`).
- Lists: `PaymentVouchers`/`ReceiptVouchers` take `variant="simple"|"multi"` (named exports `*VouchersMulti` routed at `/cash/*-vouchers/multi`); scope rows BEFORE search/stats; formBase drives add/edit/copy routes.
- Multi forms must navigate back/after-save to the `/multi` list, and all four forms' prev/next `navList` must filter by their own kind.
