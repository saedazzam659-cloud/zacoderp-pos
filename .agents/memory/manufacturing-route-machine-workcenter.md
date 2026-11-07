---
name: Route machine work-center boundary
description: How route-selected production machines interact with stage work centers.
---

A production machine with no explicit work-center assignment remains eligible for a route stage that selects a work center. A machine explicitly assigned to a different center is incompatible. Choosing a machine must not erase the stage's selected center when the machine itself has no center.

**Why:** Smart Manufacturing routes store a stage's work center separately from its machine, and route-created machine resources may not have a global work-center link. Treating a missing link as a conflict hid the routed machine from execution and blocked stage completion.

**How to apply:** Keep unassigned machines visible in stage pickers and allow them through server validation when a stage has a work center. Enforce the mismatch only when the machine has a non-null, different work-center assignment.
