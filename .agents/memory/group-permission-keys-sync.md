---
name: Separate company module gates from user permissions
description: Company menu toggles and granular user grants are different namespaces and must be evaluated independently
---

# Separate company module gates from user permissions

The company’s menu permissions are the tenant-wide upper bound. Per-user
permissions are a second, granular layer. Never intersect them by requiring the
same key to exist in both layers.

**Why:** Company toggles are coarse product keys while user grants are
screen-level keys. Mixing the namespaces can hide a valid user grant; allowing
a historical child key to stand in for the company toggle can also override an
explicit company-level disable.

**How to apply:** evaluate the canonical company toggle first, then evaluate
whether a regular user has view access to at least one granular screen in that
group. Company admins may bypass only the user layer. Keep the company and user
policy maps structurally aligned, and include every permission that can render
content in the group.
