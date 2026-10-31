---
name: Screen recorder boundaries
description: Product constraints for the ERP's browser-only screen recorder.
---

Keep the screen recorder browser-local. The user expects to choose between a Windows display/window capture and a browser-tab-only capture; the browser's native permission picker decides which exact surface is available. Do not imply that a web page can capture every Windows monitor or bypass the picker.

Offer bitrate presets and estimated file sizes for long recordings, but describe them as approximate because browser encoders and screen content affect output. Audio availability and quality depend on the browser, OS, selected surface, and user permissions; never guarantee perfect audio.

The recorder stays off by default per company, enabled by SuperAdmin, and separately restricted by per-user permission. Captures are not uploaded to ERP.

Keep drawing guides as a local preview layer and exclude them from the app's video/image composition. However, browser display capture cannot mask UI pixels that are part of the selected screen or tab; when the recorder itself is inside the selected source, explain this limitation and recommend a separate target window/tab.

Voice modification is an optional, on-device microphone effect; do not send audio to a service. Gender and age selections are approximate pitch/tone profiles, not generated or cloned voices, and screen/system audio remains unchanged.

**Why:** The user explicitly needs to record other Windows apps or limit capture to a browser tab, distribute recordings, and reduce file size; platform capture/audio support is not uniform.

**How to apply:** Preserve these boundaries when adding capture sources, preview-only guides, local microphone effects, upload/compression workflows, permissions, or native-helper proposals.
