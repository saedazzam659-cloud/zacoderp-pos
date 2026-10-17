---
name: Voice assistant rollout
description: User-confirmed scope and rollout order for voice-assisted business records across web and mobile.
---

The user wants the voice assistant to eventually cover every mobile screen, with spoken actions respecting the signed-in user's permissions. The first rollout targets sales invoices and quotations on web and mobile, plus cash deposits and expense entry on mobile. The user accepts a native microphone integration that requires an Android/iOS development build rather than Expo Go.

The user also wants Egyptian and Gulf Arabic recognition options and a microphone button that can be moved and remembers its position on both web and mobile.

The user does not want voice-work messages or learning prompts shown to users. Learn silently and automatically only from commands whose supported action reports success; scope learned examples to the same user and company.

The initial form-filling slice covers customer, item, quantity, and optional unit price for sales invoices and quotations on web and mobile. The user also wants voice entry for existing invoice dates, header notes, line notes where present, and existing payment types. Do not add a per-line date field unless its meaning is defined. Explicit “احفظ الفاتورة” and “احفظ عرض السعر” commands follow review; invoice saving follows company auto-post settings and user permissions, while quotations do not post. Never save automatically when dictation ends.

For mobile cash expenses and deposits, the user chose explicit voice commands for all existing actions, gated by the same permissions as the UI. Spoken save, submit, approve, reject, post, or cancel must be an intentional command; receipt images still require manual selection.

**Why:** A full-screen-by-screen rollout is broad; a shared command/field registry can be expanded without enabling untested actions everywhere at once. Successful action events are the implicit correctness signal, avoiding prompts and unconfirmed examples.

**How to apply:** Keep existing document APIs and authorization as the source of truth; do not invent fields beyond existing form support without clarifying the business meaning. Require review before voice saves, follow company auto-post settings only where the existing invoice flow does, guard mobile actions with matching permissions and validation, preserve per-user draggable-button placement, and keep learning silent and user/company-scoped. For cash records, accept only explicit action phrases and keep receipt attachment manual.
