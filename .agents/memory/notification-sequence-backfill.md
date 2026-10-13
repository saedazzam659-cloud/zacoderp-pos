---
name: Notification sequence backfill
description: Number legacy and new notifications in each company when notification numbering is enabled.
---

Notification numbering is per company and uses the existing sequence engine through the dedicated `notification` transaction type. When an active notification sequence exists, unnumbered rows are assigned in `created_at`, then `id`, ascending order before the notification list is returned. The formatted number is stored on the notification and logged against its row; already-numbered rows must never be renumbered.

**Why:** The user explicitly requested that linking notifications to a sequence should include historical notifications, not only new ones, and specified the `00001` five-digit style per company.

**How to apply:** Configure a dedicated notification sequence with an empty prefix, start number 1, five-digit padding, and no monthly reset for a continuous `00001` stream. Keep the lazy backfill idempotent and serialized; if the current sequence does not cover an old row, stop before assigning later rows.
