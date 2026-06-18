---
name: PDF export Arabic shaping + logo rendering (html2canvas)
description: Why rasterised PDF exports garble Arabic headings and blank the company logo, and the three independent fixes.
---

The `.pdf` download path (lib/export.ts → exportToPDF → downloadHtmlAsPdf) renders the
report HTML offscreen in an iframe and rasterises it with html2canvas. Three distinct
traps surface there; "Arabic looks wrong" and "logo is blank" are usually NOT the same
cause:

- **`letter-spacing` on Arabic text breaks cursive joining.** It forces letters into
  isolated forms → "مش مفهومة" garbled output, but ONLY on the element that carries
  letter-spacing. Classic symptom: the company name is garbled while the title/table
  Arabic (no letter-spacing) render fine. **Rule:** never put `letter-spacing` on any
  Arabic heading in a print/PDF template.
  **Why:** the cursive script needs adjacent glyphs touching; extra tracking severs them.

- **A CSS `font-weight` not present in the loaded Google-Fonts subset** forces synthetic
  bold and can worsen shaping. Keep the `@import ...Tajawal:wght@...` weight list in sync
  with every `font-weight` the template actually uses (e.g. `.company-name` at 800 needs
  `800` in the import).

- **html2canvas can rasterise before the web font loads** → fallback font mis-shapes ALL
  Arabic. Fix: before capture, `await doc.fonts.load(...)` for the used weights then
  `await doc.fonts.ready`, wrapped in `Promise.race` with a ~3s cap so a slow/offline
  font CDN never hangs the export.

- **Blank logo = canvas taint, not a missing image.** Loading an object-storage logo via
  `<img crossOrigin="anonymous">` taints the canvas when the host omits CORS headers, so
  `canvas.toDataURL()` throws and the logo renders as a blank white card.
  **Fix:** for http(s) logos, `fetch()` the bytes first (same-origin needs no CORS; a
  CORS host still works), `FileReader.readAsDataURL` to a data-URI, then draw — inlined
  bytes never taint. Falls back to the raw `<img>` best-effort path on fetch failure
  (truly cross-origin non-CORS hosts remain unrenderable — a browser-security limit).

**How to apply:** any new print/PDF template in lib/export.ts must (1) avoid letter-spacing
on Arabic, (2) keep the font-weight import list complete, (3) wait on fonts before
html2canvas, (4) route logos through rasterizeLogo (which now inlines http URLs).
