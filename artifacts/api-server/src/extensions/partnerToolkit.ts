import type { Request, Response } from "express";
import type { ExtensionManifest } from "./manifest.js";
import type { BuiltinExtension, ExtensionContext } from "./registry.js";
import { renderExtensionDocument } from "./sdk.js";
import { coreList, CoreApiError } from "./coreDataApi.js";

// ─────────────────────────────────────────────────────────────────────────
// "Partner Toolkit" — the non-trivial reference extension that EXERCISES every
// Phase-2 capability end to end:
//   • a DASHBOARD screen   → reads gated CORE data (customers/invoices/items)
//                            via Zacode.core.list and renders KPI cards,
//   • a REPORT screen      → lists recent CORE invoices through the gateway,
//   • a NOTES screen (CRUD)→ creates/lists/deletes rows in its OWN ext table
//                            (`notes` collection) via Zacode.data.*,
//   • a custom API route   → GET /summary aggregates CORE data SERVER-SIDE
//                            through the SAME gated gateway (proving the
//                            permission model applies to server code too).
//
// It declares only read permissions on core resources and owns exactly one
// table. It is seeded DISABLED for every company like any partner extension.
// ─────────────────────────────────────────────────────────────────────────

const EXT_ID = "partner-toolkit";

const manifest: ExtensionManifest = {
  manifestVersion: 1,
  extensionId: EXT_ID,
  name: { ar: "حزمة أدوات الشريك", en: "Partner Toolkit" },
  version: "1.0.0",
  vendor: "Zacode",
  description:
    "إضافة مرجعية متكاملة تُظهر كل قدرات منصة الإضافات: لوحة معلومات وتقرير يقرآن بيانات النواة عبر واجهة مُقيّدة بالصلاحيات، وشاشة ملاحظات تخزّن في جداول الإضافة الخاصة، ومسار API مخصّص.",
  screens: [
    { key: "dashboard", titleAr: "لوحة المعلومات", titleEn: "Dashboard", icon: "LayoutDashboard", kind: "dashboard" },
    { key: "report", titleAr: "تقرير الفواتير", titleEn: "Invoices Report", icon: "FileBarChart", kind: "report" },
    { key: "notes", titleAr: "ملاحظات الشريك", titleEn: "Partner Notes", icon: "StickyNote", kind: "screen" },
  ],
  apiRoutes: [
    { method: "GET", path: "/summary", description: "ملخّص بيانات النواة (server-side gated)" },
  ],
  tables: [{ key: "notes", titleAr: "الملاحظات", titleEn: "Notes" }],
  permissions: ["customers:read", "invoices:read", "items:read"],
};

const SHARED_STYLES = `
  .wrap { max-width: 880px; margin: 0 auto; }
  .badge { display:inline-block; background:#ede9fe; color:#6d28d9; border-radius:999px; padding:4px 12px; font-size:12px; font-weight:600; }
  h1 { font-size: 22px; margin: 10px 0 4px; }
  .muted { color:#64748b; font-size:13px; margin:0 0 18px; line-height:1.7; }
  .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:14px; }
  .kpi { background:#fff; border:1px solid #e2e8f0; border-radius:14px; padding:18px; }
  .kpi .label { color:#64748b; font-size:13px; }
  .kpi .value { font-size:28px; font-weight:700; margin-top:6px; }
  table { width:100%; border-collapse:collapse; background:#fff; border:1px solid #e2e8f0; border-radius:12px; overflow:hidden; }
  th, td { text-align:start; padding:10px 12px; border-bottom:1px solid #eef2f7; font-size:13px; }
  th { background:#f1f5f9; color:#334155; font-weight:600; }
  tr:last-child td { border-bottom:0; }
  .row { display:flex; gap:8px; margin-bottom:14px; }
  input, button { font: inherit; }
  input[type=text] { flex:1; padding:10px 12px; border:1px solid #cbd5e1; border-radius:10px; }
  button { background:#7c3aed; color:#fff; border:0; border-radius:10px; padding:10px 16px; cursor:pointer; }
  button:hover { background:#6d28d9; }
  button.link { background:transparent; color:#dc2626; padding:4px 8px; }
  .err { color:#dc2626; font-size:13px; min-height:18px; }
  .empty { color:#94a3b8; font-size:13px; padding:14px; text-align:center; }
`;

function dashboardApp(): string {
  return `
    var grid = document.getElementById("kpis");
    var err = document.getElementById("err");
    function card(label, value) {
      return '<div class="kpi"><div class="label">' + label + '</div><div class="value">' + value + '</div></div>';
    }
    Promise.all([
      Zacode.core.list("customers", { limit: 500 }),
      Zacode.core.list("invoices", { limit: 500 }),
      Zacode.core.list("items", { limit: 500 })
    ]).then(function (res) {
      var customers = res[0], invoices = res[1], items = res[2];
      var total = invoices.reduce(function (s, i) { return s + (parseFloat(i.grandTotal) || 0); }, 0);
      grid.innerHTML =
        card("العملاء", customers.length) +
        card("الفواتير", invoices.length) +
        card("الأصناف", items.length) +
        card("إجمالي الفواتير", total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    }).catch(function (e) {
      err.textContent = "تعذّر تحميل البيانات: " + (e && e.message ? e.message : e);
    });
  `;
}

function reportApp(): string {
  return `
    var body = document.getElementById("rows");
    var err = document.getElementById("err");
    Zacode.core.list("invoices", { limit: 100 }).then(function (rows) {
      if (!rows.length) { body.innerHTML = '<tr><td colspan="5" class="empty">لا توجد فواتير</td></tr>'; return; }
      body.innerHTML = rows.map(function (r) {
        return "<tr><td>" + (r.invoiceNumber || "") + "</td><td>" + (r.invoiceType || "") +
          "</td><td>" + (r.status || "") + "</td><td>" + (r.issueDate || "") +
          "</td><td>" + (parseFloat(r.grandTotal) || 0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}) + "</td></tr>";
      }).join("");
    }).catch(function (e) {
      err.textContent = "تعذّر تحميل التقرير: " + (e && e.message ? e.message : e);
    });
  `;
}

function notesApp(): string {
  return `
    var body = document.getElementById("rows");
    var err = document.getElementById("err");
    var input = document.getElementById("text");
    function render(list) {
      if (!list.length) { body.innerHTML = '<tr><td colspan="3" class="empty">لا توجد ملاحظات بعد</td></tr>'; return; }
      body.innerHTML = list.map(function (r) {
        var text = (r.data && r.data.text) ? String(r.data.text) : "";
        return "<tr><td>" + text + "</td><td>" + (r.createdAt ? new Date(r.createdAt).toLocaleString() : "") +
          '</td><td><button class="link" data-id="' + r.id + '">حذف</button></td></tr>';
      }).join("");
      Array.prototype.forEach.call(body.querySelectorAll("button[data-id]"), function (b) {
        b.addEventListener("click", function () {
          Zacode.data.remove("notes", b.getAttribute("data-id")).then(load).catch(showErr);
        });
      });
    }
    function showErr(e) { err.textContent = "خطأ: " + (e && e.message ? e.message : e); }
    function load() { err.textContent = ""; Zacode.data.list("notes", { limit: 200 }).then(render).catch(showErr); }
    document.getElementById("add").addEventListener("click", function () {
      var t = (input.value || "").trim();
      if (!t) return;
      Zacode.data.create("notes", { text: t }).then(function () { input.value = ""; load(); }).catch(showErr);
    });
    load();
  `;
}

function renderScreen(screenKey: string, ctx: ExtensionContext): string {
  if (screenKey === "dashboard") {
    return renderExtensionDocument({
      extensionId: EXT_ID,
      ctx,
      title: "لوحة المعلومات",
      styles: SHARED_STYLES,
      bodyHtml: `<div class="wrap">
        <span class="badge">إضافة معزولة • Sandboxed</span>
        <h1>لوحة معلومات حزمة الأدوات</h1>
        <p class="muted">تقرأ هذه اللوحة بيانات النواة عبر واجهة Core Data API المُقيّدة بالصلاحيات (قراءة فقط)، دون أي وصول مباشر لجداول النظام.</p>
        <div class="grid" id="kpis"><div class="empty">… جارٍ التحميل</div></div>
        <p class="err" id="err"></p>
      </div>`,
      appScript: dashboardApp(),
    });
  }
  if (screenKey === "report") {
    return renderExtensionDocument({
      extensionId: EXT_ID,
      ctx,
      title: "تقرير الفواتير",
      styles: SHARED_STYLES,
      bodyHtml: `<div class="wrap">
        <span class="badge">تقرير</span>
        <h1>أحدث الفواتير</h1>
        <p class="muted">قائمة بأحدث الفواتير من بيانات النواة عبر الواجهة المُقيّدة.</p>
        <table><thead><tr><th>الرقم</th><th>النوع</th><th>الحالة</th><th>التاريخ</th><th>الإجمالي</th></tr></thead>
        <tbody id="rows"><tr><td colspan="5" class="empty">… جارٍ التحميل</td></tr></tbody></table>
        <p class="err" id="err"></p>
      </div>`,
      appScript: reportApp(),
    });
  }
  // notes (default)
  return renderExtensionDocument({
    extensionId: EXT_ID,
    ctx,
    title: "ملاحظات الشريك",
    styles: SHARED_STYLES,
    bodyHtml: `<div class="wrap">
      <span class="badge">جدول خاص بالإضافة</span>
      <h1>ملاحظات الشريك</h1>
      <p class="muted">تُخزَّن هذه الملاحظات في جدول الإضافة الخاص (ext_records / مجموعة notes)، معزولة لكل شركة، دون لمس أي جدول من جداول النواة.</p>
      <div class="row">
        <input type="text" id="text" placeholder="اكتب ملاحظة ثم اضغط إضافة…" />
        <button id="add">إضافة</button>
      </div>
      <table><thead><tr><th>الملاحظة</th><th>التاريخ</th><th></th></tr></thead>
      <tbody id="rows"><tr><td colspan="3" class="empty">… جارٍ التحميل</td></tr></tbody></table>
      <p class="err" id="err"></p>
    </div>`,
    appScript: notesApp(),
  });
}

async function handleApi(sub: string, _req: Request, res: Response, ctx: ExtensionContext): Promise<void> {
  if (sub === "/summary" || sub === "/summary/") {
    // Demonstrates that SERVER-SIDE extension code reaches core data through the
    // EXACT SAME gated gateway — the manifest permission check applies here too.
    try {
      const [customers, invoices, items] = await Promise.all([
        coreList(manifest, ctx, "customers", { limit: 500 }),
        coreList(manifest, ctx, "invoices", { limit: 500 }),
        coreList(manifest, ctx, "items", { limit: 500 }),
      ]);
      const invoiceTotal = (invoices as Array<{ grandTotal?: unknown }>).reduce(
        (s, i) => s + (Number(i.grandTotal) || 0),
        0,
      );
      res.json({
        ok: true,
        extension: EXT_ID,
        companyId: ctx.companyId,
        counts: { customers: customers.length, invoices: invoices.length, items: items.length },
        invoiceTotal,
        serverTime: new Date().toISOString(),
      });
    } catch (err) {
      if (err instanceof CoreApiError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
    return;
  }
  res.status(404).json({ error: "EXT_ROUTE_NOT_FOUND", path: sub });
}

export const partnerToolkitExtension: BuiltinExtension = {
  extensionId: EXT_ID,
  manifest,
  renderScreen,
  handleApi,
};
