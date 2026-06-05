---
name: POS Desktop shared row-mapped struct field additions
description: Adding a field to a Rust struct that multiple SQLite query_map closures build requires updating EVERY reader; tsc cannot catch it.
---

# Shared row-mapped struct field additions (Rust)

When you add a field to a Rust struct that is built from `query_map`/`query_row`
closures in MORE THAN ONE place, you must update every construction site. Rust
struct literals require ALL fields, so a missed reader is a hard compile error —
but it compiles only in CI, so it slips past local `tsc`/architect inspection.

**Example:** `SalesLine` (accounting.rs) is row-mapped by BOTH `sales_invoice_get`
AND `sales_return_get`. Adding `free_qty`/`note`/`warehouse_id` to the struct
forced both closures to be updated (the return reader fills safe defaults
`free_qty: 0.0, note: None, warehouse_id: None` since the returns table has no
such columns).

**Why:** `#[serde(default)]` only helps deserialization from JS payloads; it does
NOT make Rust struct literals optional. A reader missing a new field won't
compile.

**How to apply:** after adding a field to any shared row struct, grep
`rg "<StructName> \{" src-tauri/src/` and patch every literal. Also recheck:
INSERT placeholder/param counts stay in lockstep, and extended SELECT column
order matches the `r.get(N)?` indices in the mapper.
