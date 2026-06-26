---
name: POS Desktop print CSP blocks inline <style>
description: Why standalone Tauri print comes out as raw unstyled text, and the CSP-proof fix.
---

# POS Desktop print = raw unstyled text

**Symptom:** Sales invoice (and any) print preview in the standalone Tauri Windows
app shows ALL the text content correctly but with ZERO styling — no table borders,
no header/cards/colors, content squeezed into a narrow right column. The web preview
(Vite in a normal browser) looks fine. NOT a version mismatch — reproduced on the
latest build.

**Root cause:** Printing goes through a hidden `about:blank` iframe
(`invoicePrint.ts → printHtml`) whose document is built via `document.write(html)`
where `html` carries a big inline `<style>` block. An `about:blank`/srcdoc iframe
INHERITS the parent document's CSP and cannot loosen it. The Tauri CSP
(`tauri.conf.json → app.security.csp`) had no `style-src`, so it fell back to
`default-src 'self'` → the iframe's inline `<style>` element is blocked and never
applied → raw text prints.

**Why adding `'unsafe-inline'` alone is not guaranteed:** Tauri can inject
style hashes for the bundled `index.html` at build time. Per CSP spec, once a
hash- or nonce-source is present in `style-src`, `'unsafe-inline'` is IGNORED — so a
plain `style-src 'self' 'unsafe-inline'` may still not let the dynamic iframe
`<style>` through.

**The CSP-proof fix (do BOTH):**
1. Add `style-src 'self' 'unsafe-inline'` to the CSP (helps when no hash/nonce is injected; also unblocks React inline `style=` attributes everywhere).
2. In `printHtml`, after `idoc.close()`, read the CSS text back out of the blocked
   `<style>` elements (the element + its `textContent` still exist in the DOM even
   when CSP blocked its *application*) and re-apply it via the CSSOM:
   `new win.CSSStyleSheet(); sheet.replaceSync(cssText); idoc.adoptedStyleSheets = [...]`.
   CSSOM `replaceSync`/`adoptedStyleSheets` is NOT subject to `style-src`, so styles
   apply regardless of how the CSP was rewritten. Re-applying identical rules is
   idempotent/harmless. WebView2 (evergreen Chromium) supports constructable sheets.

**How to apply:** Any new print path that injects an inline `<style>` into a written
iframe in pos-desktop is subject to this. Route print through `printHtml` (or copy
its CSSOM re-injection) rather than relying on the inline `<style>` surviving CSP.
Other files with their own print iframes (SalesInvoicesAdmin/exporters/JournalEntries
/SalesScreen/RegisterScreen/ChartOfAccounts/DailyReport) rely on the CSP token; if
one still prints unstyled, give it the same CSSOM re-injection.
