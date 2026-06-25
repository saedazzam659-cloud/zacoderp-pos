---
name: Parallel commission accrual helpers
description: There are THREE distinct commission accrual paths — pick the right one, never add a 4th duplicate.
---

# Three parallel commission accrual helpers

The codebase has THREE separate commission accrual functions with overlapping
names but DIFFERENT semantics. Wiring the wrong one (or adding a 4th) silently
mis-credits or double-credits commissions.

- `accrueResellerCommission` (lib/resellerCommissions.ts) — reseller network,
  **1:1** company→reseller, uses subscriptionId.
- `accruePartnerCommission` (lib/partnerCommissions.ts) — developer/partner
  platform, **1:many** (a company may link to several approved partners),
  accrues one row per linked partner, uses each partner's own rate, keys on
  extensionId (no subscriptionId column on the partner schema). Wired at the
  SAME 5 call sites as the reseller helper (reseller.ts add-client/renew;
  admin.ts extend/change-plan/bulk-extend).
- `accrueMarketplaceCommission` (lib/partnerCommissions.ts) — marketplace app
  purchase, **partner-direct** (explicit partnerId + precomputed commission
  snapshot via `computeCommission`). Called only from routes/marketplace.ts.

**Why:** during the extension-platform build, two isolated task agents each
authored an `accruePartnerCommission`; the marketplace variant was a different
design (partner-direct snapshot) and collided on rebase. Resolved by RENAMING
the marketplace one to `accrueMarketplaceCommission` and keeping main's
company-link helper unchanged — both coexist, no behavior change.

**How to apply:** before adding any commission logic, decide which axis you are
on (subscription/reseller vs. partner-link vs. marketplace-purchase) and reuse
the matching helper. Do NOT create a new accrue* function for a case one of
these already covers.
