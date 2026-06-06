---
name: POS Desktop ZATCA secret at-rest encryption
description: The ACL file fallback for ZATCA secrets (private key / CSID) is machine-bound AES-256-GCM, not plaintext; how the key is derived and the migration rule.
---

# POS Desktop — ZATCA secrets encrypted at rest (file fallback)

The desktop keeps ZATCA secrets (EGS private key, compliance/production CSID
bundles) in the OS keyring as the primary store, with an ACL-restricted file in
`%APPDATA%/ZACOD-POS/zatca/<account>` as a **must-succeed fallback** (Windows
Credential Manager silently fails on unsigned MSI / locked group policy).

**Rule:** that file fallback MUST be encrypted, never plaintext. It uses
AES-256-GCM (`aes-gcm` crate, pure-Rust RustCrypto — safe on windows CI, no
openssl/C, unlike the `windows-openssl-trap`). The key is **machine-bound**:
`SHA256("zatca-secret-file-v1|" || license::hardware_fingerprint())`, never
persisted. On-disk format is `"zenc1:" + base64(nonce[12] || ciphertext+tag)`.

**Why machine-bound (not a keyring-stored random key):** the file exists
precisely for when the keyring is unavailable, so the decrypt key can't live in
the keyring (circular). Deriving from the hardware fingerprint means a copied
`%APPDATA%` file is useless on another machine, and no key needs storing.

**How to apply / migration:** `zatca_decrypt` returns any value lacking the
`zenc1:` prefix verbatim → legacy plaintext files keep working and get
re-encrypted on the next `zatca_save_secret`. A decrypt failure (wrong machine
or corruption) surfaces as an Err; the keyring copy usually still resolves it,
otherwise the device re-onboards.

**Still plaintext (deliberate, lower risk):** the device token + cashier token
file fallbacks in `main.rs` use the same ACL plaintext pattern. They are
revocable bearer tokens, not a private signing key, so they were left as-is.
If hardening them, reuse this exact machine-bound AES-GCM scheme.

**CI-only:** Rust here never compiles locally (`pos-desktop-no-local-cargo`).
Hand-verify the `aes-gcm` 0.10 API: `Aes256Gcm::new(Key::<Aes256Gcm>::from_slice)`
needs `aead::{Aead, KeyInit}` in scope; nonce is 12 bytes; `encrypt`/`decrypt`
return `Vec<u8>` only with the default `alloc` feature.
