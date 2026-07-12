---
name: Child account code follows dominant sibling scheme
description: Auto-minted sub-account codes must continue the existing siblings' numbering pattern, and any "next code" preview must reuse the exact creation path.
---

**Rule:** When minting a new child account code under a parent, do NOT probe `parentCode + n` from n=1. Detect the DOMINANT scheme among existing numeric siblings (most-common suffix width; ties → wider), take max+1 zero-padded to that width, and skip collisions. Fallbacks: legacy unpadded concat when no numeric siblings, dashed `PARENT-001` for non-numeric parents.

**Why:** Prod suppliers under 21011 were padded `2101101..2101116`; naive probing minted off-pattern `210111`, breaking the visual/sortable COA sequence users rely on.

**How to apply:** Shared pure `computeNextChildCode` in the entity-accounts helper is the single source of truth. Any UI "next code" hint endpoint must call the SAME parent-resolution + code-generation functions as the creation path (never reimplement) or the preview diverges from what save actually mints.
