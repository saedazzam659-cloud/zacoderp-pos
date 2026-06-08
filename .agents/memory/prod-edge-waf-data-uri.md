---
name: Production edge WAF blocks data: base64 URIs in request bodies
description: zacoderp.com prod ingress 403s any body containing data:<mime>;base64,<blob>; raw base64 passes — affects logo/image uploads sent as data URLs
---

The production edge in front of the deployed app (custom domain zacoderp.com,
`server: Google Frontend`) rejects with **403 + an HTML page** ("403 Forbidden",
`content-type: text/html`, NO `x-powered-by: Express` header → request never
reaches the app) **any request whose body contains a `data:<mime>;base64,<blob>`
data-URI**.

Verified by curling prod directly (PATCH /api/companies/1/general-settings):
- body with `data:image/png;base64,<big>` → 403 HTML (blocked at edge).
- body with the SAME blob as **raw base64, no `data:` prefix** (400KB, 600KB) → 401 JSON (reaches Express).
- tiny `data:` prefix, plain long text, raw base64 → all 401 JSON (pass).
So the trigger is the `data:...;base64,` data-URI pattern, NOT size/auth.

**Why:** the client-visible symptom is the cryptic `Unexpected token '<', '<!doctype'...
is not valid JSON` (or, with defensive parsing, "ردّ الخادم برمز 403") because the
frontend tried to JSON-parse the WAF's HTML error page. This only reproduces on
the deployed domain — the dev/workspace proxy (`localhost:80`) passes data-URI
bodies fine, so it looks like a phantom "deployment-only" bug.

**How to apply:** never POST/PATCH an image (logo, signature, attachment) to prod
as a `data:` URL string in a JSON body. Strip the `data:<mime>;base64,` prefix on
the client and send **raw base64 + mime separately** (e.g. `{logoBase64, logoMime}`),
then rebuild `data:${mime};base64,${b64}` server-side before storing — keeps the
stored format and all consumers unchanged. (Done for company logo: GeneralSettings.tsx
`splitDataUrl` + companies.ts general-settings route.) For larger/binary assets prefer
multipart upload to object storage. Also: always read `res.text()` then JSON.parse in a
try/catch on these endpoints so a WAF HTML page surfaces a real status, not a parse crash.
