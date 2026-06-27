---
name: HR voucher print sources from list-row payload
description: Why a field visible on the HR custody/loan form can still be missing from the printed/PDF voucher.
---

# HR custody / loan voucher print sources from the LIST-row payload

The custody (`سند عهدة`) and loan/advance (`سند سلفة`) print + PDF vouchers are built
by self-contained builders (`custodyVoucherPrint.ts` / `loanVoucherPrint.ts`) from the
**list-row object** (`c` / `l`) passed through `custodyToVoucherDoc` / `loanToVoucherDoc`
— NOT from the employee record the form reads.

**Rule:** for a field to appear on the printed/PDF voucher it must be present in FOUR
places, in order: (1) the LIST endpoint's `select(...)` joins it off `employeesTable`,
(2) the `*VoucherDoc` interface declares it, (3) the builder's `dataRows` pushes it,
(4) the `*ToVoucherDoc` mapper copies it from the row.

**Why:** bank name + IBAN showed on-screen (form reads the employee record directly) but
were blank in print. Root cause: the loans LIST endpoint already selected
`empBankName`/`empBankIban`, but the **custody** LIST endpoint did not — the two
sibling endpoints had silently diverged. The voucher interfaces/builders/mappers also
never carried bank fields at all.

**How to apply:** when "X shows on the HR form but not on the printout", check the LIST
endpoint select first (custody and loan endpoints must stay in lockstep), then the
doc-interface → builder → mapper chain. PDF needs no separate change — `download*Pdf`
reuses the same `build*VoucherHtml`. Escape values with `esc(...)`; wrap IBAN in a
`dir="ltr"` span so it renders left-to-right inside the RTL sheet.
