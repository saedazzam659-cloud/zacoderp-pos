---
name: Saved feature scope
description: The user's next requested invoice picker improvement and Mahmoud-only tax display rule.
---

## Invoice item multi-select

Add a checkbox beside each item in the invoice item picker. A user can select several items in one pass, and each selected item is added as its own invoice line using the existing invoice-line behavior and layout.

## Mahmoud agent tax display

For the agent represented by `https://main.tafrah.com.sa/`, show Saudi VAT on initial site load regardless of the visitor's country. Do not apply this rule to any other agent.

**Why:** The user asked to preserve these as the next work scope and explicitly limited the VAT behavior to Mahmoud's agent.

**How to apply:** Implement the invoice picker change without changing line semantics. Resolve the Mahmoud-specific site identity explicitly and test the Saudi VAT display from multiple country contexts, while confirming other agents remain unchanged.
