import type { Request, Response } from "express";
import type { ExtensionManifest } from "./manifest.js";
import type { BuiltinExtension, ExtensionContext } from "./registry.js";
import { renderExtensionDocument } from "./sdk.js";
import { CoreApiError } from "./coreDataApi.js";
import { dataCreate, dataList, DataStoreError } from "./dataStore.js";
import { writeAudit } from "../middleware/permissions.js";
import { buildScaffold } from "./aiSuiteBuilder.js";
import { analyzeCfo, reviewAuditor, detectAnomalies } from "./aiSuiteAnalysis.js";

// ─────────────────────────────────────────────────────────────────────────
// "AI Suite" — Phase-6 advanced AI platform, delivered as a SIGNED builtin
// extension so every capability runs through the SAME gates as any partner
// extension and NEVER bypasses core protections:
//
//   • AI Builder   (POST /builder/scaffold) — turns a natural-language brief
//                  into a VALID, SIGNED extension manifest scaffold ready for
//                  the Publish engine. Never ships code; clamps permissions to
//                  read-only on known core resources.
//   • AI CFO       (GET /cfo/analyze)       — financial KPIs + AI narrative,
//                  reading invoices ONLY via the gated Core Data API.
//   • AI Auditor   (GET /auditor/review)    — rule-based entry/invoice review
//                  with an AI executive summary overlay.
//   • AI Monitor   (GET /monitor/anomalies) — statistical anomaly detection
//                  with an AI risk summary overlay.
//
// All core reads go through `coreList` (permission-checked against THIS signed
// manifest, tenant-scoped, projected). Every operation is written to the audit
// log (audit boundary). AI is best-effort; each path returns a deterministic
// rule-based result when AI is off/unavailable (`source: "rules"`).
// ─────────────────────────────────────────────────────────────────────────

const EXT_ID = "ai-suite";

const manifest: ExtensionManifest = {
  manifestVersion: 1,
  extensionId: EXT_ID,
  name: { ar: "منصة الذكاء الاصطناعي المتقدمة", en: "Advanced AI Suite" },
  version: "1.0.0",
  vendor: "Zacode",
  description:
    "منصة ذكاء اصطناعي متقدمة تعمل بالكامل عبر واجهات المنصة المُقيّدة بالصلاحيات: مُنشئ الإضافات بالذكاء الاصطناعي (يولّد بيانًا موقّعًا جاهزًا للنشر)، المدير المالي الذكي، مدقّق القيود، ومراقبة الشذوذ — جميعها مع بدائل قائمة على القواعد عند تعذّر الذكاء الاصطناعي.",
  screens: [
    { key: "builder", titleAr: "مُنشئ الإضافات", titleEn: "AI Builder", icon: "Wand2", kind: "screen" },
    { key: "cfo", titleAr: "المدير المالي الذكي", titleEn: "AI CFO", icon: "LineChart", kind: "dashboard" },
    { key: "auditor", titleAr: "المدقّق الذكي", titleEn: "AI Auditor", icon: "ShieldCheck", kind: "report" },
    { key: "monitor", titleAr: "مراقبة الشذوذ", titleEn: "AI Monitor", icon: "Activity", kind: "report" },
  ],
  apiRoutes: [
    { method: "POST", path: "/builder/scaffold", description: "توليد وتوقيع هيكل إضافة من وصف نصّي" },
    { method: "GET", path: "/builder/scaffolds", description: "قائمة الهياكل المُولّدة المحفوظة" },
    { method: "GET", path: "/cfo/analyze", description: "تحليل مالي (CFO) عبر بيانات النواة المُقيّدة" },
    { method: "GET", path: "/auditor/review", description: "مراجعة تدقيقية للقيود والفواتير" },
    { method: "GET", path: "/monitor/anomalies", description: "كشف الأنماط الشاذّة في الفواتير" },
  ],
  tables: [{ key: "scaffolds", titleAr: "الهياكل المُولّدة", titleEn: "Generated Scaffolds" }],
  permissions: ["invoices:read", "customers:read", "items:read", "suppliers:read", "accounts:read"],
};

// ── Shared styles for the four screens ──────────────────────────────────────
const SHARED_STYLES = `
  .wrap { max-width: 960px; margin: 0 auto; }
  .badge { display:inline-block; background:#ede9fe; color:#6d28d9; border-radius:999px; padding:4px 12px; font-size:12px; font-weight:600; }
  .badge.ai { background:#dcfce7; color:#15803d; }
  .badge.rules { background:#fef9c3; color:#a16207; }
  h1 { font-size: 22px; margin: 10px 0 4px; }
  .muted { color:#64748b; font-size:13px; margin:0 0 18px; line-height:1.7; }
  .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap:14px; margin-bottom:18px; }
  .kpi { background:#fff; border:1px solid #e2e8f0; border-radius:14px; padding:16px; }
  .kpi .label { color:#64748b; font-size:12px; }
  .kpi .value { font-size:24px; font-weight:700; margin-top:6px; }
  table { width:100%; border-collapse:collapse; background:#fff; border:1px solid #e2e8f0; border-radius:12px; overflow:hidden; margin-bottom:18px; }
  th, td { text-align:start; padding:9px 12px; border-bottom:1px solid #eef2f7; font-size:13px; vertical-align:top; }
  th { background:#f1f5f9; color:#334155; font-weight:600; }
  tr:last-child td { border-bottom:0; }
  textarea { width:100%; min-height:96px; padding:12px; border:1px solid #cbd5e1; border-radius:10px; font:inherit; resize:vertical; }
  button { background:#7c3aed; color:#fff; border:0; border-radius:10px; padding:10px 18px; cursor:pointer; font:inherit; margin-top:10px; }
  button:hover { background:#6d28d9; }
  pre { background:#0f172a; color:#e2e8f0; padding:14px; border-radius:12px; overflow:auto; font-size:12px; line-height:1.6; }
  .card { background:#fff; border:1px solid #e2e8f0; border-radius:14px; padding:16px; margin-bottom:14px; }
  .sev-high { color:#dc2626; font-weight:700; }
  .sev-medium { color:#d97706; font-weight:600; }
  .sev-low { color:#0369a1; }
  .sev-info { color:#64748b; }
  ul { margin:6px 0; padding-inline-start:20px; }
  li { font-size:13px; margin-bottom:4px; line-height:1.6; }
  .err { color:#dc2626; font-size:13px; min-height:18px; }
  .empty { color:#94a3b8; font-size:13px; padding:14px; text-align:center; }
`;

function builderApp(): string {
  return `
    var desc = document.getElementById("desc");
    var out = document.getElementById("out");
    var err = document.getElementById("err");
    var btn = document.getElementById("gen");
    function srcBadge(s){ return '<span class="badge ' + (s==="ai"?"ai":"rules") + '">' + (s==="ai"?"ذكاء اصطناعي":"قواعد") + '</span>'; }
    function render(r){
      var notes = (r.notes||[]).map(function(n){ return "<li>"+n+"</li>"; }).join("");
      out.innerHTML =
        '<div class="card">' + srcBadge(r.source) +
        ' <span class="badge">'+(r.valid?"بيان صالح ✓":"غير صالح")+'</span>' +
        ' <span class="badge">مفتاح: '+ (r.publicKeyId||"") +'</span>' +
        '<h3 style="margin:10px 0 6px">التوقيع (Ed25519)</h3>' +
        '<pre>'+ (r.signature||"") +'</pre>' +
        (notes?('<ul>'+notes+'</ul>'):'') +
        '<h3 style="margin:10px 0 6px">البيان الموقّع (Manifest)</h3>' +
        '<pre>'+ JSON.stringify(r.manifest, null, 2) +'</pre>' +
        '</div>';
      loadSaved();
    }
    function loadSaved(){
      Zacode.api.get("/builder/scaffolds", { limit: 50 }).then(function(rows){
        var body = document.getElementById("saved");
        if (!rows.length){ body.innerHTML = '<tr><td colspan="3" class="empty">لا توجد هياكل محفوظة بعد</td></tr>'; return; }
        body.innerHTML = rows.map(function(r){
          var d = r.data || {};
          return "<tr><td>"+(d.extensionId||"")+"</td><td>"+(d.source||"")+"</td><td>"+(r.createdAt?new Date(r.createdAt).toLocaleString():"")+"</td></tr>";
        }).join("");
      }).catch(function(){});
    }
    btn.addEventListener("click", function(){
      var d = (desc.value||"").trim();
      err.textContent = ""; 
      if (!d){ err.textContent = "اكتب وصفًا للإضافة المطلوبة."; return; }
      btn.disabled = true; out.innerHTML = '<div class="empty">… جارٍ التوليد والتوقيع</div>';
      Zacode.api.post("/builder/scaffold", { description: d }).then(function(r){ render(r); })
        .catch(function(e){ out.innerHTML=""; err.textContent = "تعذّر التوليد: " + (e&&e.message?e.message:e); })
        .then(function(){ btn.disabled = false; });
    });
    loadSaved();
  `;
}

function cfoApp(): string {
  return `
    var err = document.getElementById("err");
    var fmt = function(n){ return (parseFloat(n)||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}); };
    function card(label,value){ return '<div class="kpi"><div class="label">'+label+'</div><div class="value">'+value+'</div></div>'; }
    Zacode.api.get("/cfo/analyze").then(function(r){
      var k = r.kpis||{};
      document.getElementById("src").innerHTML = '<span class="badge '+(r.source==="ai"?"ai":"rules")+'">'+(r.source==="ai"?"تحليل ذكاء اصطناعي":"تحليل بالقواعد")+'</span>';
      document.getElementById("kpis").innerHTML =
        card("عدد الفواتير", k.invoiceCount) + card("إجمالي الإيراد", fmt(k.totalRevenue)) +
        card("ضريبة القيمة المضافة", fmt(k.totalVat)) + card("صافي الإيراد", fmt(k.netRevenue)) +
        card("متوسط الفاتورة", fmt(k.avgInvoice)) + card("أعلى فاتورة", fmt(k.maxInvoice));
      document.getElementById("narrative").textContent = r.narrative || "";
      document.getElementById("recs").innerHTML = (r.recommendations||[]).map(function(x){return "<li>"+x+"</li>";}).join("");
      var tr = (r.trend||[]);
      document.getElementById("trend").innerHTML = tr.length ? tr.map(function(t){ return "<tr><td>"+t.month+"</td><td>"+fmt(t.revenue)+"</td><td>"+t.count+"</td></tr>"; }).join("") : '<tr><td colspan="3" class="empty">لا توجد بيانات اتجاه</td></tr>';
      var sb = (r.statusBreakdown||[]);
      document.getElementById("status").innerHTML = sb.length ? sb.map(function(s){ return "<tr><td>"+s.status+"</td><td>"+s.count+"</td><td>"+fmt(s.total)+"</td></tr>"; }).join("") : '<tr><td colspan="3" class="empty">لا توجد بيانات</td></tr>';
    }).catch(function(e){ err.textContent = "تعذّر التحليل: " + (e&&e.message?e.message:e); });
  `;
}

function auditorApp(): string {
  return `
    var err = document.getElementById("err");
    Zacode.api.get("/auditor/review").then(function(r){
      document.getElementById("src").innerHTML = '<span class="badge '+(r.source==="ai"?"ai":"rules")+'">'+(r.source==="ai"?"ملخّص ذكاء اصطناعي":"ملخّص بالقواعد")+'</span>';
      document.getElementById("summary").textContent = r.summary || "";
      var sc = r.scanned||{};
      document.getElementById("scanned").textContent = "تم فحص "+(sc.invoices||0)+" فاتورة و"+(sc.accounts||0)+" حسابًا.";
      var body = document.getElementById("rows");
      body.innerHTML = (r.findings||[]).map(function(f){
        return "<tr><td class='sev-"+f.severity+"'>"+f.severity+"</td><td>"+f.titleAr+"</td><td>"+f.count+"</td><td>"+(f.sample||[]).join("، ")+"</td></tr>";
      }).join("");
    }).catch(function(e){ err.textContent = "تعذّرت المراجعة: " + (e&&e.message?e.message:e); });
  `;
}

function monitorApp(): string {
  return `
    var err = document.getElementById("err");
    Zacode.api.get("/monitor/anomalies").then(function(r){
      document.getElementById("src").innerHTML = '<span class="badge '+(r.source==="ai"?"ai":"rules")+'">'+(r.source==="ai"?"ملخّص ذكاء اصطناعي":"ملخّص بالقواعد")+'</span>';
      document.getElementById("summary").textContent = r.summary || "";
      document.getElementById("scanned").textContent = "تم فحص "+((r.scanned&&r.scanned.invoices)||0)+" فاتورة.";
      var body = document.getElementById("rows");
      body.innerHTML = (r.anomalies||[]).map(function(a){
        return "<tr><td class='sev-"+a.severity+"'>"+a.severity+"</td><td>"+a.titleAr+"</td><td>"+a.detail+"</td></tr>";
      }).join("");
    }).catch(function(e){ err.textContent = "تعذّر الكشف: " + (e&&e.message?e.message:e); });
  `;
}

function renderScreen(screenKey: string, ctx: ExtensionContext): string {
  if (screenKey === "cfo") {
    return renderExtensionDocument({
      extensionId: EXT_ID,
      ctx,
      title: "المدير المالي الذكي",
      styles: SHARED_STYLES,
      bodyHtml: `<div class="wrap">
        <span class="badge">إضافة معزولة • Sandboxed</span> <span id="src"></span>
        <h1>المدير المالي الذكي (AI CFO)</h1>
        <p class="muted">تحليل مالي يقرأ الفواتير عبر واجهة النواة المُقيّدة بالصلاحيات فقط، ويحسب المؤشرات بدقّة (قواعد) مع طبقة سرد بالذكاء الاصطناعي عند توفّره.</p>
        <div class="grid" id="kpis"><div class="empty">… جارٍ التحميل</div></div>
        <div class="card"><h3 style="margin:0 0 8px">التحليل</h3><p class="muted" id="narrative"></p><h4 style="margin:8px 0 4px">التوصيات</h4><ul id="recs"></ul></div>
        <h3>الاتجاه الشهري</h3>
        <table><thead><tr><th>الشهر</th><th>الإيراد</th><th>عدد الفواتير</th></tr></thead><tbody id="trend"><tr><td colspan="3" class="empty">…</td></tr></tbody></table>
        <h3>توزيع الحالات</h3>
        <table><thead><tr><th>الحالة</th><th>العدد</th><th>الإجمالي</th></tr></thead><tbody id="status"><tr><td colspan="3" class="empty">…</td></tr></tbody></table>
        <p class="err" id="err"></p>
      </div>`,
      appScript: cfoApp(),
    });
  }
  if (screenKey === "auditor") {
    return renderExtensionDocument({
      extensionId: EXT_ID,
      ctx,
      title: "المدقّق الذكي",
      styles: SHARED_STYLES,
      bodyHtml: `<div class="wrap">
        <span class="badge">تقرير تدقيق</span> <span id="src"></span>
        <h1>المدقّق الذكي (AI Auditor)</h1>
        <p class="muted">مراجعة تدقيقية للفواتير والحسابات عبر الواجهة المُقيّدة: قواعد حتمية لرصد الأخطاء مع ملخّص تنفيذي بالذكاء الاصطناعي.</p>
        <div class="card"><p class="muted" id="scanned"></p><p id="summary"></p></div>
        <table><thead><tr><th>الخطورة</th><th>الملاحظة</th><th>العدد</th><th>أمثلة</th></tr></thead><tbody id="rows"><tr><td colspan="4" class="empty">… جارٍ التحميل</td></tr></tbody></table>
        <p class="err" id="err"></p>
      </div>`,
      appScript: auditorApp(),
    });
  }
  if (screenKey === "monitor") {
    return renderExtensionDocument({
      extensionId: EXT_ID,
      ctx,
      title: "مراقبة الشذوذ",
      styles: SHARED_STYLES,
      bodyHtml: `<div class="wrap">
        <span class="badge">مراقبة</span> <span id="src"></span>
        <h1>مراقبة الشذوذ (AI Monitor)</h1>
        <p class="muted">كشف الأنماط غير الاعتيادية في الفواتير (قيم شاذّة، ارتفاعات مفاجئة، تكرار) عبر الواجهة المُقيّدة، مع ملخّص مخاطر بالذكاء الاصطناعي.</p>
        <div class="card"><p class="muted" id="scanned"></p><p id="summary"></p></div>
        <table><thead><tr><th>الخطورة</th><th>النمط</th><th>التفاصيل</th></tr></thead><tbody id="rows"><tr><td colspan="3" class="empty">… جارٍ التحميل</td></tr></tbody></table>
        <p class="err" id="err"></p>
      </div>`,
      appScript: monitorApp(),
    });
  }
  // builder (default)
  return renderExtensionDocument({
    extensionId: EXT_ID,
    ctx,
    title: "مُنشئ الإضافات بالذكاء الاصطناعي",
    styles: SHARED_STYLES,
    bodyHtml: `<div class="wrap">
      <span class="badge">مُنشئ • Builder</span>
      <h1>مُنشئ الإضافات بالذكاء الاصطناعي (AI Builder)</h1>
      <p class="muted">صِف الإضافة التي تريدها بالعربية أو الإنجليزية، وسيُنتج النظام بيانًا (Manifest) صالحًا وموقّعًا رقميًا (Ed25519) جاهزًا لمحرّك النشر — يقتصر تلقائيًا على صلاحيات القراءة للموارد المتاحة، دون أي شيفرة تنفيذية.</p>
      <textarea id="desc" placeholder="مثال: إضافة لمتابعة العملاء وعرض تقرير بالفواتير الأخيرة مع لوحة مؤشرات…"></textarea>
      <button id="gen">توليد وتوقيع</button>
      <p class="err" id="err"></p>
      <div id="out"></div>
      <h3>الهياكل المحفوظة</h3>
      <table><thead><tr><th>المعرّف</th><th>المصدر</th><th>التاريخ</th></tr></thead><tbody id="saved"><tr><td colspan="3" class="empty">…</td></tr></tbody></table>
    </div>`,
    appScript: builderApp(),
  });
}

// Audit boundary: every AI-suite operation is recorded. Never throws.
async function audit(
  req: Request,
  ctx: ExtensionContext,
  action: string,
  entityType: string,
  statusCode: number,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await writeAudit({
      userId: req.authUser?.id ?? ctx.userId ?? null,
      username: req.authUser?.username ?? null,
      role: req.authUser?.role ?? ctx.role ?? null,
      companyId: ctx.companyId,
      module: "extensions",
      action,
      method: req.method,
      path: req.originalUrl,
      entityType,
      statusCode,
      metadata: { extensionId: EXT_ID, ...metadata },
    });
  } catch {
    // audit must never break a request
  }
}

function sendCoreError(res: Response, err: unknown): boolean {
  if (err instanceof CoreApiError || err instanceof DataStoreError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return true;
  }
  return false;
}

async function handleApi(sub: string, req: Request, res: Response, ctx: ExtensionContext): Promise<void> {
  const path = sub.replace(/\/+$/, "") || "/";

  // ── AI Builder ──
  if (path === "/builder/scaffold" && req.method === "POST") {
    const description = String((req.body?.description ?? "")).trim();
    if (!description) {
      res.status(400).json({ error: "الوصف مطلوب", code: "EXT_BUILDER_NO_DESCRIPTION" });
      await audit(req, ctx, "ai.builder.scaffold", "ai:builder", 400, { reason: "no-description" });
      return;
    }
    try {
      const result = await buildScaffold(description);
      // Persist the generated scaffold in the extension's OWN tenant-scoped
      // collection (gated by the signed manifest) for later retrieval.
      try {
        await dataCreate(manifest, ctx, EXT_ID, "scaffolds", {
          extensionId: result.manifest.extensionId,
          source: result.source,
          valid: result.valid,
          publicKeyId: result.publicKeyId,
          signature: result.signature,
          manifest: result.manifest,
        });
      } catch {
        // persistence is best-effort; the scaffold is still returned
      }
      res.json({ ok: true, ...result });
      await audit(req, ctx, "ai.builder.scaffold", "ai:builder", 200, {
        source: result.source,
        generatedExtensionId: result.manifest.extensionId,
      });
    } catch (err) {
      if (sendCoreError(res, err)) return;
      throw err;
    }
    return;
  }

  if (path === "/builder/scaffolds" && req.method === "GET") {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const rows = await dataList(manifest, ctx, EXT_ID, "scaffolds", { limit });
      res.json(rows);
    } catch (err) {
      if (sendCoreError(res, err)) return;
      throw err;
    }
    return;
  }

  // ── AI CFO ──
  if (path === "/cfo/analyze" && req.method === "GET") {
    try {
      const result = await analyzeCfo(manifest, ctx);
      res.json(result);
      await audit(req, ctx, "ai.cfo.analyze", "ai:cfo", 200, {
        source: result.source,
        invoiceCount: result.kpis.invoiceCount,
      });
    } catch (err) {
      if (sendCoreError(res, err)) return;
      throw err;
    }
    return;
  }

  // ── AI Auditor ──
  if (path === "/auditor/review" && req.method === "GET") {
    try {
      const result = await reviewAuditor(manifest, ctx);
      res.json(result);
      await audit(req, ctx, "ai.auditor.review", "ai:auditor", 200, {
        source: result.source,
        findings: result.findings.length,
      });
    } catch (err) {
      if (sendCoreError(res, err)) return;
      throw err;
    }
    return;
  }

  // ── AI Monitor ──
  if (path === "/monitor/anomalies" && req.method === "GET") {
    try {
      const result = await detectAnomalies(manifest, ctx);
      res.json(result);
      await audit(req, ctx, "ai.monitor.anomalies", "ai:monitor", 200, {
        source: result.source,
        anomalies: result.anomalies.length,
      });
    } catch (err) {
      if (sendCoreError(res, err)) return;
      throw err;
    }
    return;
  }

  res.status(404).json({ error: "EXT_ROUTE_NOT_FOUND", path: sub });
}

export const aiSuiteExtension: BuiltinExtension = {
  extensionId: EXT_ID,
  manifest,
  renderScreen,
  handleApi,
};
