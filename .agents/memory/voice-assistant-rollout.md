---
name: Voice assistant rollout
description: User-confirmed scope and rollout order for voice-assisted business records across web and mobile.
---

The user wants the voice assistant to eventually cover every mobile screen, with spoken actions respecting the signed-in user's permissions. The first rollout targets sales invoices and quotations on web and mobile, plus cash deposits and expense entry on mobile. The user accepts a native microphone integration that requires an Android/iOS development build rather than Expo Go.

The user also wants Egyptian and Gulf Arabic recognition options and a microphone button that can be moved and remembers its position on both web and mobile.

The user does not want voice-work messages or learning prompts shown to users. Learn silently and automatically only from commands whose supported action reports success; scope learned examples to the same user and company.

The initial form-filling slice covers customer, item, quantity, and optional unit price for sales invoices and quotations on web and mobile. The user also wants a separate explicit “احفظ الفاتورة” command after reviewing an invoice; never auto-save when dictation ends or issue/post through that save command.

**Why:** A full-screen-by-screen rollout is broad; a shared command/field registry can be expanded without enabling untested actions everywhere at once. Successful action events are the implicit correctness signal, avoiding prompts and unconfirmed examples.

**How to apply:** Keep existing document APIs and authorization as the source of truth, require review before financial saves/posts, make voice save a separate draft-save action guarded by the same permissions and validation, add user grants explicitly for mobile voice access, preserve per-user draggable-button placement, and keep learning silent and user/company-scoped.
