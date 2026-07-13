---
name: Web local scan agent (Zacode Scan Agent)
description: Pattern for driving Windows scanners from the web app via a downloadable localhost helper (.bat + embedded PowerShell WIA HttpListener)
---

Browsers cannot reach WIA/TWAIN scanners. Solution: a single self-contained `.bat` served from the web app's vite `public/` (download link in the scanner tab) that the user runs on Windows. It hosts an HttpListener on `http://127.0.0.1:27345` and drives ANY installed scanner via the WIA COM API. The web page (HTTPS) may fetch it because `127.0.0.1` is a secure context; Chrome Private Network Access preflight needs `Access-Control-Allow-Private-Network: true` on OPTIONS.

**Rules learned:**

1. **Split-marker trap**: the bat invokes PowerShell with `iex ((Get-Content -Raw '%~f0') -split <marker>,2)[1]`. The marker literal must NOT appear in the invoking command line itself or the split cuts at the command line, not the real marker. Build it dynamically: `$m = '#=ZSA' + '-PS=#'` and `-split [regex]::Escape($m),2`.
2. **Never `Access-Control-Allow-Origin: *`** on a localhost hardware bridge — any website in the browser could drive the scanner and exfiltrate scans. Enforce an origin allow-list (zacoderp.com + replit dev domains + localhost), echo the specific Origin, 403 anything else (on preflight AND real requests; requests with no Origin header = local tools, allowed).
3. **WAF-safe transport**: base64 image travels agent→browser over localhost (inbound, WAF never sees it); upload to cloud reuses the existing raw-blob presigned PUT — no `data:<mime>;base64` in any request body, so the prod edge WAF data-URI block is not triggered.
4. Scan result → `dataUrlToFile` → the EXISTING page pipeline (`fileToCompressedDataUrl` → pages[] → jsPDF → upload/local save), so cloud and local archive modes both work with zero extra plumbing.
5. `install` arg copies the bat to the user's Startup folder for auto-run.
6. No pwsh in the Linux sandbox — validate by simulating the marker split + brace/paren balance in Node before shipping.

**Where**: agent `artifacts/zatca-invoicing/public/scan-agent/ZacodeScanAgent.bat`, client `src/lib/scanAgent.ts`, UI tab in `JournalScanArchive.tsx`. The agent file is only served in PROD after publishing.
