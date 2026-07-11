---
name: Fixed-assets day-based depreciation
description: How straight-line depreciation is computed (day-based pro-rata) and the single-source-of-truth calc module shared by preview/posting/schedule.
---

# Fixed-assets day-based depreciation

`artifacts/api-server/src/lib/depreciationCalc.ts` is the SINGLE source of truth
for how much a fixed asset depreciates in a given month. Preview, posting, and
the schedule/timeline endpoint ALL go through it — never re-implement the math
inline in a route or the posting loop, or the three surfaces drift.

## Method

- **straight_line = DAY-BASED (pro-rata)**: `dailyRate = (purchase - scrap) / totalLifeDays`;
  a month charges `dailyRate × (days of that month inside the asset life)`. First
  and last months are partial. `effStart = depreciationStart || purchaseDate`.
- **declining_balance = legacy monthly** `book × (2/lifeYears) / 12` — NOT day-based.

## Gotcha: buildSchedule must roll the book for declining_balance

`computePeriodDepreciation` reads `accumulatedDepreciation` from its input. For a
full-life schedule, `buildSchedule` must feed a ROLLING accum back in per month
(`startAccum + cumulative`) for declining_balance, or every month shows the same
charge (no decay). Straight-line ignores accum, so passing it is harmless there.

**Why:** first review pass shipped a schedule that diverged from preview/posting
for declining-balance assets because accum was static across the loop.

## Audit stamping (JE creator/poster)

`postDepreciationForCompany(cid, m, y, username, { userId })` threads the acting
user id into `buildDepreciationRunJournal(..., { userId })`, which stamps
`createdBy` always and `postedBy/postedAt` ONLY when `resolvePostingStatus`
returns `posted` (auto-post ON). Mirrors `fullAuditFor`. JournalEntries.tsx
already renders أنشأه/رحّله from these columns — no frontend change needed.

## Scheduler end-of-month clamp

`shouldRunForCompany` clamps the configured auto-post day 1..31 and, if it exceeds
the current month length (e.g. 30 in Feb), fires on the LAST day instead of never.
UI day dropdown is 1..30.

## Schedule endpoint

`POST /api/fixed-assets/depreciation/schedule` — `{ assetId }` → real schedule +
`posted` flags overlaid from `fa_depreciation_runs` (same company+asset filter);
raw params → projection (no posted overlay). Reusable UI:
`DepreciationScheduleTimeline.tsx` (assetId mode on the depreciation page,
`projection` mode inside the asset form's depreciation tab).
