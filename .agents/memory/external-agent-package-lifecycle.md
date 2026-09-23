---
name: External agent package lifecycle
description: Durable boundaries for externally supplied full-agent packages, storage, encryption, and later updates.
---

An externally supplied agent edition remains the existing full runtime mode; package source is a separate attribute. Raw large files upload directly into fixed-length private staging, then trusted server code validates their structure, encrypts the durable artifacts, verifies the encrypted round trip, and removes staging. The per-agent decryption key is delivered only during the SSH install command and is never persisted on the agent. SSH connection credentials must be repairable through an independent save path that does not validate package readiness or local-SuperAdmin completeness.

**Why:** Treating the package source as a runtime mode would fork licensing and heartbeat behavior. Requiring browser-side encryption would expose or duplicate the agent key, while unconstrained upload URLs and temporary plaintext copies create storage-abuse and scratch-space risks. Coupling SSH repair to full-edition validation can leave a stale encrypted password in place while an unrelated SuperAdmin error blocks the replacement.

**How to apply:** Keep later central releases manual and gated by the local SuperAdmin, with no automatic restart. Any new upload path must preserve storage-enforced length, private staging cleanup, server-side structural validation and encryption, signed metadata, pre-install object rehashing, and target-side SHA verification before decryption. Edition forms may still save everything together, but their server tab must also expose a narrow SSH-only update that preserves an omitted secret and resets connection status independently.

New independent installations should use the published application's release with schema-only database content, not a clone of central tenant data; routine updates retain the target's data.

**Why:** The user chose an independent, empty installation equivalent in capabilities to the existing full platform, not a copy of its customer records. Development builds are not evidence of the currently published release.

**How to apply:** Generate production packages through the authenticated published platform. Make database provenance explicit, retain legacy agent-data behavior unless fresh is selected, bind fresh restore policy to signed metadata, and reject fresh installation into a nonempty target. Configure local SuperAdmin through its existing separate credential flow.

Keep external file import separate from central package generation, and require an explicit generation action rather than generating on ordinary form save.

**Why:** The user needs to import compatible packages from other platforms without central code or database content silently replacing those inputs.

**How to apply:** Preserve existing upload checks and settings, separate generation controls from import controls, and reject mixed pending upload/generation intent. Missing uploads must produce validation, not trigger a central rebuild.

Portable raw downloads are distinct from installation-bound encrypted backups. Re-uploading raw SQL must not infer trusted fresh-schema provenance from filenames or user-provided markers.

**Why:** The user needs reusable files for the external upload workflow, but editable raw files cannot carry the original signed restore policy safely. Downloaded databases may contain sensitive data.

**How to apply:** Keep raw downloads authenticated and explicitly labelled unencrypted; verify stored signed ciphertext before releasing plaintext. Preserve ordinary upload validation and require platform regeneration for signed fresh-schema restore policy.

Bootstrap shell changes must preserve both first-install and retry behavior under inherited shell options.

**Why:** Enabling `pipefail` globally changed an unrelated heartbeat cron pipeline's behavior; filtering an absent or heartbeat-only crontab also returns nonzero under `set -e`. A successful dependency install was therefore not evidence that bootstrap could continue.

**How to apply:** Scope stricter shell options to the operation that needs them. Exercise empty, own-entry-only, and mixed existing configuration, including inherited `pipefail`; keep final writes fail-fast and report fixed stage labels rather than command text that could expose secrets.