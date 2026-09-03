---
name: SuperAdmin journal sequence repair
description: Safety rules for manually correcting a bad existing JE number while preserving one company-wide sequence.
---

The SuperAdmin correction operation may change one existing bad journal number only to the numeric suffix immediately after the company-wide actual high-water. It must not bulk-renumber historical rows or change prefix/month configuration.

**Why:** Restored agent databases can retain a valid journal history while counters are stale. A correction such as `0001 → 2577` must make the next document use `2578`, but allocation and JE insertion are separate transactions, so row-only duplicate checks can race an in-flight document.

**How to apply:** Every future JE allocator, including administrative gap-fill paths, must claim `(company, rendered JE number)` in the permanent unique claim registry before insertion. Sequence high-water includes claims, and correction must use the same registry and fail on an already claimed number.