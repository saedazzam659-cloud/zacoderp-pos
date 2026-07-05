---
name: pdf.js worker in Tauri webview
description: Load the pdfjs-dist worker via Vite ?worker (workerPort), not ?url (workerSrc), inside Tauri.
---

`pdfjs-dist` (v4) in the pos-desktop Tauri app: instantiate the worker with Vite's `?worker` bundling and assign it to `workerPort`, NOT the `?url` string handed to `workerSrc`.

```
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker";
pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker();
```

**Why:** the `?url` + `workerSrc` form resolves to an asset path the module-worker fetch fails to load under the Tauri custom app protocol, so `getDocument()` rejects. In ItemImport that surfaced as the GENERIC "تعذّرت قراءة الملف" because the swallowed throw was a non-Error. A bundled Worker instance loads reliably in both the Vite browser preview and the Tauri webview.

**How to apply:** vite-env.d.ts must reference `vite/client` for `?worker` typing (it does). Always surface the real cause in the catch (stringify non-Error throws) — see `tauri-invoke-string-error.md`; the generic-only message is what hid this for a whole session.
