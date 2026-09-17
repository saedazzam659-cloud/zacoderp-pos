---
name: OpenAPI generator compatibility
description: Constraints observed when generating clients from external OpenAPI path references.
---

Keep path items inline in the canonical OpenAPI document when using the current workspace generator.

**Why:** External path references failed the generator's bundling validation even after URI-encoding braces; the bundled references pointed at unresolved extension paths. Equivalent inline paths and component schemas generated successfully.

**How to apply:** Avoid splitting path items into external documents until the bundler is independently verified. When broad TypeScript checks are explicitly prohibited, invoke the generator itself rather than the package script that chains a workspace-wide library typecheck.

Do not enable automatic barrel generation for the Zod output without checking that every exported module is emitted.

**Why:** The installed generator added an export of a nonexistent schema module to the Zod barrel. Generation succeeded, but API startup failed during bundling.