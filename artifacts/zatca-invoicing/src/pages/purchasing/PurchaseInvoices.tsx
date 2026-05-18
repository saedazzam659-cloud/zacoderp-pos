import { useState, useEffect, useMemo } from "react";
import MultiBranchFilter from "@/components/MultiBranchFilter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useFormatters } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Plus, ShoppingCart, Eye, Trash2, CheckCircle2, RotateCcw, Printer, Undo2, Copy, Pencil,
  FileSpreadsheet, FileDown, X, Loader2, Send, User,
} from "lucide-react";
import { BulkPrintMenu } from "@/lib/bulkPrint";
import * as XLSX from "xlsx";
import { cn } from "@/lib/utils";
import {
  downloadCsv, useAuditGridLayout, useColumnResize,
} from "@/lib/auditGridLayout";
import {
  type AdvFilter, isAdvActive, matchAdv, describeAdv,
} from "@/lib/advFilter";
import { AdvFilterPopover } from "@/components/auditGrid/AdvFilterPopover";
import {
  AuditGridBulkBar, AuditGridPagination, ColumnReorderPopover,
  FooterColorPicker, HeaderColorPicker, HeaderSelectCheckbox, RowSelectCheckbox,
} from "@/components/auditGrid/AuditGridControls";
import {
  rowToneFor, SEL_TONE, DocColorLegend, buildToneTooltip, type LegendItem,
} from "@/lib/docRowTone";
import { safeLogoSrc } from "@/lib/export";
import PurchasePrintModal from "./PurchasePrintModal";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const STATUS_CLS: Record<string, string> = {
  draft:     "bg-amber-50 text-amber-700 border-amber-200",
  posted:    "bg-green-50 text-green-700 border-green-200",
  cancelled: "bg-muted text-muted-foreground border-border",
};

export default function PurchaseInvoices() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const { fmt } = useFormatters();
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const authH   = { Authorization: `Bearer ${token}` };
  const isAdmin = user?.role === "admin" || user?.role === "superadmin";

  const [printData, setPrintData] = useState<any>(null);
  const [tableSearch, setTableSearch] = useState("");
  const [branchIds, setBranchIds] = useState<number[]>([]);
  const branchKey = branchIds.length ? branchIds.slice().sort((a, b) => a - b).join(",") : "all";
  const [statusFilter, setStatusFilter] = useState<"all" | "draft" | "posted" | "cancelled">("all");
  const [bulkBusy, setBulkBusy] = useState(false);

  const { data: invoices = [], isLoading } = useQuery<any[]>({
    queryKey: ["purchase-invoices", cid, branchKey],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (cid) params.set("companyId", String(cid));
      if (branchIds.length) params.set("branchIds", branchIds.join(","));
      const res = await fetch(`${API}/api/purchasing/purchase-invoices?${params.toString()}`, { headers: authH }); return res.json();
    },
    enabled: !!user,
  });
  const { data: suppliers = [] } = useQuery<any[]>({
    queryKey: ["suppliers", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/suppliers?companyId=${cid}` : `${API}/api/suppliers`;
      const res = await fetch(url, { headers: authH }); return res.json();
    },
    enabled: !!user,
  });

  // Pull purchase returns to flag invoices that have at least one return doc
  // — a critical audit signal so users can spot "this invoice has a مرتجع"
  // at a glance without opening it. We only need invoiceIds, so a Set keeps
  // the per-row check O(1). `.catch(() => [])` keeps the page rendering even
  // if the returns endpoint is temporarily down.
  const { data: purchaseReturns = [] } = useQuery<any[]>({
    queryKey: ["purchase-returns-flag", cid],
    queryFn: async () => {
      const url = cid
        ? `${API}/api/purchasing/purchase-returns?companyId=${cid}`
        : `${API}/api/purchasing/purchase-returns`;
      try {
        const r = await fetch(url, { headers: authH });
        if (!r.ok) return [];
        return await r.json();
      } catch { return []; }
    },
    enabled: !!user,
  });
  const returnedInvoiceIds = useMemo(
    () => new Set<number>(
      (purchaseReturns as any[])
        .map((r: any) => Number(r.invoiceId))
        .filter((n) => Number.isFinite(n))
    ),
    [purchaseReturns],
  );

  const invalidate = () => qc.invalidateQueries({ queryKey: ["purchase-invoices"] });

  const postMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/purchasing/purchase-invoices/${id}/post`, { method: "PATCH", headers });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || "خطأ"); }
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: t("purchasingPages.purchaseInvoices.toasts.posted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });
  const unpostMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/purchasing/purchase-invoices/${id}/unpost`, { method: "PATCH", headers });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || t("purchasingPages.purchaseInvoices.toasts.unpostFailed")); }
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: t("purchasingPages.purchaseInvoices.toasts.unposted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });
  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/purchasing/purchase-invoices/${id}`, { method: "DELETE", headers });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || "خطأ"); }
    },
    onSuccess: () => { invalidate(); toast({ title: t("purchasingPages.purchaseInvoices.toasts.deleted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  async function bulkRun(
    ids: number[],
    perId: (id: number) => Promise<void>,
  ): Promise<{ ok: number; failed: Array<{ id: number; error: string }> }> {
    let ok = 0;
    const failed: Array<{ id: number; error: string }> = [];
    for (const id of ids) {
      try { await perId(id); ok++; }
      catch (e: any) { failed.push({ id, error: e?.message ?? "خطأ" }); }
    }
    return { ok, failed };
  }

  async function openPrint(inv: any) {
    const res = await fetch(`${API}/api/purchasing/purchase-invoices/${inv.id}`, { headers: authH });
    const full = await res.json();
    const supplier = suppliers.find((s: any) => s.id === inv.supplierId) ?? null;
    setPrintData({ type: "invoice", doc: full, lines: full.lines ?? [], supplier, company: user?.company ?? null });
  }

  const supName = (s: any) => isRtl ? (s?.nameAr ?? s?.nameEn ?? "") : (s?.nameEn ?? s?.nameAr ?? "");
  const supMap: Record<number, string> = useMemo(
    () => Object.fromEntries((suppliers as any[]).map((s: any) => [s.id, supName(s)])),
    [suppliers, isRtl],
  );

  const statusLabel = (s: string) => {
    if (s === "posted") return t("status.posted");
    if (s === "cancelled") return t("status.cancelled");
    return t("status.draft");
  };
  const paymentTypeLabel = (p: string) =>
    p === "cash" ? t("purchasingPages.purchaseInvoices.paymentCash") : t("purchasingPages.purchaseInvoices.paymentCredit");

  /* ── Audit-grid column model ── */
  type ColType = "text" | "num" | "none";
  interface ColDef { key: string; label: string; type: ColType; valueOf: (r: any) => string | number; }
  const COLUMNS: ColDef[] = [
    { key: "_sel",     label: "",                                                            type: "none", valueOf: () => "" },
    { key: "_idx",     label: "#",                                                            type: "none", valueOf: () => "" },
    { key: "doc",      label: t("purchasingPages.purchaseInvoices.cols.number"),             type: "text", valueOf: (r) => r.docNumber ?? `PI-${r.id}` },
    { key: "date",     label: t("purchasingPages.purchaseInvoices.cols.date"),               type: "text", valueOf: (r) => r.invoiceDate ?? "" },
    { key: "supplier", label: t("purchasingPages.purchaseInvoices.cols.supplier"),           type: "text", valueOf: (r) => supMap[r.supplierId] ?? "" },
    { key: "paytype",  label: t("purchasingPages.purchaseInvoices.cols.paymentType"),        type: "text", valueOf: (r) => paymentTypeLabel(r.paymentType) },
    { key: "currency", label: t("purchasingPages.purchaseInvoices.cols.currency"),           type: "text", valueOf: (r) => r.currencyCode ?? "" },
    { key: "subtotal", label: t("purchasingPages.purchaseInvoices.cols.subtotal"),           type: "num",  valueOf: (r) => Number(r.subtotal ?? 0) },
    { key: "vat",      label: t("purchasingPages.purchaseInvoices.cols.vat"),                type: "num",  valueOf: (r) => Number(r.vatAmount ?? 0) },
    { key: "total",    label: t("purchasingPages.purchaseInvoices.cols.total"),              type: "num",  valueOf: (r) => Number(r.totalAmount ?? 0) },
    { key: "paystatus",label: t("purchasingPages.purchaseInvoices.cols.paymentStatus"),      type: "text", valueOf: (r) => r.paymentSettlement?.code ?? "" },
    { key: "journal",  label: t("purchasingPages.purchaseInvoices.cols.journal"),            type: "text", valueOf: (r) => r.journalEntryId ? `JE-${r.journalEntryId}` : "" },
    { key: "status",   label: t("purchasingPages.purchaseInvoices.cols.status"),             type: "text", valueOf: (r) => statusLabel(r.status) },
    { key: "createdBy", label: t("purchasingPages.purchaseInvoices.cols.createdBy", "أنشأه"), type: "text", valueOf: (r) => r.createdByName ?? "" },
    { key: "postedBy",  label: t("purchasingPages.purchaseInvoices.cols.postedBy", "رحّله"),  type: "text", valueOf: (r) => r.postedByName ?? "" },
    { key: "_act",     label: t("purchasingPages.purchaseInvoices.cols.actions"),            type: "none", valueOf: () => "" },
  ];
  const DATA_KEYS = COLUMNS.filter(c => c.key !== "_sel" && c.key !== "_idx" && c.key !== "_act").map(c => c.key);
  const ALL_KEYS  = COLUMNS.map(c => c.key);

  const layout = useAuditGridLayout({
    screenSlug: "purchaseInvoicesAuditGrid",
    cid,
    dataKeys: DATA_KEYS,
    allColKeys: ALL_KEYS,
  });
  const { tableRef, gripProps } = useColumnResize(layout.setColWidths);
  const { theme, footerTheme, colWidths, colFilters, clearColFilters,
          isSelected, toggleRow, toggleAll, isAllSelected, isSomeSelected, clearSelection } = layout;


  // Per-column advanced filter (two conditions joined by AND/OR) — shared
  // primitives in lib/advFilter.ts + components/auditGrid/AdvFilterPopover.
  const [colAdv, setColAdv] = useState<Record<string, AdvFilter>>({});
  const clearColAdv = (key: string) =>
    setColAdv(prev => { const n = { ...prev }; delete n[key]; return n; });
  const clearAllColFilters = () => { clearColFilters(); setColAdv({}); };
  /* ── Filtering ── */
  const filteredInvoices = useMemo(() => {
    const q = tableSearch.trim().toLowerCase();
    return (invoices as any[]).filter((inv) => {
      if (statusFilter !== "all" && inv.status !== statusFilter) return false;
      if (q) {
        const hay = [
          inv.docNumber, `PI-${inv.id}`, inv.invoiceDate, supMap[inv.supplierId],
          inv.currencyCode, inv.notes,
        ].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      for (const col of COLUMNS) {
        const adv = colAdv[col.key];
        if (!isAdvActive(adv)) continue;
        if (!matchAdv(col.valueOf(inv), adv, col.type)) return false;
      }
      return true;
    });
  }, [invoices, tableSearch, statusFilter, colAdv, supMap]);

  /* ── Pagination ── */
  const { pageSize, page, setPage } = layout;
  const totalPages = pageSize === 0 ? 1 : Math.max(1, Math.ceil(filteredInvoices.length / pageSize));
  const safePage = Math.min(page, totalPages);
  useEffect(() => { if (safePage !== page) setPage(safePage); }, [safePage, page, setPage]);
  const pagedInvoices = useMemo(
    () => pageSize === 0 ? filteredInvoices : filteredInvoices.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filteredInvoices, pageSize, safePage],
  );
  const pageStart = filteredInvoices.length === 0 ? 0 : pageSize === 0 ? 1 : (safePage - 1) * pageSize + 1;
  const pageEnd   = pageSize === 0 ? filteredInvoices.length : Math.min(safePage * pageSize, filteredInvoices.length);

  /* ── Totals ── */
  const totals = useMemo(() => filteredInvoices.reduce(
    (a, r: any) => {
      a.subtotal += Number(r.subtotal ?? 0);
      a.vat      += Number(r.vatAmount ?? 0);
      a.total    += Number(r.totalAmount ?? 0);
      return a;
    },
    { subtotal: 0, vat: 0, total: 0 },
  ), [filteredInvoices]);

  const visibleColumns = useMemo(() => {
    const dataCols = layout.dataOrder
      .map((k) => COLUMNS.find((c) => c.key === k))
      .filter((c): c is ColDef => !!c);
    const sel = COLUMNS.find((c) => c.key === "_sel")!;
    const idx = COLUMNS.find((c) => c.key === "_idx")!;
    const act = COLUMNS.find((c) => c.key === "_act")!;
    return [sel, idx, ...dataCols, act];
  }, [layout.dataOrder, COLUMNS]);
  const reorderableCols = useMemo(
    () => DATA_KEYS.map((k) => COLUMNS.find((c) => c.key === k)!).map((c) => ({ key: c.key, label: c.label })),
    [DATA_KEYS, COLUMNS],
  );

  /* ── Print/PDF/Excel helpers ── */
  const escapeHtml = (s: any) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  const safeLogo = safeLogoSrc((user?.company as any)?.logo) ?? "";
  const openPrintWindow = (html: string) => {
    const w = window.open("", "_blank", "width=1100,height=800");
    if (!w) {
      toast({ title: "تم حظر النافذة المنبثقة", description: "الرجاء السماح بفتح النوافذ المنبثقة من المتصفح للطباعة", variant: "destructive" });
      return;
    }
    w.document.open(); w.document.write(html); w.document.close();
  };

  const buildListHtml = (source: any[] = filteredInvoices) => {
    const today = new Date().toLocaleDateString("ar-SA");
    const sumSub = source.reduce((a, r: any) => a + Number(r.subtotal ?? 0), 0);
    const sumVat = source.reduce((a, r: any) => a + Number(r.vatAmount ?? 0), 0);
    const sumTot = source.reduce((a, r: any) => a + Number(r.totalAmount ?? 0), 0);
    const logoHtml = safeLogo
      ? `<div style="margin-bottom:6px;"><img src="${safeLogo}" alt="" style="max-height:54px;max-width:170px;object-fit:contain;display:block;margin:0 auto;" /></div>` : "";
    const companyHtml = user?.company?.nameAr
      ? `<div style="font-size:13px;font-weight:600;color:#1e3a8a;margin-bottom:2px;">${escapeHtml(user.company.nameAr)}</div>` : "";
    return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${escapeHtml(t("purchasingPages.purchaseInvoices.title"))}</title>
<style>
@page { size: A4 landscape; margin: 12mm; }
* { box-sizing: border-box; }
body { font-family: "Segoe UI","Tahoma","Arial",system-ui,sans-serif; color:#111; margin:0; }
.h { text-align:center; margin-bottom:8px; }
.h h1 { margin:0 0 4px; font-size:18px; }
.h .meta { font-size:11px; color:#555; }
.totals { display:flex; gap:16px; justify-content:center; margin:8px 0 12px; font-size:12px; }
.totals span b { color:#1e3a8a; }
table { width:100%; border-collapse:collapse; font-size:11px; }
thead th { background:#1e3a8a; color:#fff; padding:6px 8px; border:1px solid #1e3a8a; text-align:right; font-weight:600; }
tbody td { padding:5px 8px; border:1px solid #d1d5db; text-align:right; }
tbody tr:nth-child(even) td { background:#f5f7fb; }
tfoot td { padding:6px 8px; border:1px solid #1e3a8a; background:#eef2ff; font-weight:700; }
.num { font-family:"Consolas",monospace; }
.print-btn { position:fixed; top:10px; left:10px; padding:8px 14px; background:#1e3a8a; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:12px; }
@media print { .print-btn { display:none; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">طباعة</button>
<div class="h">${logoHtml}${companyHtml}<h1>${escapeHtml(t("purchasingPages.purchaseInvoices.title"))}</h1>
<div class="meta">تاريخ التقرير: ${today} — عدد الفواتير: ${source.length}</div></div>
<div class="totals">
  <span>إجمالي المجموع: <b>${sumSub.toFixed(2)}</b></span>
  <span>إجمالي الضريبة: <b>${sumVat.toFixed(2)}</b></span>
  <span>الإجمالي: <b>${sumTot.toFixed(2)}</b></span>
</div>
<table><thead><tr>
  <th>#</th><th>رقم الفاتورة</th><th>التاريخ</th><th>المورد</th><th>طريقة الدفع</th>
  <th>العملة</th><th>المجموع</th><th>الضريبة</th><th>الإجمالي</th><th>الحالة</th>
</tr></thead><tbody>
${source.map((r: any, i: number) => `<tr>
  <td>${i + 1}</td>
  <td>${escapeHtml(r.docNumber ?? `PI-${r.id}`)}</td>
  <td>${escapeHtml(r.invoiceDate ?? "")}</td>
  <td>${escapeHtml(supMap[r.supplierId] ?? "")}</td>
  <td>${escapeHtml(paymentTypeLabel(r.paymentType))}</td>
  <td>${escapeHtml(r.currencyCode ?? "")}</td>
  <td class="num">${Number(r.subtotal ?? 0).toFixed(2)}</td>
  <td class="num">${Number(r.vatAmount ?? 0).toFixed(2)}</td>
  <td class="num">${Number(r.totalAmount ?? 0).toFixed(2)}</td>
  <td>${escapeHtml(statusLabel(r.status))}</td>
</tr>`).join("")}
</tbody><tfoot><tr>
  <td colspan="6">الإجمالي العام</td>
  <td class="num">${sumSub.toFixed(2)}</td>
  <td class="num">${sumVat.toFixed(2)}</td>
  <td class="num">${sumTot.toFixed(2)}</td>
  <td></td>
</tr></tfoot></table>
<script>setTimeout(()=>window.print(),300);</script></body></html>`;
  };

  const buildBulkHtml = (docs: any[]) => {
    const today = new Date().toLocaleDateString("ar-SA");
    const grandSub = docs.reduce((a, d: any) => a + Number(d.subtotal ?? 0), 0);
    const grandVat = docs.reduce((a, d: any) => a + Number(d.vatAmount ?? 0), 0);
    const grandTot = docs.reduce((a, d: any) => a + Number(d.totalAmount ?? 0), 0);
    const logoHtml = safeLogo
      ? `<div style="margin-bottom:6px;"><img src="${safeLogo}" alt="" style="max-height:48px;max-width:160px;object-fit:contain;display:block;margin:0 auto;" /></div>` : "";
    const companyHtml = user?.company?.nameAr
      ? `<div style="font-size:13px;font-weight:600;color:#1e3a8a;margin-bottom:2px;text-align:center;">${escapeHtml(user.company.nameAr)}</div>` : "";
    const sections = docs.map((d: any) => {
      const lines: any[] = Array.isArray(d.lines) ? d.lines : [];
      const docNo  = d.docNumber ?? `PI-${d.id}`;
      const linesHtml = lines.length === 0
        ? `<tr><td colspan="6" style="text-align:center;color:#6b7280;padding:14px;">لا توجد بنود لهذه الفاتورة.</td></tr>`
        : lines.map((l: any, i: number) => {
            const itemLabel = l.itemName ?? l.description ?? `#${l.itemId ?? ""}`;
            const qty = Number(l.quantity ?? l.qty ?? 0);
            const up  = Number(l.unitPrice ?? 0);
            const vat = Number(l.vatAmount ?? 0);
            const ttl = Number(l.totalAmount ?? l.lineTotal ?? 0);
            return `<tr>
              <td style="text-align:center;">${i + 1}</td>
              <td>${escapeHtml(itemLabel)}</td>
              <td class="num">${qty.toFixed(2)}</td>
              <td class="num">${up.toFixed(2)}</td>
              <td class="num">${vat.toFixed(2)}</td>
              <td class="num">${ttl.toFixed(2)}</td>
            </tr>`;
          }).join("");
      return `<section class="doc">
        <div class="doc-head">
          <span class="badge b-doc">رقم الفاتورة: ${escapeHtml(docNo)}</span>
          <span class="badge b-date">التاريخ: ${escapeHtml(d.invoiceDate ?? "")}</span>
          <span class="badge b-cust">المورد: ${escapeHtml(supMap[d.supplierId] ?? "")}</span>
          <span class="badge b-status s-${escapeHtml(d.status)}">${escapeHtml(statusLabel(d.status))}</span>
        </div>
        ${d.notes ? `<div class="desc">${escapeHtml(d.notes)}</div>` : ""}
        <table>
          <thead><tr>
            <th style="width:30px;">#</th><th>الصنف</th>
            <th style="width:70px;">الكمية</th><th style="width:80px;">السعر</th>
            <th style="width:75px;">الضريبة</th><th style="width:90px;">الإجمالي</th>
          </tr></thead>
          <tbody>${linesHtml}</tbody>
          <tfoot><tr>
            <td colspan="4" style="text-align:left;">المجموع</td>
            <td class="num">${Number(d.vatAmount ?? 0).toFixed(2)}</td>
            <td class="num">${Number(d.totalAmount ?? 0).toFixed(2)}</td>
          </tr></tfoot>
        </table>
      </section>`;
    }).join("");
    return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>طباعة الفواتير المحدّدة</title>
<style>
@page { size: A4 portrait; margin: 12mm; }
* { box-sizing: border-box; }
body { font-family:"Segoe UI","Tahoma","Arial",system-ui,sans-serif; color:#111; margin:0; }
.h { text-align:center; margin-bottom:10px; }
.h h1 { margin:0 0 4px; font-size:17px; }
.h .meta { font-size:11px; color:#555; }
.grand { display:flex; gap:14px; justify-content:center; margin:6px 0 14px; font-size:12px; }
.grand span b { color:#0f766e; }
section.doc { margin:0 0 14px; padding:8px; border:1px solid #cbd5e1; border-radius:6px; page-break-inside:avoid; background:#fff; }
.doc-head { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:6px; }
.badge { display:inline-block; padding:2px 8px; border-radius:6px; font-size:11px; font-weight:600; border:1px solid; }
.b-doc{background:#eef2ff;border-color:#a5b4fc;color:#3730a3;}
.b-date{background:#fef9c3;border-color:#fde047;color:#713f12;}
.b-cust{background:#ecfeff;border-color:#67e8f9;color:#155e75;}
.b-status.s-posted{background:#d1fae5;border-color:#34d399;color:#065f46;}
.b-status.s-draft{background:#f1f5f9;border-color:#94a3b8;color:#334155;}
.b-status.s-cancelled{background:#fee2e2;border-color:#f87171;color:#991b1b;}
.desc { font-size:11px; color:#475569; padding:4px 6px; background:#f8fafc; border:1px dashed #cbd5e1; border-radius:4px; margin-bottom:6px; }
table { width:100%; border-collapse:collapse; font-size:10.5px; }
thead th { background:#1e3a8a; color:#fff; padding:5px 6px; border:1px solid #1e3a8a; text-align:right; font-weight:600; }
tbody td { padding:4px 6px; border:1px solid #d1d5db; text-align:right; }
tfoot td { padding:5px 6px; border:1px solid #1e3a8a; background:#eef2ff; font-weight:700; }
.num { font-family:"Consolas",monospace; }
.print-btn { position:fixed; top:10px; left:10px; padding:8px 14px; background:#1e3a8a; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:12px; }
@media print { .print-btn { display:none; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">طباعة</button>
<div class="h">${logoHtml}${companyHtml}<h1>الفواتير المحدّدة</h1>
<div class="meta">تاريخ التقرير: ${today} — عدد الفواتير: ${docs.length}</div></div>
<div class="grand">
  <span>إجمالي المجموع: <b>${grandSub.toFixed(2)}</b></span>
  <span>إجمالي الضريبة: <b>${grandVat.toFixed(2)}</b></span>
  <span>الإجمالي العام: <b>${grandTot.toFixed(2)}</b></span>
</div>
${sections}
<script>setTimeout(()=>window.print(),350);</script></body></html>`;
  };

  const handleExportPDF = () => openPrintWindow(buildListHtml());
  const handlePrint    = () => openPrintWindow(buildListHtml());
  const handleExportExcel = () => {
    if (filteredInvoices.length === 0) { toast({ title: "لا يوجد بيانات للتصدير", variant: "destructive" }); return; }
    const rows = filteredInvoices.map((r: any) => ({
      "رقم الفاتورة": r.docNumber ?? `PI-${r.id}`,
      "التاريخ": r.invoiceDate ?? "",
      "المورد": supMap[r.supplierId] ?? "",
      "طريقة الدفع": paymentTypeLabel(r.paymentType),
      "العملة": r.currencyCode ?? "",
      "المجموع": Number(r.subtotal ?? 0).toFixed(2),
      "الضريبة": Number(r.vatAmount ?? 0).toFixed(2),
      "الإجمالي": Number(r.totalAmount ?? 0).toFixed(2),
      "الحالة": statusLabel(r.status),
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 14 }, { wch: 12 }, { wch: 22 }, { wch: 12 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "فواتير الشراء");
    XLSX.writeFile(wb, `purchase-invoices-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };


  function exportCsv() {
    if (filteredInvoices.length === 0) { toast({ title: "لا يوجد بيانات للتصدير", variant: "destructive" }); return; }
    const header = ["#", ...visibleColumns.filter((c) => c.key !== "_sel" && c.key !== "_idx" && c.key !== "_act").map((c) => c.label)];
    const rows = filteredInvoices.map((r: any, i: number) => [
      i + 1,
      ...visibleColumns
        .filter((c) => c.key !== "_sel" && c.key !== "_idx" && c.key !== "_act")
        .map((c) => {
          const v = c.valueOf(r);
          return c.type === "num" ? Number(v).toFixed(2) : String(v);
        }),
    ]);
    downloadCsv(`purchase-invoices-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
    toast({ title: "تم تصدير ملف CSV بنجاح" });
  }

  /* ── Bulk handlers (post / unpost / delete) ── */
  const allFilteredIds: number[] = useMemo(
    () => filteredInvoices.map((r: any) => Number(r.id)),
    [filteredInvoices],
  );
  const selectedRows = useMemo(
    () => (invoices as any[]).filter((r) => isSelected(Number(r.id))),
    [invoices, isSelected],
  );
  const selectedDrafts    = selectedRows.filter((r) => r.status === "draft");
  const selectedPosted    = selectedRows.filter((r) => r.status === "posted");
  const selectedDeletable = selectedRows.filter((r) => r.status === "draft");

  async function bulkPost() {
    const ids = selectedDrafts.map((r) => Number(r.id));
    if (ids.length === 0) { toast({ title: "لا توجد مسوّدات ضمن المحدَّد", variant: "destructive" }); return; }
    setBulkBusy(true);
    try {
      const { ok, failed } = await bulkRun(ids, async (id) => {
        const res = await fetch(`${API}/api/purchasing/purchase-invoices/${id}/post`, { method: "PATCH", headers });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error ?? `HTTP ${res.status}`); }
      });
      invalidate();
      if (failed.length === 0) toast({ title: `تم ترحيل ${ok} فاتورة بنجاح` });
      else toast({ title: `ترحيل: ${ok} نجح، ${failed.length} فشل`, description: failed.slice(0, 3).map(f => f.error).join("\n"), variant: "destructive" });
      clearSelection();
    } finally { setBulkBusy(false); }
  }

  async function bulkUnpost() {
    const ids = selectedPosted.map((r) => Number(r.id));
    if (ids.length === 0) { toast({ title: "لا توجد فواتير مرحَّلة ضمن المحدَّد", variant: "destructive" }); return; }
    if (!window.confirm(`فك ترحيل ${ids.length} فاتورة؟ سيتم حذف القيود المحاسبية المرتبطة.`)) return;
    setBulkBusy(true);
    try {
      const { ok, failed } = await bulkRun(ids, async (id) => {
        const res = await fetch(`${API}/api/purchasing/purchase-invoices/${id}/unpost`, { method: "PATCH", headers });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error ?? `HTTP ${res.status}`); }
      });
      invalidate();
      if (failed.length === 0) toast({ title: `تم فك ترحيل ${ok} فاتورة` });
      else toast({ title: `فك الترحيل: ${ok} نجح، ${failed.length} فشل`, description: failed.slice(0, 3).map(f => f.error).join("\n"), variant: "destructive" });
      clearSelection();
    } finally { setBulkBusy(false); }
  }

  async function bulkDelete() {
    const ids = selectedDeletable.map((r) => Number(r.id));
    if (ids.length === 0) { toast({ title: "لا يمكن حذف الفواتير المرحَّلة. فك الترحيل أولاً.", variant: "destructive" }); return; }
    if (!window.confirm(`حذف ${ids.length} فاتورة نهائياً؟ لا يمكن التراجع عن هذا الإجراء.`)) return;
    setBulkBusy(true);
    try {
      const { ok, failed } = await bulkRun(ids, async (id) => {
        const res = await fetch(`${API}/api/purchasing/purchase-invoices/${id}`, { method: "DELETE", headers });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error ?? `HTTP ${res.status}`); }
      });
      invalidate();
      if (failed.length === 0) toast({ title: `تم حذف ${ok} فاتورة` });
      else toast({ title: `حذف: ${ok} نجح، ${failed.length} فشل`, description: failed.slice(0, 3).map(f => f.error).join("\n"), variant: "destructive" });
      clearSelection();
    } finally { setBulkBusy(false); }
  }

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShoppingCart className="h-6 w-6 text-primary" />{t("purchasingPages.purchaseInvoices.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t("purchasingPages.purchaseInvoices.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2 print:hidden">
          <Button
            onClick={() => navigate("/purchasing/invoices/new")}
            className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm"
          >
            <Plus className="h-4 w-4" />
            {t("purchasingPages.purchaseInvoices.newInvoice")}
          </Button>
          <div className="inline-flex items-stretch rounded-md border border-slate-300 bg-white shadow-sm overflow-hidden">
            <Button variant="ghost" size="sm" onClick={handleExportPDF}
              className="h-9 rounded-none gap-1.5 text-red-700 hover:bg-red-50 hover:text-red-700 px-3">
              <FileDown className="h-4 w-4" /> PDF
            </Button>
            <div className="w-px bg-slate-200" />
            <Button variant="ghost" size="sm" onClick={handleExportExcel}
              className="h-9 rounded-none gap-1.5 text-green-700 hover:bg-green-50 hover:text-green-700 px-3">
              <FileSpreadsheet className="h-4 w-4" /> Excel
            </Button>
            <div className="w-px bg-slate-200" />
            <Button variant="ghost" size="sm" onClick={handlePrint}
              className="h-9 rounded-none gap-1.5 text-slate-700 hover:bg-slate-50 hover:text-slate-700 px-3">
              <Printer className="h-4 w-4" /> طباعة
            </Button>
          </div>
        </div>
      </div>

      {/* Audit-grid toolbar */}
      <div className={cn("rounded-t-lg overflow-hidden border shadow-sm transition-colors", theme.border)}>
        <div className={cn("px-3 py-2 flex items-center gap-2 flex-wrap transition-colors", theme.bar, theme.text)} dir={isRtl ? "rtl" : "ltr"}>
          <div className={cn("flex-1 text-sm font-bold tracking-wide flex items-center gap-2", theme.text)}>
            <ShoppingCart className="h-4 w-4 opacity-90" />
            جرد فواتير المشتريات
          </div>
          <div className="flex items-center gap-1.5">
            <HeaderColorPicker layout={layout} isRtl={isRtl} />
            <FooterColorPicker layout={layout} isRtl={isRtl} />
            <ColumnReorderPopover layout={layout} isRtl={isRtl} columns={reorderableCols} />
            <Button type="button" size="sm" variant="ghost"
              className={cn("h-7 px-2 text-xs gap-1", theme.btn)} onClick={exportCsv}>
              <FileSpreadsheet className="h-3.5 w-3.5" />
              تصدير CSV
            </Button>
          </div>
        </div>

        <div className="bg-slate-50 border-t border-slate-200 px-3 py-2 flex items-center gap-2 flex-wrap text-xs" dir={isRtl ? "rtl" : "ltr"}>
          <Input
            placeholder="بحث (مستند، مورد، عملة)…"
            value={tableSearch}
            onChange={(e) => setTableSearch(e.target.value)}
            className="h-7 text-xs w-56"
          />
          <MultiBranchFilter value={branchIds} onChange={setBranchIds} size="sm" />
          <div className="flex gap-1">
            {(["all", "draft", "posted", "cancelled"] as const).map((s) => (
              <button key={s} type="button" onClick={() => setStatusFilter(s)}
                className={cn(
                  "px-2 py-1 rounded text-[11px] font-medium border transition-colors",
                  statusFilter === s
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100",
                )}>
                {s === "all" ? "الكل" : statusLabel(s)}
              </button>
            ))}
          </div>
          {(Object.values(colFilters).some((v) => v) || Object.values(colAdv).some(isAdvActive)) && (
            <Button type="button" size="sm" variant="ghost"
              className="h-7 px-2 text-xs text-rose-700 hover:bg-rose-50"
              onClick={clearAllColFilters} title="مسح فلاتر الأعمدة">
              <X className="h-3.5 w-3.5 me-1" />
              مسح فلاتر الأعمدة
            </Button>
          )}
          <div className="flex-1" />
          <span className="text-slate-700 font-medium">
            {filteredInvoices.length} فاتورة
            {filteredInvoices.length !== invoices.length && <span className="text-slate-400"> / {invoices.length}</span>}
          </span>
        </div>
        <AuditGridBulkBar count={layout.selected.size} onClear={clearSelection} busy={bulkBusy}>
          <BulkPrintMenu
            selectedIds={Array.from(layout.selected).map(Number)}
            filteredDocs={filteredInvoices as any[]}
            adapter={{
              kind: "purchase-invoice",
              title: t("purchasingPages.purchaseInvoices.title"),
              docTypeLabel: "فاتورة شراء",
              partyLabel: "المورد",
              getHeader: (d: any) => ({
                docNo: d.docNumber ?? `PI-${d.id}`,
                date: d.invoiceDate ?? "",
                partyName: supMap[d.supplierId] ?? "",
                statusKey: d.status,
                statusLabel: statusLabel(d.status),
                currency: d.currencyCode,
                notes: d.notes,
              }),
              getTotals: (d: any) => ({
                subtotal: Number(d.subtotal ?? 0),
                vat: Number(d.vatAmount ?? 0),
                total: Number(d.totalAmount ?? 0),
              }),
              getLines: (d: any) => (Array.isArray(d.lines) ? d.lines : []).map((l: any) => ({
                name: l.itemName ?? l.description ?? `#${l.itemId ?? ""}`,
                qty: Number(l.quantity ?? l.qty ?? 0),
                unitPrice: Number(l.unitPrice ?? 0),
                vatAmount: Number(l.vatAmount ?? 0),
                total: Number(l.totalAmount ?? l.lineTotal ?? 0),
              })),
            }}
            company={user?.company}
            buildSummary={(docs) => buildListHtml(docs as any[])}
            buildDetailed={(docs) => buildBulkHtml(docs as any[])}
            fetchFull={async (id) => {
              const res = await fetch(`${API}/api/purchasing/purchase-invoices/${id}${cid ? `?companyId=${cid}` : ""}`, { headers: authH });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              return res.json();
            }}
            onPopupBlocked={() => toast({ title: "تم حظر النافذة المنبثقة", description: "الرجاء السماح بالنوافذ المنبثقة للطباعة", variant: "destructive" })}
            onFetchFailed={(n) => toast({ title: `تعذّر تحميل ${n} فاتورة بكامل بنودها`, variant: "destructive" })}
            primaryLabel="طباعة"
          />
          <Button type="button" size="sm"
            className="h-7 px-3 text-xs gap-1 bg-emerald-700 hover:bg-emerald-600 text-white"
            onClick={bulkPost}
            disabled={bulkBusy || selectedDrafts.length === 0}
            title={selectedDrafts.length === 0 ? "لا توجد مسوّدات ضمن المحدَّد" : `ترحيل ${selectedDrafts.length} فاتورة`}>
            {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            ترحيل ({selectedDrafts.length})
          </Button>
          <Button type="button" size="sm" variant="outline"
            className="h-7 px-3 text-xs gap-1 border-blue-400 text-blue-800 hover:bg-blue-50"
            onClick={() => {
              if (layout.selected.size !== 1) { toast({ title: "حدِّد فاتورة واحدة فقط للتعديل", variant: "destructive" }); return; }
              navigate(`/purchasing/invoices/${selectedRows[0].id}`);
            }}
            disabled={bulkBusy || layout.selected.size !== 1}
            title={layout.selected.size === 1 ? "فتح/تعديل الفاتورة المحدَّدة" : "حدِّد فاتورة واحدة فقط"}>
            <Pencil className="h-3.5 w-3.5" />
            تعديل
          </Button>
          <Button type="button" size="sm" variant="outline"
            className="h-7 px-3 text-xs gap-1 border-blue-400 text-blue-800 hover:bg-blue-50"
            onClick={() => {
              if (layout.selected.size !== 1) { toast({ title: "حدِّد فاتورة واحدة فقط للنسخ", variant: "destructive" }); return; }
              navigate(`/purchasing/invoices/new?from=${selectedRows[0].id}`);
            }}
            disabled={bulkBusy || layout.selected.size !== 1}
            title={layout.selected.size === 1 ? "إنشاء نسخة مماثلة من الفاتورة المحدَّدة" : "حدِّد فاتورة واحدة فقط"}>
            <Copy className="h-3.5 w-3.5" />
            نسخة مماثلة
          </Button>
          <Button type="button" size="sm" variant="outline"
            className="h-7 px-3 text-xs gap-1 border-amber-400 text-amber-800 hover:bg-amber-50"
            onClick={bulkUnpost}
            disabled={bulkBusy || selectedPosted.length === 0 || !isAdmin}
            title={!isAdmin
              ? "فك الترحيل متاح للمدير فقط"
              : selectedPosted.length === 0
                ? "لا توجد فواتير مرحَّلة ضمن المحدَّد"
                : `فك ترحيل ${selectedPosted.length} فاتورة`}>
            <Undo2 className="h-3.5 w-3.5" />
            فك الترحيل ({selectedPosted.length})
          </Button>
          <Button type="button" size="sm"
            className="h-7 px-3 text-xs gap-1 bg-rose-600 hover:bg-rose-500 text-white"
            onClick={bulkDelete}
            disabled={bulkBusy || selectedDeletable.length === 0}
            title={selectedDeletable.length === 0
              ? "لا يمكن حذف الفواتير المرحَّلة. فك الترحيل أولاً."
              : `حذف ${selectedDeletable.length} فاتورة (مسوّدة فقط)`}>
            <Trash2 className="h-3.5 w-3.5" />
            حذف ({selectedDeletable.length})
          </Button>
        </AuditGridBulkBar>
      </div>

      {/* Audit-grid table */}
      {(() => {
        const items: LegendItem[] = [
          { kind: "draft",     count: filteredInvoices.filter((i: any) => i.status === "draft").length },
          { kind: "posted",    count: filteredInvoices.filter((i: any) => i.status === "posted").length },
          { kind: "cancelled", count: filteredInvoices.filter((i: any) => i.status === "cancelled").length },
          { kind: "returned",  count: filteredInvoices.filter((i: any) => returnedInvoiceIds.has(Number(i.id))).length },
        ];
        return <DocColorLegend items={items} />;
      })()}

      <div className="border border-slate-300 rounded-b-lg bg-white overflow-hidden shadow-sm -mt-3">
        <div className="overflow-x-auto" style={{ maxHeight: "calc(100vh - 320px)" }}>
          {isLoading ? (
            <div className="p-12 text-center text-muted-foreground text-sm">{t("common.loading")}</div>
          ) : filteredInvoices.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground text-sm">
              {invoices.length === 0 ? t("purchasingPages.purchaseInvoices.noInvoices") : "لا توجد فواتير ضمن التصفية الحالية"}
            </div>
          ) : (
            <table ref={tableRef} className="w-full text-[11px] border-collapse" dir={isRtl ? "rtl" : "ltr"}>
              <colgroup>
                {visibleColumns.map((col) => (
                  <col key={col.key} data-col-key={col.key}
                    style={colWidths[col.key] ? { width: `${colWidths[col.key]}px` } : undefined} />
                ))}
              </colgroup>
              <thead className="sticky top-0 z-10">
                <tr className="bg-gradient-to-b from-slate-100 to-slate-200 text-slate-700">
                  {visibleColumns.map((col, idx) => (
                    <th key={col.key} data-col-key={col.key}
                      style={colWidths[col.key] ? { width: `${colWidths[col.key]}px`, minWidth: `${colWidths[col.key]}px` } : undefined}
                      className="relative px-2 py-1.5 border border-slate-300 text-center font-semibold whitespace-nowrap text-[10.5px]">
                      {col.key === "_sel" ? (
                        <HeaderSelectCheckbox
                          allSelected={isAllSelected(allFilteredIds)}
                          someSelected={isSomeSelected(allFilteredIds)}
                          onToggle={() => toggleAll(allFilteredIds)}
                          disabled={allFilteredIds.length === 0 || bulkBusy}
                        />
                      ) : (
                          <span className="inline-flex items-center justify-center gap-1">
                            <span>{col.label}</span>
                            {col.type !== "none" && (
                              <AdvFilterPopover colLabel={col.label || col.key} colType={col.type} value={colAdv[col.key]} active={isAdvActive(colAdv[col.key])} onApply={v => setColAdv(prev => ({ ...prev, [col.key]: v }))} onClear={() => clearColAdv(col.key)} />
                            )}
                          </span>
                        )}
                      {col.key !== "_sel" && (
                        <span {...gripProps(col.key, idx)}
                          className="print:hidden absolute top-0 bottom-0 w-2 cursor-col-resize select-none touch-none hover:bg-blue-400/60 active:bg-blue-500/80 z-20"
                          style={{ insetInlineEnd: -4 }}
                        />
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pagedInvoices.map((inv: any, idx: number) => {
                  const absIdx = pageSize === 0 ? idx : (safePage - 1) * pageSize + idx;
                  const stCls = STATUS_CLS[inv.status] ?? STATUS_CLS.draft;
                  const rid = Number(inv.id);
                  const isSel = isSelected(rid);
                  const renderCell = (col: ColDef) => {
                    switch (col.key) {
                      case "_sel":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            <RowSelectCheckbox
                              checked={isSel}
                              onToggle={() => toggleRow(rid)}
                              ariaLabel={`تحديد الفاتورة ${inv.docNumber ?? `PI-${rid}`}`}
                            />
                          </td>
                        );
                      case "_idx":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center text-slate-500 font-mono">{absIdx + 1}</td>;
                      case "doc":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 font-mono font-semibold text-primary text-center">{inv.docNumber ?? `PI-${inv.id}`}</td>;
                      case "date":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center whitespace-nowrap text-slate-600">{inv.invoiceDate}</td>;
                      case "supplier":
                        return <td key={col.key} className={cn("px-2 py-1 border border-slate-200 truncate", colWidths.supplier ? "" : "max-w-[200px]")} title={supMap[inv.supplierId] ?? ""}>{supMap[inv.supplierId] ?? "—"}</td>;
                      case "paytype":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center text-slate-600">{paymentTypeLabel(inv.paymentType)}</td>;
                      case "currency":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center text-slate-500 font-mono">{inv.currencyCode}</td>;
                      case "subtotal":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-end font-mono text-slate-800">{fmt(inv.subtotal)}</td>;
                      case "vat":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-end font-mono text-amber-700">{fmt(inv.vatAmount)}</td>;
                      case "total":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-end font-mono font-bold text-slate-900">{fmt(inv.totalAmount)}</td>;
                      case "paystatus":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            {inv.paymentSettlement ? (
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); navigate(`/cash/payment-vouchers/${inv.paymentSettlement.voucherId}`); }}
                                className={cn(
                                  "inline-flex items-center gap-1 text-[10px] rounded-full px-2 py-0.5 font-medium border transition-colors",
                                  inv.paymentSettlement.paymentType === "bank"
                                    ? "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100"
                                    : "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100",
                                  inv.paymentSettlement.status !== "posted" && "opacity-70",
                                )}
                                title={t("purchasingPages.purchaseInvoices.openPaymentVoucher") + ` — ${inv.paymentSettlement.code} • ${fmt(inv.paymentSettlement.amount)}`}
                                data-testid={`pay-status-${inv.id}`}
                              >
                                {inv.paymentSettlement.paymentType === "bank"
                                  ? t("purchasingPages.purchaseInvoices.paidViaBank")
                                  : t("purchasingPages.purchaseInvoices.paidViaCash")}
                                <span className="font-mono opacity-80">• {inv.paymentSettlement.code}</span>
                              </button>
                            ) : <span className="text-muted-foreground text-[10px]">—</span>}
                          </td>
                        );
                      case "journal":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            {inv.journalEntryId ? (
                              <button type="button"
                                onClick={(e) => { e.stopPropagation(); navigate(`/accounting/journals/${inv.journalEntryId}?tab=lines`); }}
                                className="font-mono text-[10px] text-blue-600 hover:underline">
                                JE-{inv.journalEntryId}
                              </button>
                            ) : <span className="text-muted-foreground text-[10px]">—</span>}
                          </td>
                        );
                      case "status":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            <span className={cn("inline-flex items-center text-[10px] rounded px-1.5 py-0.5 font-medium border", stCls)}>{statusLabel(inv.status)}</span>
                          </td>
                        );
                      case "createdBy":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            {inv.createdByName ? (
                              <span className="inline-flex items-center gap-1 text-[10px] rounded-full px-1.5 py-0.5 font-medium border bg-emerald-50 text-emerald-700 border-emerald-200">
                                <User className="h-2.5 w-2.5" />{inv.createdByName}
                              </span>
                            ) : <span className="text-slate-400 text-xs">—</span>}
                          </td>
                        );
                      case "postedBy":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            {inv.postedByName ? (
                              <span className="inline-flex items-center gap-1 text-[10px] rounded-full px-1.5 py-0.5 font-medium border bg-blue-50 text-blue-700 border-blue-200">
                                <User className="h-2.5 w-2.5" />{inv.postedByName}
                              </span>
                            ) : <span className="text-slate-400 text-xs">—</span>}
                          </td>
                        );
                      case "_act":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            <div className="flex items-center justify-center gap-0.5">
                              <Button variant="ghost" size="icon" className="h-6 w-6 text-slate-700 hover:text-primary hover:bg-muted"
                                title={t("purchasingPages.purchaseInvoices.tooltips.print")}
                                onClick={(e) => { e.stopPropagation(); openPrint(inv); }}>
                                <Printer className="h-3.5 w-3.5" />
                              </Button>
                              {inv.status === "posted" && (
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-orange-600 hover:text-orange-700 hover:bg-orange-50"
                                  title={t("purchasingPages.purchaseInvoices.tooltips.createReturn")}
                                  onClick={(e) => { e.stopPropagation(); navigate(`/purchasing/returns?fromInvoice=${inv.id}`); }}>
                                  <RotateCcw className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              {inv.status === "posted" && (
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                                  title={t("purchasingPages.purchaseInvoices.tooltips.unpost")}
                                  onClick={(e) => { e.stopPropagation(); if (confirm(t("purchasingPages.purchaseInvoices.confirms.unpost"))) unpostMut.mutate(inv.id); }}>
                                  <Undo2 className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              <Button variant="ghost" size="icon" className="h-6 w-6"
                                title={t("purchasingPages.purchaseInvoices.tooltips.viewEdit")}
                                onClick={(e) => { e.stopPropagation(); navigate(`/purchasing/invoices/${inv.id}`); }}>
                                <Eye className="h-3.5 w-3.5" />
                              </Button>
                              <Button variant="ghost" size="icon" className="h-6 w-6 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                                title={t("purchasingPages.purchaseInvoices.tooltips.duplicate")}
                                onClick={(e) => { e.stopPropagation(); navigate(`/purchasing/invoices/new?from=${inv.id}`); }}>
                                <Copy className="h-3.5 w-3.5" />
                              </Button>
                              {inv.status === "draft" && (
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-emerald-700 hover:bg-emerald-50"
                                  title={t("purchasingPages.purchaseInvoices.tooltips.post")}
                                  onClick={(e) => { e.stopPropagation(); if (confirm(t("purchasingPages.purchaseInvoices.confirms.post"))) postMut.mutate(inv.id); }}>
                                  <CheckCircle2 className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              {inv.status === "draft" && (
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                                  onClick={(e) => { e.stopPropagation(); if (confirm(t("purchasingPages.purchaseInvoices.confirms.delete"))) deleteMut.mutate(inv.id); }}>
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              )}
                            </div>
                          </td>
                        );
                      default:
                        return <td key={col.key} className="px-2 py-1 border border-slate-200" />;
                    }
                  };
                  const hasReturn = returnedInvoiceIds.has(Number(inv.id));
                  return (
                    <tr key={inv.id}
                      data-testid={`row-purchase-invoice-${inv.id}`}
                      data-status={inv.status}
                      data-has-return={hasReturn ? "1" : "0"}
                      className={cn(
                        "transition-colors cursor-pointer",
                        isSel ? SEL_TONE : rowToneFor({ status: inv.status, hasReturn }),
                      )}
                      onClick={(e) => {
                        const tag = (e.target as HTMLElement).tagName;
                        if (tag === "BUTTON" || tag === "INPUT" || tag === "A" || (e.target as HTMLElement).closest("button,a,input")) return;
                        toggleRow(rid);
                      }}
                      onDoubleClick={() => navigate(`/purchasing/invoices/${inv.id}`)}
                      title={buildToneTooltip({ status: inv.status, hasReturn })}
                    >
                      {visibleColumns.map(renderCell)}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="sticky bottom-0">
                <tr className={cn("text-[11px] font-semibold", footerTheme.bg, footerTheme.text)}>
                  {visibleColumns.map((col, i) => {
                    if (col.key === "_sel") {
                      return <td key={col.key} className={cn("px-2 py-2 border", footerTheme.border)} />;
                    }
                    if (i === 1) {
                      return <td key={col.key} className={cn("px-2 py-2 border text-end whitespace-nowrap", footerTheme.border)}>الإجمالي:</td>;
                    }
                    if (col.key === "subtotal") {
                      return <td key={col.key} className={cn("px-2 py-2 border text-end font-mono", footerTheme.border)}>{fmt(totals.subtotal)}</td>;
                    }
                    if (col.key === "vat") {
                      return <td key={col.key} className={cn("px-2 py-2 border text-end font-mono", footerTheme.border)}>{fmt(totals.vat)}</td>;
                    }
                    if (col.key === "total") {
                      return <td key={col.key} className={cn("px-2 py-2 border text-end font-mono", footerTheme.border)}>{fmt(totals.total)}</td>;
                    }
                    return <td key={col.key} className={cn("px-2 py-2 border", footerTheme.border)} />;
                  })}
                </tr>
              </tfoot>
            </table>
          )}
        </div>

        <AuditGridPagination
          layout={layout}
          totalRows={filteredInvoices.length}
          pageStart={pageStart}
          pageEnd={pageEnd}
          totalPages={totalPages}
          unitLabel="فاتورة"
        />
      </div>

      <PurchasePrintModal open={!!printData} onClose={() => setPrintData(null)} data={printData} />
    </div>
  );
}
