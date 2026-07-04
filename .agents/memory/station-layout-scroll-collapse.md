---
name: Fixed-viewport station layout — scroll region collapse trap
description: Why a single-screen document form's scrolling item area can vanish entirely, and the layout recipe that prevents it
---

A single-screen "station" document form (pinned header cards on top, one
scrolling item area in the middle, sticky totals/actions at the bottom) is built
as a fixed-height flex column. The scrolling middle region is `flex-1 min-h-0`
with an inner `overflow-y-auto` child.

**Trap:** on a short viewport (small laptop, zoomed browser, short preview
window) the sum of the shrink-0 siblings (header row + the 3 header cards +
ZATCA/invoice-type picker + bottom bar) meets or exceeds the container height, so
the `flex-1 min-h-0` middle region resolves to **0px and disappears completely** —
the whole item grid (and its tabs) is gone, not just small. If the outer
container is `height: <fixed>` + `overflow-hidden`, the clip also hides the
bottom action bar. Users report "where do I even enter items?".

**Recipe that prevents it:**
- Outer container: `style={{ minHeight: shellHeight }}` (a floor, NOT a fixed
  `height`) and NO `overflow-hidden`. On tall screens flex-1 fills to the floor;
  on short screens the whole page grows and scrolls instead of clipping.
- The scrolling item card: give it a real floor, e.g. `min-h-[320px] flex-1`
  (not `min-h-0`), so it can never collapse below a usable height. Its inner
  `CardContent` keeps `min-h-0 flex-1 overflow-y-auto` to scroll internally.
- Bottom totals/actions bar: `sticky bottom-0 z-10 bg-background` so it stays
  visible even when the page has to scroll on a short screen.

**Why:** `flex-1 min-h-0` means "take remaining space, may shrink to zero" — on a
cramped column there IS no remaining space, so it shrinks to nothing. A
min-height floor + a growing (min-height, not fixed) outer container trades the
strict "page never scrolls" ideal for the guarantee that the primary input area
is always visible. Functionality wins over strict no-scroll on tiny screens.
