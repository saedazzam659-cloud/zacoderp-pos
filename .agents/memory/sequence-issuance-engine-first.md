---
name: Sequence issuance must be engine-first
description: Numbered-doc create endpoints must consume the sequence engine first and ignore the form's peeked docNumber, or every doc gets the same number.
---

# Sequence issuance must be engine-first

Operational forms PEEK the next document number (مسلسل الحركات) purely to
display it, then send that same value back as `docNumber` on save. A create
endpoint must therefore treat the central engine as authoritative:

```
const fromSeq = await nextSequenceNumber/nextSequenceForPayment(cid, txType, {...});
resolvedDocNumber = fromSeq ?? ((docNumber && String(docNumber).trim()) || null);
```

- `nextSequenceNumber` RETURNS null when no sequence is configured (→ honour the
  manually-typed number / null), and THROWS `SequenceCapacityExceededError` only
  on real exhaustion. So wrap in try/catch that returns **400** on a thrown
  error — never a silent fallback to the client number (that re-bypasses the
  engine under failure).

**Why:** the buggy ordering was `resolved = (client docNumber) || null; if(!resolved) consume engine`. When a sequence WAS bound, the peeked client number won, the engine was never consumed, the counter never incremented, and every document was minted with the SAME number (e.g. PUCH-202600001 twice). Sales/JE were already engine-first; purchase_invoice/purchase_order/goods_receipt/goods_delivery were not.

**How to apply:** any NEW numbered create endpoint must use the `fromSeq ?? client` order and surface engine throws as 400. Do NOT trust the form's docNumber when a sequence is configured. A duplicate-number report number that matches the sequence "next number" preview is the signature of this bug (proves the type WAS bound; unbinding only yields empty numbers, not duplicates).
