---
name: School guardian portal boundary
description: Preserve separate parent access and consent-based face attendance for the school module.
---

Keep guardian portal accounts separate from employee logins, with links scoped to the same company and school guardian/student records. Biometric enrollment and face matching require active guardian consent; after revocation, the face template must no longer qualify for recognition. Face attendance supplements attendance records and must not replace an existing manually entered full-day record. Do not add a direct CCTV integration. Keep school and guardian-facing interface text in Arabic.

**Why:** These are explicit product and privacy requirements for the school module, not implementation details that can be recovered from code.

**How to apply:** Preserve these boundaries in future guardian portal, biometric, and attendance changes; keep school UI copy Arabic unless the user changes that product requirement.
