import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useFormatters } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Plus, ClipboardList, Eye, Trash2, CheckCircle, XCircle, FileCheck2, Printer, Copy, Pencil,
  FileSpreadsheet, FileDown, X, Loader2, RotateCcw,
} from "lucide-react";
import { BulkPrintMenu } from "@/lib/bulkPrint";
import * as XLSX from "xlsx";
import { cn } from "@/lib/utils";
import {
  downloadCsv, matchCol, useAuditGridLayout, useColumnResize,
} from "@/lib/auditGridLayout";
import {
  AuditGridBulkBar, AuditGridPagination, ColumnReorderPopover,
  FooterColorPicker, HeaderColorPicker, HeaderSelectCheckbox, RowSelectCheckbox,
} from "@/components/auditGrid/AuditGridControls";
import {
  rowToneFor, SEL_TONE, DocColorLegend, buildToneTooltip, type LegendItem,
} from "@/lib/docRowTone";
import { safeLogoSrc } from "@/lib/export";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const STATUS: Record<string, { labelKey: string; cls: string }> = {
  draft:     { labelKey: "status.draft",     cls: "bg-amber-50 text-amber-700 border-amber-200" },
  confirmed: { labelKey: "status.confirmed", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  cancelled: { labelKey: "status.cancelled", cls: "bg-muted text-muted-foreground border-border" },
  converted: { labelKey: "status.converted", cls: "bg-green-50 text-green-700 border-green-200" },
};

export default function PurchaseOrders() {
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

  const [tableSearch, setTableSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "draft" | "confirmed" | "converted" | "cancelled">("all");
  const [bulkBusy, setBulkBusy] = useState(false);

  const { data: orders = [], isLoading } = useQuery<any[]>({
    queryKey: ["purchase-orders", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/purchasing/purchase-orders?companyId=${cid}` : `${API}/api/purchasing/purchase-orders`;
      const res = await fetch(url, { headers: authH }); return res.json();
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

  const invalidate = () => qc.invalidateQueries({ queryKey: ["purchase-orders"] });

  const statusMut = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) => {
      const res = await fetch(`${API}/api/purchasing/purchase-orders/${id}/status`, {
        method: "PATCH", headers, body: JSON.stringify({ status }),
      });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || "تعذر تحديث الحالة"); }
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: t("purchasingPages.purchaseOrders.toasts.statusUpdated") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const convertMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/purchasing/purchase-orders/${id}/convert`, { method: "POST", headers });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || "تعذر التحويل"); }
      return res.json();
    },
    onSuccess: (j: any) => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["purchase-invoices"] });
      toast({ title: t("purchasingPages.purchaseOrders.toasts.converted"), description: `INV-${j.invoiceId}` });
      navigate(`/purchasing/invoices/${j.invoiceId}`);
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/purchasing/purchase-orders/${id}`, { method: "DELETE", headers });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || "تعذر الحذف"); }
    },
    onSuccess: () => { invalidate(); toast({ title: t("purchasingPages.purchaseOrders.toasts.deleted") }); },
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

  const supName = (s: any) => isRtl ? (s?.nameAr ?? s?.nameEn ?? "") : (s?.nameEn ?? s?.nameAr ?? "");
  const supMap: Record<number, string> = useMemo(
    () => Object.fromEntries((suppliers as any[]).map((s: any) => [s.id, supName(s)])),
    [suppliers, isRtl],
  );

  const statusLabel = (s: string) => s === "all" ? t("common.all") : t(STATUS[s]?.labelKey ?? "status.draft");
  const paymentTypeLabel = (p: string) =>
    p === "cash" ? t("purchasingPages.purchaseOrders.paymentCash")
    : p === "bank" ? t("purchasingPages.purchaseOrders.paymentBank")
    : t("purchasingPages.purchaseOrders.paymentCredit");

  type ColType = "text" | "num" | "none";
  interface ColDef { key: string; label: string; type: ColType; valueOf: (r: any) => string | number; }
  const COLUMNS: ColDef[] = [
    { key: "_sel",     label: "",                                                  type: "none", valueOf: () => "" },
    { key: "_idx",     label: "#",                                                 type: "none", valueOf: () => "" },
    { key: "doc",      label: t("purchasingPages.purchaseOrders.cols.number"),     type: "text", valueOf: (r) => r.docNumber ?? `PO-${r.id}` },
    { key: "date",     label: t("purchasingPages.purchaseOrders.cols.date"),       type: "text", valueOf: (r) => r.orderDate ?? "" },
    { key: "delivery", label: t("purchasingPages.purchaseOrders.cols.expectedDelivery"), type: "text", valueOf: (r) => r.expectedDeliveryDate ?? "" },
    { key: "supplier", label: t("purchasingPages.purchaseOrders.cols.supplier"),   type: "text", valueOf: (r) => supMap[r.supplierId] ?? "" },
    { key: "paytype",  label: t("purchasingPages.purchaseOrders.cols.paymentType"),type: "text", valueOf: (r) => paymentTypeLabel(r.paymentType) },
    { key: "currency", label: t("purchasingPages.purchaseOrders.cols.currency"),   type: "text", valueOf: (r) => r.currencyCode ?? "" },
    { key: "subtotal", label: t("purchasingPages.purchaseOrders.cols.subtotal"),   type: "num",  valueOf: (r) => Number(r.subtotal ?? 0) },
    { key: "vat",      label: t("purchasingPages.purchaseOrders.cols.vat"),        type: "num",  valueOf: (r) => Number(r.vatAmount ?? 0) },
    { key: "total",    label: t("purchasingPages.purchaseOrders.cols.total"),      type: "num",  valueOf: (r) => Number(r.totalAmount ?? 0) },
    { key: "invoice",  label: t("purchasingPages.purchaseOrders.cols.invoice"),    type: "text", valueOf: (r) => r.convertedInvoiceId ? `INV-${r.convertedInvoiceId}` : "" },
    { key: "status",   label: t("purchasingPages.purchaseOrders.cols.status"),     type: "text", valueOf: (r) => statusLabel(r.status) },
    { key: "_act",     label: t("purchasingPages.purchaseOrders.cols.actions"),    type: "none", valueOf: () => "" },
  ];
  const DATA_KEYS = COLUMNS.filter(c => c.key !== "_sel" && c.key !== "_idx" && c.key !== "_act").map(c => c.key);
  const ALL_KEYS  = COLUMNS.map(c => c.key);

  const layout = useAuditGridLayout({
    screenSlug: "purchaseOrdersAuditGrid",
    cid,
    dataKeys: DATA_KEYS,
    allColKeys: ALL_KEYS,
  });
  const { tableRef, gripProps } = useColumnResize(layout.setColWidths);
  const { theme, footerTheme, colWidths, colFilters, setColFilter, clearColFilters,
          isSelected, toggleRow, toggleAll, isAllSelected, isSomeSelected, clearSelection } = layout;

  const filteredOrders = useMemo(() => {
    const q = tableSearch.trim().toLowerCase();
    return (orders as any[]).filter((o) => {
      if (statusFilter !== "all" && o.status !== statusFilter) return false;
      if (q) {
        const hay = [
          o.docNumber, `PO-${o.id}`, o.orderDate, supMap[o.supplierId],
          o.currencyCode, o.notes,
        ].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      for (const col of COLUMNS) {
        const f = colFilters[col.key];
        if (!f) continue;
        if (!matchCol(col.valueOf(o), f, col.type)) return false;
      }
      return true;
    });
  }, [orders, tableSearch, statusFilter, colFilters, supMap]);

  const { pageSize, page, setPage } = layout;
  const totalPages = pageSize === 0 ? 1 : Math.max(1, Math.ceil(filteredOrders.length / pageSize));
  const safePage = Math.min(page, totalPages);
  useEffect(() => { if (safePage !== page) setPage(safePage); }, [safePage, page, setPage]);
  const pagedOrders = useMemo(
    () => pageSize === 0 ? filteredOrders : filteredOrders.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filteredOrders, pageSize, safePage],
  );
  const pageStart = filteredOrders.length === 0 ? 0 : pageSize === 0 ? 1 : (safePage - 1) * pageSize + 1;
  const pageEnd   = pageSize === 0 ? filteredOrders.length : Math.min(safePage * pageSize, filteredOrders.length);

  const totals = useMemo(() => filteredOrders.reduce(
    (a, r: any) => {
      a.subtotal += Number(r.subtotal ?? 0);
      a.vat      += Number(r.vatAmount ?? 0);
      a.total    += Number(r.totalAmount ?? 0);
      return a;
    },
    { subtotal: 0, vat: 0, total: 0 },
  ), [filteredOrders]);

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

  const buildListHtml = (source: any[] = filteredOrders) => {
    const today = new Date().toLocaleDateString("ar-SA");
    const sumSub = source.reduce((a, r: any) => a + Number(r.subtotal ?? 0), 0);
    const sumVat = source.reduce((a, r: any) => a + Number(r.vatAmount ?? 0), 0);
    const sumTot = source.reduce((a, r: any) => a + Number(r.totalAmount ?? 0), 0);
    const logoHtml = safeLogo
      ? `<div style="margin-bottom:6px;"><img src="${safeLogo}" alt="" style="max-height:54px;max-width:170px;object-fit:contain;display:block;margin:0 auto;" /></div>` : "";
    const companyHtml = user?.company?.nameAr
      ? `<div style="font-size:13px;font-weight:600;color:#1e3a8a;margin-bottom:2px;">${escapeHtml(user.company.nameAr)}</div>` : "";
    return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${escapeHtml(t("purchasingPages.purchaseOrders.title"))}</title>
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
<div class="h">${logoHtml}${companyHtml}<h1>${escapeHtml(t("purchasingPages.purchaseOrders.title"))}</h1>
<div class="meta">تاريخ التقرير: ${today} — عدد الأوامر: ${source.length}</div></div>
<div class="totals">
  <span>إجمالي المجموع: <b>${sumSub.toFixed(2)}</b></span>
  <span>إجمالي الضريبة: <b>${sumVat.toFixed(2)}</b></span>
  <span>الإجمالي: <b>${sumTot.toFixed(2)}</b></span>
</div>
<table><thead><tr>
  <th>#</th><th>رقم الأمر</th><th>التاريخ</th><th>تاريخ التسليم</th><th>المورد</th>
  <th>طريقة الدفع</th><th>العملة</th><th>المجموع</th><th>الضريبة</th><th>الإجمالي</th><th>الحالة</th>
</tr></thead><tbody>
${source.map((r: any, i: number) => `<tr>
  <td>${i + 1}</td>
  <td>${escapeHtml(r.docNumber ?? `PO-${r.id}`)}</td>
  <td>${escapeHtml(r.orderDate ?? "")}</td>
  <td>${escapeHtml(r.expectedDeliveryDate ?? "")}</td>
  <td>${escapeHtml(supMap[r.supplierId] ?? "")}</td>
  <td>${escapeHtml(paymentTypeLabel(r.paymentType))}</td>
  <td>${escapeHtml(r.currencyCode ?? "")}</td>
  <td class="num">${Number(r.subtotal ?? 0).toFixed(2)}</td>
  <td class="num">${Number(r.vatAmount ?? 0).toFixed(2)}</td>
  <td class="num">${Number(r.totalAmount ?? 0).toFixed(2)}</td>
  <td>${escapeHtml(statusLabel(r.status))}</td>
</tr>`).join("")}
</tbody><tfoot><tr>
  <td colspan="7">الإجمالي العام</td>
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
      const docNo  = d.docNumber ?? `PO-${d.id}`;
      const linesHtml = lines.length === 0
        ? `<tr><td colspan="6" style="text-align:center;color:#6b7280;padding:14px;">لا توجد بنود لهذا الأمر.</td></tr>`
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
          <span class="badge b-doc">رقم الأمر: ${escapeHtml(docNo)}</span>
          <span class="badge b-date">التاريخ: ${escapeHtml(d.orderDate ?? "")}</span>
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
    return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>طباعة أوامر الشراء المحدّدة</title>
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
.b-status.s-confirmed{background:#dbeafe;border-color:#60a5fa;color:#1e3a8a;}
.b-status.s-converted{background:#d1fae5;border-color:#34d399;color:#065f46;}
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
<div class="h">${logoHtml}${companyHtml}<h1>أوامر الشراء المحدّدة</h1>
<div class="meta">تاريخ التقرير: ${today} — عدد الأوامر: ${docs.length}</div></div>
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
    if (filteredOrders.length === 0) { toast({ title: "لا يوجد بيانات للتصدير", variant: "destructive" }); return; }
    const rows = filteredOrders.map((r: any) => ({
      "رقم الأمر": r.docNumber ?? `PO-${r.id}`,
      "التاريخ": r.orderDate ?? "",
      "تاريخ التسليم": r.expectedDeliveryDate ?? "",
      "المورد": supMap[r.supplierId] ?? "",
      "طريقة الدفع": paymentTypeLabel(r.paymentType),
      "العملة": r.currencyCode ?? "",
      "المجموع": Number(r.subtotal ?? 0).toFixed(2),
      "الضريبة": Number(r.vatAmount ?? 0).toFixed(2),
      "الإجمالي": Number(r.totalAmount ?? 0).toFixed(2),
      "الحالة": statusLabel(r.status),
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 22 }, { wch: 12 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "أوامر الشراء");
    XLSX.writeFile(wb, `purchase-orders-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };


  function exportCsv() {
    if (filteredOrders.length === 0) { toast({ title: "لا يوجد بيانات للتصدير", variant: "destructive" }); return; }
    const header = ["#", ...visibleColumns.filter((c) => c.key !== "_sel" && c.key !== "_idx" && c.key !== "_act").map((c) => c.label)];
    const rows = filteredOrders.map((r: any, i: number) => [
      i + 1,
      ...visibleColumns
        .filter((c) => c.key !== "_sel" && c.key !== "_idx" && c.key !== "_act")
        .map((c) => {
          const v = c.valueOf(r);
          return c.type === "num" ? Number(v).toFixed(2) : String(v);
        }),
    ]);
    downloadCsv(`purchase-orders-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
    toast({ title: "تم تصدير ملف CSV بنجاح" });
  }

  const allFilteredIds: number[] = useMemo(
    () => filteredOrders.map((r: any) => Number(r.id)),
    [filteredOrders],
  );
  const selectedRows = useMemo(
    () => (orders as any[]).filter((r) => isSelected(Number(r.id))),
    [orders, isSelected],
  );
  const selectedConfirmable   = selectedRows.filter((r) => r.status === "draft");
  const selectedUnconfirmable = selectedRows.filter((r) => r.status === "confirmed" && !r.convertedInvoiceId);
  const selectedCancellable   = selectedRows.filter((r) => r.status === "draft");
  const selectedDeletable     = selectedRows.filter((r) => r.status !== "converted" && r.status !== "cancelled");

  async function bulkConfirm() {
    const ids = selectedConfirmable.map((r) => Number(r.id));
    if (ids.length === 0) { toast({ title: "لا توجد مسوّدات ضمن المحدَّد", variant: "destructive" }); return; }
    setBulkBusy(true);
    try {
      const { ok, failed } = await bulkRun(ids, async (id) => {
        const res = await fetch(`${API}/api/purchasing/purchase-orders/${id}/status`, { method: "PATCH", headers, body: JSON.stringify({ status: "confirmed" }) });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error ?? `HTTP ${res.status}`); }
      });
      invalidate();
      if (failed.length === 0) toast({ title: `تم تأكيد ${ok} أمر شراء` });
      else toast({ title: `تأكيد: ${ok} نجح، ${failed.length} فشل`, description: failed.slice(0, 3).map(f => f.error).join("\n"), variant: "destructive" });
      clearSelection();
    } finally { setBulkBusy(false); }
  }

  async function bulkUnconfirm() {
    const ids = selectedUnconfirmable.map((r) => Number(r.id));
    if (ids.length === 0) { toast({ title: t("purchasingPages.purchaseOrders.bulk.noUnconfirmable"), variant: "destructive" }); return; }
    if (!window.confirm(t("purchasingPages.purchaseOrders.confirms.unconfirm", { count: ids.length }))) return;
    setBulkBusy(true);
    try {
      const { ok, failed } = await bulkRun(ids, async (id) => {
        const res = await fetch(`${API}/api/purchasing/purchase-orders/${id}/status`, { method: "PATCH", headers, body: JSON.stringify({ status: "draft" }) });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error ?? `HTTP ${res.status}`); }
      });
      invalidate();
      if (failed.length === 0) toast({ title: t("purchasingPages.purchaseOrders.toasts.unconfirmedBulk", { count: ok }) });
      else toast({ title: t("purchasingPages.purchaseOrders.toasts.unconfirmedBulkPartial", { ok, failed: failed.length }), description: failed.slice(0, 3).map(f => f.error).join("\n"), variant: "destructive" });
      clearSelection();
    } finally { setBulkBusy(false); }
  }

  async function bulkCancel() {
    const ids = selectedCancellable.map((r) => Number(r.id));
    if (ids.length === 0) { toast({ title: "لا توجد أوامر قابلة للإلغاء", variant: "destructive" }); return; }
    if (!window.confirm(`إلغاء ${ids.length} أمر شراء؟`)) return;
    setBulkBusy(true);
    try {
      const { ok, failed } = await bulkRun(ids, async (id) => {
        const res = await fetch(`${API}/api/purchasing/purchase-orders/${id}/status`, { method: "PATCH", headers, body: JSON.stringify({ status: "cancelled" }) });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error ?? `HTTP ${res.status}`); }
      });
      invalidate();
      if (failed.length === 0) toast({ title: `تم إلغاء ${ok} أمر` });
      else toast({ title: `إلغاء: ${ok} نجح، ${failed.length} فشل`, description: failed.slice(0, 3).map(f => f.error).join("\n"), variant: "destructive" });
      clearSelection();
    } finally { setBulkBusy(false); }
  }

  async function bulkDelete() {
    const ids = selectedDeletable.map((r) => Number(r.id));
    if (ids.length === 0) { toast({ title: "لا يمكن حذف هذه الأوامر", variant: "destructive" }); return; }
    if (!window.confirm(`حذف ${ids.length} أمر نهائياً؟ لا يمكن التراجع عن هذا الإجراء.`)) return;
    setBulkBusy(true);
    try {
      const { ok, failed } = await bulkRun(ids, async (id) => {
        const res = await fetch(`${API}/api/purchasing/purchase-orders/${id}`, { method: "DELETE", headers });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error ?? `HTTP ${res.status}`); }
      });
      invalidate();
      if (failed.length === 0) toast({ title: `تم حذف ${ok} أمر` });
      else toast({ title: `حذف: ${ok} نجح، ${failed.length} فشل`, description: failed.slice(0, 3).map(f => f.error).join("\n"), variant: "destructive" });
      clearSelection();
    } finally { setBulkBusy(false); }
  }

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ClipboardList className="h-6 w-6 text-primary" />{t("purchasingPages.purchaseOrders.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t("purchasingPages.purchaseOrders.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2 print:hidden">
          <Button
            onClick={() => navigate("/purchasing/orders/new")}
            className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm"
          >
            <Plus className="h-4 w-4" />
            {t("purchasingPages.purchaseOrders.newOrder")}
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

      <div className={cn("rounded-t-lg overflow-hidden border shadow-sm transition-colors", theme.border)}>
        <div className={cn("px-3 py-2 flex items-center gap-2 flex-wrap transition-colors", theme.bar, theme.text)} dir={isRtl ? "rtl" : "ltr"}>
          <div className={cn("flex-1 text-sm font-bold tracking-wide flex items-center gap-2", theme.text)}>
            <ClipboardList className="h-4 w-4 opacity-90" />
            جرد أوامر الشراء
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
          <div className="flex gap-1">
            {(["all", "draft", "confirmed", "converted", "cancelled"] as const).map((s) => (
              <button key={s} type="button" onClick={() => setStatusFilter(s)}
                className={cn(
                  "px-2 py-1 rounded text-[11px] font-medium border transition-colors",
                  statusFilter === s
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100",
                )}>
                {statusLabel(s)}
              </button>
            ))}
          </div>
          {Object.values(colFilters).some((v) => v) && (
            <Button type="button" size="sm" variant="ghost"
              className="h-7 px-2 text-xs text-rose-700 hover:bg-rose-50"
              onClick={clearColFilters} title="مسح فلاتر الأعمدة">
              <X className="h-3.5 w-3.5 me-1" />
              مسح فلاتر الأعمدة
            </Button>
          )}
          <div className="flex-1" />
          <span className="text-slate-700 font-medium">
            {filteredOrders.length} أمر
            {filteredOrders.length !== orders.length && <span className="text-slate-400"> / {orders.length}</span>}
          </span>
        </div>
        <AuditGridBulkBar count={layout.selected.size} onClear={clearSelection} busy={bulkBusy}>
          <BulkPrintMenu
            selectedIds={Array.from(layout.selected).map(Number)}
            filteredDocs={filteredOrders as any[]}
            adapter={{
              kind: "purchase-order",
              title: t("purchasingPages.purchaseOrders.title"),
              docTypeLabel: "أمر شراء",
              partyLabel: "المورد",
              getHeader: (d: any) => ({
                docNo: d.docNumber ?? `PO-${d.id}`,
                date: d.orderDate ?? "",
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
              const res = await fetch(`${API}/api/purchasing/purchase-orders/${id}${cid ? `?companyId=${cid}` : ""}`, { headers: authH });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              return res.json();
            }}
            onPopupBlocked={() => toast({ title: "تم حظر النافذة المنبثقة", description: "الرجاء السماح بالنوافذ المنبثقة للطباعة", variant: "destructive" })}
            onFetchFailed={(n) => toast({ title: `تعذّر تحميل ${n} أمر شراء بكامل بنوده`, variant: "destructive" })}
            primaryLabel="طباعة"
          />
          <Button type="button" size="sm"
            className="h-7 px-3 text-xs gap-1 bg-emerald-700 hover:bg-emerald-600 text-white"
            onClick={bulkConfirm}
            disabled={bulkBusy || selectedConfirmable.length === 0}
            title={selectedConfirmable.length === 0 ? "لا توجد مسوّدات ضمن المحدَّد" : `تأكيد ${selectedConfirmable.length} أمر`}>
            {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5" />}
            تأكيد ({selectedConfirmable.length})
          </Button>
          <Button type="button" size="sm" variant="outline"
            className="h-7 px-3 text-xs gap-1 border-orange-400 text-orange-800 hover:bg-orange-50"
            onClick={bulkUnconfirm}
            disabled={bulkBusy || selectedUnconfirmable.length === 0}
            title={selectedUnconfirmable.length === 0 ? t("purchasingPages.purchaseOrders.bulk.noUnconfirmable") : t("purchasingPages.purchaseOrders.tooltips.unconfirm")}>
            <RotateCcw className="h-3.5 w-3.5" />
            {t("purchasingPages.purchaseOrders.bulk.unconfirm")} ({selectedUnconfirmable.length})
          </Button>
          <Button type="button" size="sm" variant="outline"
            className="h-7 px-3 text-xs gap-1 border-blue-400 text-blue-800 hover:bg-blue-50"
            onClick={() => {
              if (layout.selected.size !== 1) { toast({ title: "حدِّد أمرًا واحدًا فقط للتعديل", variant: "destructive" }); return; }
              navigate(`/purchasing/orders/${Array.from(layout.selected)[0]}`);
            }}
            disabled={bulkBusy || layout.selected.size !== 1}
            title={layout.selected.size === 1 ? "فتح/تعديل الأمر المحدَّد" : "حدِّد أمرًا واحدًا فقط"}>
            <Pencil className="h-3.5 w-3.5" />
            تعديل
          </Button>
          <Button type="button" size="sm" variant="outline"
            className="h-7 px-3 text-xs gap-1 border-blue-400 text-blue-800 hover:bg-blue-50"
            onClick={() => {
              if (layout.selected.size !== 1) { toast({ title: "حدِّد أمرًا واحدًا فقط للنسخ", variant: "destructive" }); return; }
              navigate(`/purchasing/orders/new?from=${Array.from(layout.selected)[0]}`);
            }}
            disabled={bulkBusy || layout.selected.size !== 1}
            title={layout.selected.size === 1 ? "إنشاء نسخة مماثلة من الأمر المحدَّد" : "حدِّد أمرًا واحدًا فقط"}>
            <Copy className="h-3.5 w-3.5" />
            نسخة مماثلة
          </Button>
          <Button type="button" size="sm" variant="outline"
            className="h-7 px-3 text-xs gap-1 border-amber-400 text-amber-800 hover:bg-amber-50"
            onClick={bulkCancel}
            disabled={bulkBusy || selectedCancellable.length === 0}
            title={selectedCancellable.length === 0 ? "الإلغاء متاح للمسوّدات فقط" : `إلغاء ${selectedCancellable.length} أمر`}>
            <XCircle className="h-3.5 w-3.5" />
            إلغاء ({selectedCancellable.length})
          </Button>
          <Button type="button" size="sm"
            className="h-7 px-3 text-xs gap-1 bg-rose-600 hover:bg-rose-500 text-white"
            onClick={bulkDelete}
            disabled={bulkBusy || selectedDeletable.length === 0}
            title={selectedDeletable.length === 0
              ? "لا يمكن حذف الأوامر المحوّلة أو الملغاة"
              : `حذف ${selectedDeletable.length} أمر`}>
            <Trash2 className="h-3.5 w-3.5" />
            حذف ({selectedDeletable.length})
          </Button>
        </AuditGridBulkBar>
      </div>

      {(() => {
        const items: LegendItem[] = [
          { kind: "draft",      count: filteredOrders.filter((o: any) => o.status === "draft").length },
          { kind: "confirmed",  count: filteredOrders.filter((o: any) => o.status === "confirmed" && !o.convertedInvoiceId).length },
          { kind: "converted",  count: filteredOrders.filter((o: any) => !!o.convertedInvoiceId).length },
          { kind: "cancelled",  count: filteredOrders.filter((o: any) => o.status === "cancelled").length },
        ];
        return <DocColorLegend items={items} />;
      })()}

      <div className="border border-slate-300 rounded-b-lg bg-white overflow-hidden shadow-sm -mt-3">
        <div className="overflow-x-auto" style={{ maxHeight: "calc(100vh - 320px)" }}>
          {isLoading ? (
            <div className="p-12 text-center text-muted-foreground text-sm">{t("common.loading")}</div>
          ) : filteredOrders.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground text-sm">
              {orders.length === 0 ? t("purchasingPages.purchaseOrders.noOrders") : "لا توجد أوامر ضمن التصفية الحالية"}
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
                      ) : col.label}
                      {col.key !== "_sel" && (
                        <span {...gripProps(col.key, idx)}
                          className="print:hidden absolute top-0 bottom-0 w-2 cursor-col-resize select-none touch-none hover:bg-blue-400/60 active:bg-blue-500/80 z-20"
                          style={{ insetInlineEnd: -4 }}
                        />
                      )}
                    </th>
                  ))}
                </tr>
                <tr className="bg-amber-50/80 border-b border-amber-200">
                  {visibleColumns.map((col) => (
                    <th key={col.key} className="px-1 py-1 border border-slate-200 text-center">
                      {col.type === "none" ? null : (
                        <Input
                          value={colFilters[col.key] ?? ""}
                          onChange={(e) => setColFilter(col.key, e.target.value)}
                          placeholder={col.type === "num" ? ">=100" : "بحث…"}
                          className="h-6 text-[10.5px] px-1.5 border-slate-300 bg-white"
                          title={col.type === "num" ? "أمثلة: >=100, <500, =0" : "بحث جزئي"}
                        />
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pagedOrders.map((ord: any, idx: number) => {
                  const absIdx = pageSize === 0 ? idx : (safePage - 1) * pageSize + idx;
                  const st = STATUS[ord.status] ?? STATUS.draft;
                  const rid = Number(ord.id);
                  const isSel = isSelected(rid);
                  const renderCell = (col: ColDef) => {
                    switch (col.key) {
                      case "_sel":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            <RowSelectCheckbox
                              checked={isSel}
                              onToggle={() => toggleRow(rid)}
                              ariaLabel={`تحديد الأمر ${ord.docNumber ?? `PO-${rid}`}`}
                            />
                          </td>
                        );
                      case "_idx":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center text-slate-500 font-mono">{absIdx + 1}</td>;
                      case "doc":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 font-mono font-semibold text-primary text-center">{ord.docNumber ?? `PO-${ord.id}`}</td>;
                      case "date":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center whitespace-nowrap text-slate-600">{ord.orderDate}</td>;
                      case "delivery":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center whitespace-nowrap text-slate-500">{ord.expectedDeliveryDate ?? <span className="text-muted-foreground">—</span>}</td>;
                      case "supplier":
                        return <td key={col.key} className={cn("px-2 py-1 border border-slate-200 truncate", colWidths.supplier ? "" : "max-w-[200px]")} title={supMap[ord.supplierId] ?? ""}>{supMap[ord.supplierId] ?? "—"}</td>;
                      case "paytype":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center text-slate-600">{paymentTypeLabel(ord.paymentType)}</td>;
                      case "currency":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center text-slate-500 font-mono">{ord.currencyCode}</td>;
                      case "subtotal":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-end font-mono text-slate-800">{fmt(ord.subtotal)}</td>;
                      case "vat":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-end font-mono text-amber-700">{fmt(ord.vatAmount)}</td>;
                      case "total":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-end font-mono font-bold text-slate-900">{fmt(ord.totalAmount)}</td>;
                      case "invoice":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center font-mono text-[10px]">
                            {ord.convertedInvoiceId ? (
                              <button type="button"
                                onClick={(e) => { e.stopPropagation(); navigate(`/purchasing/invoices/${ord.convertedInvoiceId}`); }}
                                className="text-blue-700 hover:text-blue-900 hover:underline font-semibold"
                                title={t("purchasingPages.purchaseOrders.tooltips.openInvoice")}>
                                INV-{ord.convertedInvoiceId}
                              </button>
                            ) : <span className="text-muted-foreground">—</span>}
                          </td>
                        );
                      case "status":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            <span className={cn("inline-flex items-center text-[10px] rounded px-1.5 py-0.5 font-medium border", st.cls)}>{t(st.labelKey)}</span>
                          </td>
                        );
                      case "_act":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            <div className="flex items-center justify-center gap-0.5">
                              <Button variant="ghost" size="icon" className="h-6 w-6"
                                title={t("purchasingPages.purchaseOrders.tooltips.viewEdit")}
                                onClick={(e) => { e.stopPropagation(); navigate(`/purchasing/orders/${ord.id}`); }}>
                                <Eye className="h-3.5 w-3.5" />
                              </Button>
                              <Button variant="ghost" size="icon" className="h-6 w-6 text-blue-600 hover:bg-blue-50 hover:text-blue-700"
                                title="نسخة مماثلة"
                                onClick={(e) => { e.stopPropagation(); navigate(`/purchasing/orders/new?from=${ord.id}`); }}>
                                <Copy className="h-3.5 w-3.5" />
                              </Button>
                              {ord.status === "draft" && (
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-blue-700 hover:bg-blue-50"
                                  title={t("purchasingPages.purchaseOrders.tooltips.confirm")}
                                  onClick={(e) => { e.stopPropagation(); statusMut.mutate({ id: ord.id, status: "confirmed" }); }}>
                                  <CheckCircle className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              {ord.status === "draft" && (
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-red-700 hover:bg-red-50"
                                  title={t("purchasingPages.purchaseOrders.tooltips.cancel")}
                                  onClick={(e) => { e.stopPropagation(); if (confirm(t("purchasingPages.purchaseOrders.confirms.cancel"))) statusMut.mutate({ id: ord.id, status: "cancelled" }); }}>
                                  <XCircle className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              {ord.status === "confirmed" && !ord.convertedInvoiceId && (
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-green-700 hover:bg-green-50"
                                  title={t("purchasingPages.purchaseOrders.tooltips.convert")}
                                  onClick={(e) => { e.stopPropagation(); if (confirm(t("purchasingPages.purchaseOrders.confirms.convert"))) convertMut.mutate(ord.id); }}>
                                  <FileCheck2 className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              {ord.status === "confirmed" && !ord.convertedInvoiceId && (
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-orange-700 hover:bg-orange-50"
                                  title={t("purchasingPages.purchaseOrders.tooltips.unconfirm")}
                                  onClick={(e) => { e.stopPropagation(); if (confirm(t("purchasingPages.purchaseOrders.confirms.unconfirmOne"))) statusMut.mutate({ id: ord.id, status: "draft" }); }}>
                                  <RotateCcw className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              {ord.status !== "converted" && ord.status !== "cancelled" && (
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                                  title={t("purchasingPages.purchaseOrders.tooltips.delete")}
                                  onClick={(e) => { e.stopPropagation(); if (confirm(t("purchasingPages.purchaseOrders.confirms.delete"))) deleteMut.mutate(ord.id); }}>
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
                  return (
                    <tr key={ord.id}
                      data-testid={`row-purchase-order-${ord.id}`}
                      data-status={ord.status}
                      data-has-converted={ord.convertedInvoiceId ? "1" : "0"}
                      className={cn(
                        "transition-colors cursor-pointer",
                        isSel ? SEL_TONE : rowToneFor({ status: ord.status, hasConverted: !!ord.convertedInvoiceId }),
                      )}
                      onClick={(e) => {
                        const tag = (e.target as HTMLElement).tagName;
                        if (tag === "BUTTON" || tag === "INPUT" || tag === "A" || (e.target as HTMLElement).closest("button,a,input")) return;
                        toggleRow(rid);
                      }}
                      onDoubleClick={() => navigate(`/purchasing/orders/${ord.id}`)}
                      title={buildToneTooltip({ status: ord.status, hasConverted: !!ord.convertedInvoiceId })}
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
          totalRows={filteredOrders.length}
          pageStart={pageStart}
          pageEnd={pageEnd}
          totalPages={totalPages}
          unitLabel="أمر"
        />
      </div>
    </div>
  );
}
