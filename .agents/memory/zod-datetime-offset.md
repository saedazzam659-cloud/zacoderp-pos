---
name: Zod datetime strict mode rejects +00:00
description: zod's `.string().datetime()` accepts ONLY `Z`-suffix; chrono `to_rfc3339()` emits `+00:00` — schema must opt in via `{offset:true}`.
---

Rule: any zod schema that validates a timestamp coming from a Rust caller using `chrono::DateTime::<Utc>::to_rfc3339()` MUST be declared as `z.string().datetime({ offset: true })`. The default (strict) mode rejects RFC3339 offsets like `+00:00` and accepts only the trailing `Z` form.

**Why:** chrono outputs offset notation (e.g. `2026-05-26T14:58:30+00:00`) — it never emits the `Z` shorthand even when the datetime is UTC. A strict zod check 400s the entire request silently from the Rust side (the server logs only "bad payload"), and the symptom on the desktop is a generic "push failed" toast with no actionable detail.

**How to apply:** when wiring any POST endpoint whose body originates from Rust/Tauri (sync, telemetry, audit, license-check), audit every `.datetime()` in the body schema. If the producer is chrono, use `{ offset: true }`. If the producer is JS (which emits `Z`), the strict default is fine. Verify in node: `z.string().datetime().safeParse('2026-05-26T14:58:30+00:00').success === false` vs `z.string().datetime({offset:true}).safeParse(...).success === true`.
