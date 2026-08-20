---
name: External agent package lifecycle
description: Durable boundaries for externally supplied full-agent packages, storage, encryption, and later updates.
---

An externally supplied agent edition remains the existing full runtime mode; package source is a separate attribute. Raw large files upload directly into fixed-length private staging, then trusted server code validates their structure, encrypts the durable artifacts, verifies the encrypted round trip, and removes staging. The per-agent decryption key is delivered only during the SSH install command and is never persisted on the agent.

**Why:** Treating the package source as a runtime mode would fork licensing and heartbeat behavior. Requiring browser-side encryption would expose or duplicate the agent key, while unconstrained upload URLs and temporary plaintext copies create storage-abuse and scratch-space risks.

**How to apply:** Keep later central releases manual and gated by the local SuperAdmin, with no automatic restart. Any new upload path must preserve storage-enforced length, private staging cleanup, server-side structural validation and encryption, signed metadata, pre-install object rehashing, and target-side SHA verification before decryption.