---
name: POS Desktop TypeScript tests
description: A lightweight way to run focused TypeScript node:test files without adding a runtime test dependency.
---

Use Node's native TypeScript stripping to run focused `node:test` files for POS Desktop, with explicit `.ts` extensions on ESM imports. The desktop package does not provide `tsx` to `pnpm exec`.

**Why:** The workspace's POS Desktop package can type-check and build successfully, but invoking `tsx` from its package context failed because it is not an installed package dependency.

**How to apply:** For a focused TypeScript test file, use `node --experimental-strip-types --test <path>` on the current Node 24 environment; use `.ts` extensions for imported TypeScript modules. Keep the normal app `typecheck` and `build` as separate validation.
