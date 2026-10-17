---
name: Voice assistant rollout
description: User-confirmed scope and rollout order for voice-assisted business records across web and mobile.
---

The user wants the voice assistant to eventually cover every mobile screen, with spoken actions respecting the signed-in user's permissions. The first rollout targets sales invoices and quotations on web and mobile, plus cash deposits and expense entry on mobile. The user accepts a native microphone integration that requires an Android/iOS development build rather than Expo Go.

**Why:** A full-screen-by-screen rollout is broad; a shared command/field registry can be expanded without enabling untested actions everywhere at once.

**How to apply:** Keep existing document APIs and authorization as the source of truth, require review before financial saves/posts, and add user grants explicitly for mobile voice access.
