---
name: Additional accounting reports boundary
description: The additive report catalog, explicit activation requirements, and evidence limits for journal audit.
---

Only reports without an existing functionally equivalent screen belong in the unified additional-accounting-reports selector. Existing report screens, routes, APIs, and permission behavior remain in place.

**Why:** The user explicitly required a single new surface without moving, merging, or rebuilding reports already in use.

**How to apply:** Before adding a report, check for an equivalent existing report. For genuinely new reports, keep the company-level module switch and each individual report switch independently default-off; enforce the same gates in the UI and API.

Journal audit output must reflect only fields the audit store actually records. If the source has no branch attribution or complete before/after snapshots, do not infer either; fail closed for users whose branch scope cannot be represented.

**Why:** Showing unscoped audit rows can leak data across branch authorization boundaries, and unsupported before/after claims misrepresent the evidence.

**How to apply:** Recheck the audit store's available fields before expanding the report, and return an explicit limitation instead of inventing missing provenance.