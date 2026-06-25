import type { Request, Response } from "express";
import type { ExtensionManifest } from "./manifest.js";
import type { BuiltinExtension, ExtensionContext } from "./registry.js";

// ─────────────────────────────────────────────────────────────────────────
// "Hello World" — the reference extension that PROVES the isolation model
// end-to-end:
//   • its manifest is signed and verified like any partner extension,
//   • its screen is served as a sandboxed HTML document (no access to core
//     source, no access to the host window),
//   • its screen calls the extension's OWN API namespace, demonstrating the
//     gated dispatch path.
// It is seeded DISABLED for every company.
// ─────────────────────────────────────────────────────────────────────────

const manifest: ExtensionManifest = {
  manifestVersion: 1,
  extensionId: "hello-world",
  name: { ar: "مرحباً بالعالم", en: "Hello World" },
  version: "1.0.0",
  vendor: "Zacode",
  description:
    "إضافة تجريبية مرجعية تثبت عزل الطرف الثالث: واجهة معزولة (iframe) + نطاق API مستقل، دون الوصول إلى نواة النظام.",
  screens: [{ key: "home", titleAr: "الصفحة الرئيسية", titleEn: "Home", icon: "Puzzle", kind: "screen" }],
  apiRoutes: [{ method: "GET", path: "/ping", description: "Health/echo endpoint" }],
  tables: [],
  permissions: [],
};

function renderScreen(screenKey: string, ctx: ExtensionContext): string {
  // Everything is server-rendered. The token is injected so the sandboxed
  // (origin-less) iframe can call back into the extension API namespace.
  const apiBase = "/api/ext/hello-world/api";
  const token = ctx.token ?? "";
  const title = screenKey === "home" ? "مرحباً بالعالم" : screenKey;
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: system-ui, "Segoe UI", Tahoma, sans-serif;
    background: #f8fafc; color: #0f172a; padding: 24px;
  }
  .card {
    max-width: 560px; margin: 0 auto; background: #fff; border: 1px solid #e2e8f0;
    border-radius: 16px; padding: 28px; box-shadow: 0 1px 3px rgba(0,0,0,.06);
  }
  h1 { margin: 0 0 8px; font-size: 22px; }
  p { color: #475569; line-height: 1.7; margin: 6px 0; }
  .badge { display:inline-block; background:#ede9fe; color:#6d28d9; border-radius:999px; padding:4px 12px; font-size:12px; font-weight:600; }
  .out { margin-top:16px; padding:14px; border-radius:12px; background:#0f172a; color:#a5f3fc; font-family:ui-monospace,monospace; font-size:13px; white-space:pre-wrap; word-break:break-all; }
  button { margin-top:16px; background:#7c3aed; color:#fff; border:0; border-radius:10px; padding:10px 18px; font-size:14px; cursor:pointer; }
  button:hover { background:#6d28d9; }
</style>
</head>
<body>
  <div class="card">
    <span class="badge">إضافة معزولة • Sandboxed</span>
    <h1>مرحباً بالعالم 👋</h1>
    <p>هذه الواجهة تعمل داخل إطار معزول (iframe) لا يمكنه الوصول إلى الكود المصدري لنواة النظام ولا إلى بيانات الصفحة المضيفة.</p>
    <p>تتواصل فقط عبر نطاق API الخاص بالإضافة، مع التحقق من الصلاحيات على الخادم.</p>
    <button id="ping">اختبار الاتصال بالـ API</button>
    <div class="out" id="out">— بانتظار الاختبار —</div>
  </div>
<script>
  var TOKEN = ${JSON.stringify(token)};
  var API_BASE = ${JSON.stringify(apiBase)};
  var out = document.getElementById("out");
  document.getElementById("ping").addEventListener("click", function () {
    out.textContent = "… جارٍ الاتصال";
    fetch(API_BASE + "/ping" + (TOKEN ? "?token=" + encodeURIComponent(TOKEN) : ""), {
      headers: { "Accept": "application/json" }
    })
      .then(function (r) { return r.json(); })
      .then(function (j) { out.textContent = JSON.stringify(j, null, 2); })
      .catch(function (e) { out.textContent = "خطأ: " + e; });
  });
</script>
</body>
</html>`;
}

async function handleApi(sub: string, _req: Request, res: Response, ctx: ExtensionContext): Promise<void> {
  // `sub` is the path AFTER the extension's /api namespace, e.g. "/ping".
  if (sub === "/ping" || sub === "/ping/") {
    res.json({
      ok: true,
      extension: "hello-world",
      message: "مرحباً من إضافة معزولة! (Hello from a sandboxed extension)",
      companyId: ctx.companyId,
      serverTime: new Date().toISOString(),
    });
    return;
  }
  res.status(404).json({ error: "EXT_ROUTE_NOT_FOUND", path: sub });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string),
  );
}

export const helloWorldExtension: BuiltinExtension = {
  extensionId: "hello-world",
  manifest,
  renderScreen,
  handleApi,
};
