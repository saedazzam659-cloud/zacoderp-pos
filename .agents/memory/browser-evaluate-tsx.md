---
name: Browser evaluate under tsx
description: Name-preserving transpilation can break nested functions passed to Playwright evaluate.
---
When a tsx-executed script passes nested named functions into Playwright evaluate, transpilation can reference the Node-side `__name` helper that is absent in the browser.

**Why:** An authenticated visual fixture failed before its first fetch although login and navigation worked; the evaluated callback depended on that helper.

**How to apply:** Keep evaluated callbacks free of transpiler-only dependencies or install a test-only identity helper through addInitScript. Keep diagnostic output restricted to safe stages/statuses, never session values.