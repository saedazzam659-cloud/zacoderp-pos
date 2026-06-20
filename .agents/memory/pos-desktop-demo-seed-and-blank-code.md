---
name: POS Desktop demo seeding + blank-code save
description: Why demo items must seed once (not "when empty"), and why blank code/barcode must normalize to NULL before insert/update.
---

# Demo seeding must be once-per-install, not "seed when empty"

Seeding the demo catalog whenever `items_local` is empty resurrects the demos
right after the operator deliberately deletes them all (the empty table is
exactly the delete-all state, and seeding runs on every Sales/Register screen
mount).

**Rule:** Gate first-run seeding behind a persistent `app_settings` flag
(`demo_seeded`), claimed inside the same `BEGIN IMMEDIATE` tx that does the
COUNT check. Set the flag up-front regardless of branch: empty table → seed
then flag; non-empty (upgrade) → flag only, never touch the operator's rows.

**Why:** An "empty → seed" heuristic cannot tell "fresh install" from "user
wiped the catalog." Only a persisted flag survives the delete-all.

**How to apply:** Any one-time seed/bootstrap on a table the user can empty
must use a persisted done-flag, not a row-count test.

# Blank code/barcode must normalize to NULL before write

`items_local` has a partial unique index `uniq_items_local_code ON code WHERE
code IS NOT NULL`. An empty string `""` is NOT NULL, so it is indexed and
collidable — the SECOND item saved with a blank code field (the common case)
hits `UNIQUE constraint failed`. Because the Tauri command rejects with a bare
String (no `.message`), the form's `e?.message ?? "..."` shows only the generic
"فشل الحفظ".

**Rule:** Trim and treat empty as NULL (`norm_opt`) at the authoritative Rust
write boundary (`insert_local_item` + `update_local_item`); mirror in TS
`createItem`/`updateItem` to keep the cloud/LS path + push payload consistent.

**Why:** A partial-unique index `WHERE col IS NOT NULL` only excludes true
NULLs; `""` defeats it. Normalizing at the choke point fixes every caller.

**How to apply:** Any column under a `WHERE col IS NOT NULL` partial unique
index must store NULL (never `""`) for "no value", or blanks collide.

# Never collapse a Tauri reject into a generic message

Tauri commands reject with a bare **String** (the Rust `Err(String)`), which has
no `.message`. A form catch like `setErr(e?.message ?? "فشل الحفظ")` therefore
throws away the real cause and always shows the generic fallback — this masked
the standalone item-save failure for multiple debugging rounds.

**Rule:** (1) In the catch, handle string rejects: `typeof e === "string" ? e :
(e?.message ?? fallback)`. (2) At the Rust write boundary map KNOWN constraints
(`uniq_items_local_code`, `items_local_plu_unique`) to clear Arabic, and pass any
OTHER error through verbatim (e.g. `format!("…: {raw}")`) — never swallow it.

**Why:** A generic UI message turns a 5-second "duplicate code"/"no such column"
diagnosis into a multi-round guessing game; the raw SQLite text is the fastest
route to the real fix, especially since Rust only compiles in CI (no local repro).

**How to apply:** Every Tauri-backed save/catch pair must surface string rejects;
shared write errors should go through one `map_item_write_err`-style mapper so all
callers (insert/update/weighed) stay consistent.
