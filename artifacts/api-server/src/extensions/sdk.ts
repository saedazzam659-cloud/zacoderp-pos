// ─────────────────────────────────────────────────────────────────────────
// Zacode Extension SDK (browser side).
//
// This module produces the JavaScript that runs INSIDE a sandboxed extension
// iframe. The iframe is sandboxed WITHOUT `allow-same-origin`, so its requests
// carry an opaque (null) origin and it cannot read host cookies or the host
// DOM. The SDK gives partner code one tiny, predictable surface:
//
//   Zacode.ctx                      → { extensionId, companyId, role }
//   Zacode.core.list(resource,opts) → gated, tenant-scoped CORE reads
//   Zacode.core.create(resource,b)  → gated CORE writes (if permitted)
//   Zacode.data.list/get/create/update/remove(collection,...)
//                                   → the extension's OWN ext_records tables
//   Zacode.api.get/post(path,body)  → the extension's OWN custom API routes
//
// Every call resolves to JSON or throws a {status, code, message} error. The
// SDK never sees a token in partner-authored code: the host injects it into a
// private bootstrap object and the SDK reads it from there.
//
// CSP on the screen document is `script-src 'unsafe-inline'` only — we cannot
// serve the SDK as an external <script src>. So `renderExtensionDocument()`
// INLINES the SDK plus a per-request bootstrap into the HTML the host returns.
// (The standalone GET /api/ext/sdk.js endpoint exists for docs/tooling.)
// ─────────────────────────────────────────────────────────────────────────

import type { ExtensionContext } from "./registry.js";

// The SDK source as a string. Written as ES5-ish, dependency-free code so it
// runs in the bare iframe without a build step.
export const EXTENSION_SDK_JS = String.raw`(function () {
  "use strict";
  var boot = (typeof window !== "undefined" && window.__ZX__) || {};
  var BASE = boot.base || "/api/ext";
  var EXT = boot.extensionId || "";
  var TOKEN = boot.token || "";

  function withToken(url) {
    if (!TOKEN) return url;
    return url + (url.indexOf("?") === -1 ? "?" : "&") + "token=" + encodeURIComponent(TOKEN);
  }

  function request(method, url, body) {
    var opts = {
      method: method,
      headers: { "Accept": "application/json" },
    };
    if (body !== undefined && body !== null) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch(withToken(url), opts).then(function (r) {
      var ct = r.headers.get("content-type") || "";
      var parse = ct.indexOf("application/json") !== -1 ? r.json() : r.text();
      return parse.then(function (payload) {
        if (!r.ok) {
          var err = new Error(
            (payload && payload.error) ? payload.error : ("HTTP " + r.status)
          );
          err.status = r.status;
          err.code = (payload && (payload.code || payload.error)) || ("HTTP_" + r.status);
          err.payload = payload;
          throw err;
        }
        return payload;
      });
    });
  }

  function qs(params) {
    if (!params) return "";
    var parts = [];
    for (var k in params) {
      if (Object.prototype.hasOwnProperty.call(params, k) && params[k] != null && params[k] !== "") {
        parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
      }
    }
    return parts.length ? ("?" + parts.join("&")) : "";
  }

  var Zacode = {
    ctx: {
      extensionId: EXT,
      companyId: boot.companyId != null ? boot.companyId : null,
      role: boot.role || null,
    },

    // ── Gated CORE data (read/write subject to manifest permissions) ──
    core: {
      list: function (resource, opts) {
        opts = opts || {};
        return request("GET", BASE + "/" + EXT + "/core/" + encodeURIComponent(resource) +
          qs({ search: opts.search, limit: opts.limit }));
      },
      create: function (resource, body) {
        return request("POST", BASE + "/" + EXT + "/core/" + encodeURIComponent(resource), body || {});
      },
    },

    // ── The extension's OWN data tables (ext_records collections) ──
    data: {
      list: function (collection, opts) {
        opts = opts || {};
        return request("GET", BASE + "/" + EXT + "/data/" + encodeURIComponent(collection) +
          qs({ limit: opts.limit }));
      },
      get: function (collection, id) {
        return request("GET", BASE + "/" + EXT + "/data/" + encodeURIComponent(collection) +
          "/" + encodeURIComponent(id));
      },
      create: function (collection, data) {
        return request("POST", BASE + "/" + EXT + "/data/" + encodeURIComponent(collection),
          { data: data });
      },
      update: function (collection, id, data) {
        return request("PUT", BASE + "/" + EXT + "/data/" + encodeURIComponent(collection) +
          "/" + encodeURIComponent(id), { data: data });
      },
      remove: function (collection, id) {
        return request("DELETE", BASE + "/" + EXT + "/data/" + encodeURIComponent(collection) +
          "/" + encodeURIComponent(id));
      },
    },

    // ── The extension's OWN custom API routes (builtin handler) ──
    api: {
      get: function (path, params) {
        return request("GET", BASE + "/" + EXT + "/api" + path + qs(params));
      },
      post: function (path, body) {
        return request("POST", BASE + "/" + EXT + "/api" + path, body || {});
      },
    },
  };

  if (typeof window !== "undefined") window.Zacode = Zacode;
  if (typeof module !== "undefined" && module.exports) module.exports = Zacode;
})();`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string),
  );
}

export interface RenderDocumentOptions {
  extensionId: string;
  ctx: ExtensionContext;
  title: string;
  // Markup placed inside <body> before the bootstrap/SDK/app scripts.
  bodyHtml: string;
  // Extra CSS for the document <head>.
  styles?: string;
  // Partner application script. Runs AFTER the SDK is installed, so
  // `window.Zacode` is guaranteed available.
  appScript: string;
  lang?: string;
  dir?: "rtl" | "ltr";
}

// Build a complete, self-contained screen document with the SDK + a private
// bootstrap (extensionId/token/base) inlined. This is the canonical way a
// builtin's renderScreen() should emit HTML so partner code can `window.Zacode`.
export function renderExtensionDocument(opts: RenderDocumentOptions): string {
  const lang = opts.lang ?? "ar";
  const dir = opts.dir ?? "rtl";
  const boot = {
    extensionId: opts.extensionId,
    companyId: opts.ctx.companyId,
    role: opts.ctx.role,
    token: opts.ctx.token ?? "",
    base: "/api/ext",
  };
  return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}" dir="${dir}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(opts.title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, "Segoe UI", Tahoma, sans-serif; background: #f8fafc; color: #0f172a; padding: 20px; }
${opts.styles ?? ""}
</style>
</head>
<body>
${opts.bodyHtml}
<script>window.__ZX__ = ${JSON.stringify(boot)};</script>
<script>${EXTENSION_SDK_JS}</script>
<script>(function(){ try { ${opts.appScript} } catch (e) { console.error("extension app error", e); } })();</script>
</body>
</html>`;
}
