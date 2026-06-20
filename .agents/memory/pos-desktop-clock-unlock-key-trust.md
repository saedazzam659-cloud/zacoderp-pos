---
name: POS Desktop clock-unlock key trust
description: Offline clock-tamper unlock must verify against the SAME accepted-key set as license files, not only the build-pinned key.
---

# Offline clock-unlock signature must use the license accepted-key set

The standalone clock-tamper lock screen's OFFLINE unlock code is Ed25519-signed
by the vendor's cloud server and verified on the device. It MUST verify against
the same accepted-key set the offline **license** verification uses — pinned
build key, then any TOFU-trusted key in localStorage, then (online) the server's
current public key — NOT only the build-pinned key.

**Why:** The MSI's pinned public key (`VITE_OFFLINE_LICENSE_PUBLIC_KEY_B64`, else
a hardcoded fallback) is frequently STALE because the production signing key was
rotated. Offline **licenses still activate** because `verifyLicenseFile` has a
TOFU recovery path (fetch `zacoderp.com/api/public/download/offline-license-public-key`,
accept only if the file's signature verifies against it, persist as trusted).
If the unlock path verifies only against the stale pinned key, every
server-signed unlock code is rejected with "توقيع غير صحيح — الرمز غير صادر من
الجهة المصرّح لها", even though the device already trusts the real key from
activation. A device that activated a license has ALWAYS cached the real key, so
sharing that key set keeps offline unlock fully offline (no network at unlock).

**How to apply:** Any device-side verification of a vendor-signed artifact
(unlock codes, future signed commands) must call the shared
`verifyWithAcceptedPubkeys(message, signature)` in `lib/standalone.ts`, never
`ed.verifyAsync(..., PINNED_PUBKEY_B64)` directly. Ed25519 arg order is
`verifyAsync(signature, message, pubkey)`. ONLINE unblock for standalone is only
meaningful for self-register licenses (admin-file licenses aren't in the cloud
devices table) — admin-file customers must use the offline code.
