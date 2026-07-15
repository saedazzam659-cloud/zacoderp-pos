---
name: RTL TableHead logical alignment
description: shadcn table primitive header alignment fix for RTL apps
---
The shadcn `TableHead` base class ships `text-left`. In an RTL app this puts every header label on the opposite side of its column's cell values (cells default to `text-start` = right), which reads as "columns misaligned".

**Why:** user-reported misalignment of التاريخ/البيان headers in the invoice payments tabs traced to this single physical class in `components/ui/table.tsx`.

**How to apply:** use logical classes in table primitives (`text-start`; amounts `text-end` on both header AND cell). Date cells in RTL tables should be `dir="ltr" whitespace-nowrap` with the ISO date sliced to 10 chars. Long descriptions: wrap in a `block max-w-* truncate` span with `title` tooltip (truncate on the cell itself doesn't work without display control).
