---
name: Expo source archive contract
description: Non-obvious archive layout requirement when submitting an authorized Android build through Expo's API.
---

Expo's uploaded source archive must wrap its contents in a top-level `project/` directory, with the application directory specified relative to that extracted project root.

**Why:** An otherwise valid monorepo archive without the wrapper failed during build hooks with an uninformative error, before compilation. Adding the wrapper allowed the same source and signing configuration to build.

**How to apply:** Check the archive layout before starting a remote build. Finalize and verify application changes before taking the archive snapshot; later workspace changes do not reach an already-submitted build.