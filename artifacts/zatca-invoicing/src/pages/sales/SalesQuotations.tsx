import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useFormatters } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Plus, FileSignature, Eye, Trash2, ArrowRightLeft, CheckCircle, XCircle, Send, Printer, Copy,
  FileSpreadsheet, FileDown, X, Loader2,
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
import SalesPrintModal from "./SalesPrintModal";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const STATUS_CLS: Record<string, string> = {
  draft:     "bg-amber-50 text-amber-700 border-amber-200",
  sent:      "bg-blue-50 text-blue-700 border-blue-200",
  accepted:  "bg-green-50 text-green-700 border-green-200",
  rejected:  "bg-red-50 text-red-700 border-red-200",
  converted: "bg-primary/10 text-primary border-primary/30",
};

export default function SalesQuotations() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const { fmt } = useFormatters();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const authH   = { Authorization: `Bearer ${token}` };

  const [tableSearch, setTableSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "draft" | "sent" | "accepted" | "rejected" | "converted">("all");
  const [printData, setPrintData] = useState<any>(null);
  const [autoPrintOnOpen, setAutoPrintOnOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  async function openPrint(q: any, opts?: { autoPrint?: boolean }) {
    setAutoPrintOnOpen(!!opts?.autoPrint);
    try {
      const res = await fetch(`${API}/api/sales/sales-quotations/${q.id}`, { headers: authH });
      const full = await res.json();
      const customer = customers.find((c: any) => c.id === q.customerId) ?? null;
      setPrintData({ type: "quotation", doc: full, lines: full.lines ?? [], customer, company: user?.company ?? null });
    } catch (e: any) {
      toast({ title: e?.message ?? "تعذّر تحميل عرض السعر للطباعة", variant: "destructive" });
    }
  }

  const statusLabel = (s: string) =>
    s === "all" ? t("common.all") : t(`salesQuotations.status${s.charAt(0).toUpperCase()}${s.slice(1)}`);

  const { data: quotations = [], isLoading } = useQuery<any[]>({
    queryKey: ["sales-quotations", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/sales/sales-quotations?companyId=${cid}` : `${API}/api/sales/sales-quotations`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const { data: customers = [] } = useQuery<any[]>({
    queryKey: ["customers", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/customers?companyId=${cid}` : `${API}/api/customers`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const autoPrintHandledRef = useRef(false);
  useEffect(() => {
    if (autoPrintHandledRef.current) return;
    if (!quotations || quotations.length === 0) return;
    if (!customers) return;
    const st = (typeof window !== "undefined" ? window.history.state : null) as any;
    const id = st?.autoPrintInvoiceId;
    if (!id) return;
    const q = quotations.find((x: any) => Number(x.id) === Number(id));
    if (!q) return;
    autoPrintHandledRef.current = true;
    try { window.history.replaceState({}, ""); } catch { /* noop */ }
    openPrint(q, { autoPrint: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quotations, customers]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["sales-quotations"] });

  const statusMut = useMutation({
    mutationFn: async (args: { id: number; status: string }) => {
      const res = await fetch(`${API}/api/sales/sales-quotations/${args.id}/status`, { method: "PATCH", headers, body: JSON.stringify({ status: args.status }) });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: t("salesQuotations.toastStatusUpdated") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const convertMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/sales/sales-quotations/${id}/convert`, { method: "POST", headers });
      const j = await res.json(); if (!res.ok) throw new Error(j.error); return j;
    },
    onSuccess: (j) => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["sales-invoices"] });
      toast({ title: t("salesQuotations.toastConverted") });
      navigate(`/sales/invoices/${j.invoice.id}`);
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/sales/sales-quotations/${id}`, { method: "DELETE", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
    },
    onSuccess: () => { invalidate(); toast({ title: t("salesQuotations.toastDeleted") }); },
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

  const cusMap: Record<number, string> = useMemo(
    () => Object.fromEntries((customers as any[]).map((c: any) => [c.id, c.nameAr ?? c.nameEn])),
    [customers],
  );

  /* ── Audit-grid column model ── */
  type ColType = "text" | "num" | "none";
  interface ColDef { key: string; label: string; type: ColType; valueOf: (r: any) => string | number; }
  const COLUMNS: ColDef[] = [
    { key: "_sel",      label: "",                                 type: "none", valueOf: () => "" },
    { key: "_idx",      label: "#",                                type: "none", valueOf: () => "" },
    { key: "doc",       label: t("salesQuotations.colNumber"),     type: "text", valueOf: (r) => r.docNumber ?? `SQ-${r.id}` },
    { key: "date",      label: t("salesQuotations.colDate"),       type: "text", valueOf: (r) => r.quotationDate ?? "" },
    { key: "validUntil",label: t("salesQuotations.colValidUntil"), type: "text", valueOf: (r) => r.validUntil ?? "" },
    { key: "customer",  label: t("salesQuotations.colCustomer"),   type: "text", valueOf: (r) => cusMap[r.customerId] ?? "" },
    { key: "currency",  label: t("salesQuotations.colCurrency"),   type: "text", valueOf: (r) => r.currencyCode ?? "" },
    { key: "subtotal",  label: t("salesQuotations.colSubtotal"),   type: "num",  valueOf: (r) => Number(r.subtotal ?? 0) },
    { key: "vat",       label: t("salesQuotations.colVat"),        type: "num",  valueOf: (r) => Number(r.vatAmount ?? 0) },
    { key: "total",     label: t("salesQuotations.colTotal"),      type: "num",  valueOf: (r) => Number(r.totalAmount ?? 0) },
    { key: "status",    label: t("salesQuotations.colStatus"),     type: "text", valueOf: (r) => statusLabel(r.status) },
    { key: "_act",      label: t("salesQuotations.colActions"),    type: "none", valueOf: () => "" },
  ];
  const DATA_KEYS = COLUMNS.filter(c => c.key !== "_sel" && c.key !== "_idx" && c.key !== "_act").map(c => c.key);
  const ALL_KEYS  = COLUMNS.map(c => c.key);

  const layout = useAuditGridLayout({
    screenSlug: "salesQuotationsAuditGrid",
    cid,
    dataKeys: DATA_KEYS,
    allColKeys: ALL_KEYS,
  });
  const { tableRef, gripProps } = useColumnResize(layout.setColWidths);
  const { theme, footerTheme, colWidths, colFilters, clearColFilters,
          isSelected, toggleRow, toggleAll, isAllSelected, isSomeSelected, clearSelection } = layout;

  // Per-column advanced filter (two conditions + AND/OR). Lives outside
  // useAuditGridLayout so this screen owns reset/UX without forcing a
  // change on every other audit-grid consumer. Same shape across screens.
  const [colAdv, setColAdv] = useState<Record<string, AdvFilter>>({});
  const clearColAdv = (key: string) =>
    setColAdv(prev => { const n = { ...prev }; delete n[key]; return n; });
  const clearAllColFilters = () => { clearColFilters(); setColAdv({}); };

  /* ── Filtering ── */
  const filteredQuotations = useMemo(() => {
    const q = tableSearch.trim().toLowerCase();
    return (quotations as any[]).filter((qt) => {
      if (statusFilter !== "all" && qt.status !== statusFilter) return false;
      if (q) {
        const hay = [
          qt.docNumber, `SQ-${qt.id}`, qt.quotationDate, cusMap[qt.customerId],
          qt.currencyCode, qt.notes,
        ].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      for (const col of COLUMNS) {
        const adv = colAdv[col.key];
        if (!isAdvActive(adv)) continue;
        if (!matchAdv(col.valueOf(qt), adv, col.type)) return false;
      }
      return true;
    });
  }, [quotations, tableSearch, statusFilter, colAdv, cusMap]);

  /* ── Pagination ── */
  const { pageSize, page, setPage } = layout;
  const totalPages = pageSize === 0 ? 1 : Math.max(1, Math.ceil(filteredQuotations.length / pageSize));
  const safePage = Math.min(page, totalPages);
  useEffect(() => { if (safePage !== page) setPage(safePage); }, [safePage, page, setPage]);
  const pagedQuotations = useMemo(
    () => pageSize === 0 ? filteredQuotations : filteredQuotations.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filteredQuotations, pageSize, safePage],
  );
  const pageStart = filteredQuotations.length === 0 ? 0 : pageSize === 0 ? 1 : (safePage - 1) * pageSize + 1;
  const pageEnd   = pageSize === 0 ? filteredQuotations.length : Math.min(safePage * pageSize, filteredQuotations.length);

  const totals = useMemo(() => filteredQuotations.reduce(
    (a, r: any) => {
      a.subtotal += Number(r.subtotal ?? 0);
      a.vat      += Number(r.vatAmount ?? 0);
      a.total    += Number(r.totalAmount ?? 0);
      return a;
    },
    { subtotal: 0, vat: 0, total: 0 },
  ), [filteredQuotations]);

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

  const buildListHtml = (source: any[] = filteredQuotations) => {
    const today = new Date().toLocaleDateString("ar-SA");
    const sumSub = source.reduce((a, r: any) => a + Number(r.subtotal ?? 0), 0);
    const sumVat = source.reduce((a, r: any) => a + Number(r.vatAmount ?? 0), 0);
    const sumTot = source.reduce((a, r: any) => a + Number(r.totalAmount ?? 0), 0);
    const logoHtml = safeLogo
      ? `<div style="margin-bottom:6px;"><img src="${safeLogo}" alt="" style="max-height:54px;max-width:170px;object-fit:contain;display:block;margin:0 auto;" /></div>` : "";
    const companyHtml = user?.company?.nameAr
      ? `<div style="font-size:13px;font-weight:600;color:#1e3a8a;margin-bottom:2px;">${escapeHtml(user.company.nameAr)}</div>` : "";
    return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${escapeHtml(t("salesQuotations.title"))}</title>
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
<div class="h">${logoHtml}${companyHtml}<h1>${escapeHtml(t("salesQuotations.title"))}</h1>
<div class="meta">تاريخ التقرير: ${today} — عدد العروض: ${source.length}</div></div>
<div class="totals">
  <span>إجمالي المجموع: <b>${sumSub.toFixed(2)}</b></span>
  <span>إجمالي الضريبة: <b>${sumVat.toFixed(2)}</b></span>
  <span>الإجمالي: <b>${sumTot.toFixed(2)}</b></span>
</div>
<table><thead><tr>
  <th>#</th><th>رقم العرض</th><th>التاريخ</th><th>صالح حتى</th><th>العميل</th>
  <th>العملة</th><th>المجموع</th><th>الضريبة</th><th>الإجمالي</th><th>الحالة</th>
</tr></thead><tbody>
${source.map((r: any, i: number) => `<tr>
  <td>${i + 1}</td>
  <td>${escapeHtml(r.docNumber ?? `SQ-${r.id}`)}</td>
  <td>${escapeHtml(r.quotationDate ?? "")}</td>
  <td>${escapeHtml(r.validUntil ?? "")}</td>
  <td>${escapeHtml(cusMap[r.customerId] ?? "")}</td>
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
      const docNo  = d.docNumber ?? `SQ-${d.id}`;
      const linesHtml = lines.length === 0
        ? `<tr><td colspan="6" style="text-align:center;color:#6b7280;padding:14px;">لا توجد بنود لهذا العرض.</td></tr>`
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
          <span class="badge b-doc">رقم العرض: ${escapeHtml(docNo)}</span>
          <span class="badge b-date">التاريخ: ${escapeHtml(d.quotationDate ?? "")}</span>
          <span class="badge b-cust">العميل: ${escapeHtml(cusMap[d.customerId] ?? "")}</span>
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
    return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>طباعة عروض الأسعار المحدّدة</title>
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
.b-status.s-accepted{background:#d1fae5;border-color:#34d399;color:#065f46;}
.b-status.s-sent{background:#dbeafe;border-color:#60a5fa;color:#1e3a8a;}
.b-status.s-draft{background:#f1f5f9;border-color:#94a3b8;color:#334155;}
.b-status.s-rejected{background:#fee2e2;border-color:#f87171;color:#991b1b;}
.b-status.s-converted{background:#e0e7ff;border-color:#818cf8;color:#3730a3;}
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
<div class="h">${logoHtml}${companyHtml}<h1>عروض الأسعار المحدّدة</h1>
<div class="meta">تاريخ التقرير: ${today} — عدد العروض: ${docs.length}</div></div>
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
    if (filteredQuotations.length === 0) { toast({ title: "لا يوجد بيانات للتصدير", variant: "destructive" }); return; }
    const rows = filteredQuotations.map((r: any) => ({
      "رقم العرض": r.docNumber ?? `SQ-${r.id}`,
      "التاريخ": r.quotationDate ?? "",
      "صالح حتى": r.validUntil ?? "",
      "العميل": cusMap[r.customerId] ?? "",
      "العملة": r.currencyCode ?? "",
      "المجموع": Number(r.subtotal ?? 0).toFixed(2),
      "الضريبة": Number(r.vatAmount ?? 0).toFixed(2),
      "الإجمالي": Number(r.totalAmount ?? 0).toFixed(2),
      "الحالة": statusLabel(r.status),
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 22 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "عروض الأسعار");
    XLSX.writeFile(wb, `sales-quotations-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };


  function exportCsv() {
    if (filteredQuotations.length === 0) { toast({ title: "لا يوجد بيانات للتصدير", variant: "destructive" }); return; }
    const header = ["#", ...visibleColumns.filter((c) => c.key !== "_sel" && c.key !== "_idx" && c.key !== "_act").map((c) => c.label)];
    const rows = filteredQuotations.map((r: any, i: number) => [
      i + 1,
      ...visibleColumns
        .filter((c) => c.key !== "_sel" && c.key !== "_idx" && c.key !== "_act")
        .map((c) => {
          const v = c.valueOf(r);
          return c.type === "num" ? Number(v).toFixed(2) : String(v);
        }),
    ]);
    downloadCsv(`sales-quotations-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
    toast({ title: "تم تصدير ملف CSV بنجاح" });
  }

  /* ── Bulk handlers ── */
  const allFilteredIds: number[] = useMemo(
    () => filteredQuotations.map((r: any) => Number(r.id)),
    [filteredQuotations],
  );
  const selectedRows = useMemo(
    () => (quotations as any[]).filter((r) => isSelected(Number(r.id))),
    [quotations, isSelected],
  );
  const selectedSendable   = selectedRows.filter((r) => r.status === "draft");
  const selectedAcceptable = selectedRows.filter((r) => r.status === "draft" || r.status === "sent");
  const selectedDeletable  = selectedRows.filter((r) => r.status !== "converted");

  async function bulkSend() {
    const ids = selectedSendable.map((r) => Number(r.id));
    if (ids.length === 0) { toast({ title: "لا توجد مسوّدات ضمن المحدَّد", variant: "destructive" }); return; }
    setBulkBusy(true);
    try {
      const { ok, failed } = await bulkRun(ids, async (id) => {
        const res = await fetch(`${API}/api/sales/sales-quotations/${id}/status`, { method: "PATCH", headers, body: JSON.stringify({ status: "sent" }) });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error ?? `HTTP ${res.status}`); }
      });
      invalidate();
      if (failed.length === 0) toast({ title: `تم إرسال ${ok} عرض` });
      else toast({ title: `إرسال: ${ok} نجح، ${failed.length} فشل`, description: failed.slice(0, 3).map(f => f.error).join("\n"), variant: "destructive" });
      clearSelection();
    } finally { setBulkBusy(false); }
  }

  async function bulkAccept() {
    const ids = selectedAcceptable.map((r) => Number(r.id));
    if (ids.length === 0) { toast({ title: "لا توجد عروض قابلة للقبول ضمن المحدَّد", variant: "destructive" }); return; }
    setBulkBusy(true);
    try {
      const { ok, failed } = await bulkRun(ids, async (id) => {
        const res = await fetch(`${API}/api/sales/sales-quotations/${id}/status`, { method: "PATCH", headers, body: JSON.stringify({ status: "accepted" }) });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error ?? `HTTP ${res.status}`); }
      });
      invalidate();
      if (failed.length === 0) toast({ title: `تم قبول ${ok} عرض` });
      else toast({ title: `قبول: ${ok} نجح، ${failed.length} فشل`, description: failed.slice(0, 3).map(f => f.error).join("\n"), variant: "destructive" });
      clearSelection();
    } finally { setBulkBusy(false); }
  }

  async function bulkDelete() {
    const ids = selectedDeletable.map((r) => Number(r.id));
    if (ids.length === 0) { toast({ title: "لا يمكن حذف العروض المحوَّلة.", variant: "destructive" }); return; }
    if (!window.confirm(`حذف ${ids.length} عرض نهائياً؟ لا يمكن التراجع عن هذا الإجراء.`)) return;
    setBulkBusy(true);
    try {
      const { ok, failed } = await bulkRun(ids, async (id) => {
        const res = await fetch(`${API}/api/sales/sales-quotations/${id}`, { method: "DELETE", headers });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error ?? `HTTP ${res.status}`); }
      });
      invalidate();
      if (failed.length === 0) toast({ title: `تم حذف ${ok} عرض` });
      else toast({ title: `حذف: ${ok} نجح، ${failed.length} فشل`, description: failed.slice(0, 3).map(f => f.error).join("\n"), variant: "destructive" });
      clearSelection();
    } finally { setBulkBusy(false); }
  }

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileSignature className="h-6 w-6 text-primary" />{t("salesQuotations.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t("salesQuotations.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2 print:hidden">
          <Button
            onClick={() => navigate("/sales/quotations/new")}
            className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm"
          >
            <Plus className="h-4 w-4" />
            {t("salesQuotations.newQuotation")}
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
            <FileSignature className="h-4 w-4 opacity-90" />
            جرد عروض الأسعار
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
            placeholder="بحث (مستند، عميل، عملة)…"
            value={tableSearch}
            onChange={(e) => setTableSearch(e.target.value)}
            className="h-7 text-xs w-56"
          />
          <div className="flex gap-1">
            {(["all", "draft", "sent", "accepted", "rejected", "converted"] as const).map((s) => (
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
            {filteredQuotations.length} عرض
            {filteredQuotations.length !== quotations.length && <span className="text-slate-400"> / {quotations.length}</span>}
          </span>
        </div>
        <AuditGridBulkBar count={layout.selected.size} onClear={clearSelection} busy={bulkBusy}>
          <BulkPrintMenu
            selectedIds={Array.from(layout.selected).map(Number)}
            filteredDocs={filteredQuotations as any[]}
            adapter={{
              kind: "sales-quotation",
              title: t("salesQuotations.title"),
              docTypeLabel: "عرض سعر",
              partyLabel: "العميل",
              getHeader: (d: any) => ({
                docNo: d.docNumber ?? `SQ-${d.id}`,
                date: d.quotationDate ?? "",
                partyName: cusMap[d.customerId] ?? "",
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
              const res = await fetch(`${API}/api/sales/sales-quotations/${id}${cid ? `?companyId=${cid}` : ""}`, { headers: authH });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              return res.json();
            }}
            onPopupBlocked={() => toast({ title: "تم حظر النافذة المنبثقة", description: "الرجاء السماح بالنوافذ المنبثقة للطباعة", variant: "destructive" })}
            onFetchFailed={(n) => toast({ title: `تعذّر تحميل ${n} عرض سعر بكامل بنوده`, variant: "destructive" })}
            primaryLabel="طباعة"
          />
          <Button type="button" size="sm"
            className="h-7 px-3 text-xs gap-1 bg-blue-600 hover:bg-blue-500 text-white"
            onClick={bulkSend}
            disabled={bulkBusy || selectedSendable.length === 0}
            title={selectedSendable.length === 0 ? "لا توجد مسوّدات ضمن المحدَّد" : `إرسال ${selectedSendable.length} عرض`}>
            {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            إرسال ({selectedSendable.length})
          </Button>
          <Button type="button" size="sm"
            className="h-7 px-3 text-xs gap-1 bg-emerald-700 hover:bg-emerald-600 text-white"
            onClick={bulkAccept}
            disabled={bulkBusy || selectedAcceptable.length === 0}
            title={selectedAcceptable.length === 0 ? "لا توجد عروض قابلة للقبول" : `قبول ${selectedAcceptable.length} عرض`}>
            <CheckCircle className="h-3.5 w-3.5" />
            قبول ({selectedAcceptable.length})
          </Button>
          <Button type="button" size="sm"
            className="h-7 px-3 text-xs gap-1 bg-rose-600 hover:bg-rose-500 text-white"
            onClick={bulkDelete}
            disabled={bulkBusy || selectedDeletable.length === 0}
            title={selectedDeletable.length === 0
              ? "لا يمكن حذف العروض المحوَّلة"
              : `حذف ${selectedDeletable.length} عرض`}>
            <Trash2 className="h-3.5 w-3.5" />
            حذف ({selectedDeletable.length})
          </Button>
        </AuditGridBulkBar>
      </div>

      {/* Color legend — chips reflect counts within the FILTERED set */}
      {(() => {
        const items: LegendItem[] = [
          { kind: "draft",     count: filteredQuotations.filter((q: any) => q.status === "draft").length },
          { kind: "sent",      count: filteredQuotations.filter((q: any) => q.status === "sent").length },
          { kind: "accepted",  count: filteredQuotations.filter((q: any) => q.status === "accepted").length },
          { kind: "rejected",  count: filteredQuotations.filter((q: any) => q.status === "rejected").length },
          { kind: "converted", count: filteredQuotations.filter((q: any) => q.status === "converted" || !!q.convertedOrderId || !!q.convertedInvoiceId).length },
          { kind: "cancelled", count: filteredQuotations.filter((q: any) => q.status === "cancelled").length },
        ];
        return <DocColorLegend items={items} />;
      })()}

      {/* Audit-grid table */}
      <div className="border border-slate-300 rounded-b-lg bg-white overflow-hidden shadow-sm -mt-3">
        <div className="overflow-x-auto" style={{ maxHeight: "calc(100vh - 320px)" }}>
          {isLoading ? (
            <div className="p-12 text-center text-muted-foreground text-sm">{t("common.loading")}</div>
          ) : filteredQuotations.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground text-sm">
              {quotations.length === 0 ? t("salesQuotations.noQuotations") : "لا توجد عروض ضمن التصفية الحالية"}
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
                  {visibleColumns.map((col, idx) => {
                    const isFilterable = col.type !== "none";
                    const advValue = colAdv[col.key];
                    const isFiltered = isAdvActive(advValue);
                    return (
                    <th key={col.key} data-col-key={col.key}
                      style={colWidths[col.key] ? { width: `${colWidths[col.key]}px`, minWidth: `${colWidths[col.key]}px` } : undefined}
                      className={cn(
                        "relative px-2 py-1.5 border border-slate-300 text-center font-semibold whitespace-nowrap text-[10.5px]",
                        isFiltered && "bg-rose-50 ring-1 ring-rose-300/70",
                      )}
                      title={isFiltered ? `فلتر: ${describeAdv(advValue, col.type)}` : undefined}>
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
                          {isFilterable && (
                            <AdvFilterPopover
                              colLabel={col.label || col.key}
                              colType={col.type}
                              value={advValue}
                              active={isFiltered}
                              onApply={v => setColAdv(prev => ({ ...prev, [col.key]: v }))}
                              onClear={() => clearColAdv(col.key)}
                            />
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
                  );
                  })}
                </tr>
                {/* (Legacy per-column filter input row removed — filtering is
                    now fully driven by AdvFilterPopover triggers in each header.) */}
              </thead>
              <tbody>
                {pagedQuotations.map((q: any, idx: number) => {
                  const absIdx = pageSize === 0 ? idx : (safePage - 1) * pageSize + idx;
                  const stCls = STATUS_CLS[q.status] ?? STATUS_CLS.draft;
                  const rid = Number(q.id);
                  const isSel = isSelected(rid);
                  const renderCell = (col: ColDef) => {
                    switch (col.key) {
                      case "_sel":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            <RowSelectCheckbox
                              checked={isSel}
                              onToggle={() => toggleRow(rid)}
                              ariaLabel={`تحديد العرض ${q.docNumber ?? `SQ-${rid}`}`}
                            />
                          </td>
                        );
                      case "_idx":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center text-slate-500 font-mono">{absIdx + 1}</td>;
                      case "doc":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 font-mono font-semibold text-primary text-center">{q.docNumber ?? `SQ-${q.id}`}</td>;
                      case "date":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center whitespace-nowrap text-slate-600">{q.quotationDate}</td>;
                      case "validUntil":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center whitespace-nowrap text-slate-500">{q.validUntil ?? <span className="text-muted-foreground">{t("common.none")}</span>}</td>;
                      case "customer":
                        return <td key={col.key} className={cn("px-2 py-1 border border-slate-200 truncate", colWidths.customer ? "" : "max-w-[200px]")} title={cusMap[q.customerId] ?? ""}>{cusMap[q.customerId] ?? t("common.none")}</td>;
                      case "currency":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center text-slate-500 font-mono">{q.currencyCode}</td>;
                      case "subtotal":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-end font-mono text-slate-800">{fmt(q.subtotal)}</td>;
                      case "vat":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-end font-mono text-amber-700">{fmt(q.vatAmount)}</td>;
                      case "total":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-end font-mono font-bold text-slate-900">{fmt(q.totalAmount)}</td>;
                      case "status":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            <span className={cn("inline-flex items-center text-[10px] rounded px-1.5 py-0.5 font-medium border", stCls)}>{statusLabel(q.status)}</span>
                          </td>
                        );
                      case "_act":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            <div className="flex items-center justify-center gap-0.5">
                              <Button variant="ghost" size="icon" className="h-6 w-6"
                                title={t("common.openEdit")}
                                onClick={(e) => { e.stopPropagation(); navigate(`/sales/quotations/${q.id}`); }}>
                                <Eye className="h-3.5 w-3.5" />
                              </Button>
                              <Button variant="ghost" size="icon" className="h-6 w-6 text-slate-700 hover:text-primary hover:bg-muted"
                                title="طباعة"
                                onClick={(e) => { e.stopPropagation(); openPrint(q); }}>
                                <Printer className="h-3.5 w-3.5" />
                              </Button>
                              <Button variant="ghost" size="icon" className="h-6 w-6 text-blue-600 hover:bg-blue-50 hover:text-blue-700"
                                title="نسخة مماثلة"
                                onClick={(e) => { e.stopPropagation(); navigate(`/sales/quotations/new?from=${q.id}`); }}>
                                <Copy className="h-3.5 w-3.5" />
                              </Button>
                              {q.status === "draft" && (
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-blue-600"
                                  title={t("salesQuotations.actionSend")}
                                  onClick={(e) => { e.stopPropagation(); statusMut.mutate({ id: q.id, status: "sent" }); }}>
                                  <Send className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              {(q.status === "sent" || q.status === "draft") && (
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-green-700"
                                  title={t("salesQuotations.actionAccept")}
                                  onClick={(e) => { e.stopPropagation(); statusMut.mutate({ id: q.id, status: "accepted" }); }}>
                                  <CheckCircle className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              {(q.status === "sent" || q.status === "draft") && (
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-red-600"
                                  title={t("salesQuotations.actionReject")}
                                  onClick={(e) => { e.stopPropagation(); statusMut.mutate({ id: q.id, status: "rejected" }); }}>
                                  <XCircle className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              {q.status === "accepted" && (
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-primary"
                                  title={t("salesQuotations.actionConvert")}
                                  onClick={(e) => { e.stopPropagation(); if (confirm(t("salesQuotations.confirmConvert"))) convertMut.mutate(q.id); }}>
                                  <ArrowRightLeft className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              {q.status !== "converted" && (
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                                  onClick={(e) => { e.stopPropagation(); if (confirm(t("salesQuotations.confirmDelete"))) deleteMut.mutate(q.id); }}>
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
                  const hasConv = !!q.convertedOrderId || !!q.convertedInvoiceId;
                  return (
                    <tr key={q.id}
                      data-testid={`row-quote-${q.id}`}
                      data-status={q.status}
                      data-has-converted={hasConv ? "1" : "0"}
                      className={cn(
                        "transition-colors cursor-pointer",
                        isSel ? SEL_TONE : rowToneFor({
                          status: q.status,
                          hasConverted: hasConv,
                        }),
                      )}
                      onClick={(e) => {
                        const tag = (e.target as HTMLElement).tagName;
                        if (tag === "BUTTON" || tag === "INPUT" || tag === "A" || (e.target as HTMLElement).closest("button,a,input")) return;
                        toggleRow(rid);
                      }}
                      onDoubleClick={() => navigate(`/sales/quotations/${q.id}`)}
                      title={buildToneTooltip({ status: q.status, hasConverted: hasConv })}
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
          totalRows={filteredQuotations.length}
          pageStart={pageStart}
          pageEnd={pageEnd}
          totalPages={totalPages}
          unitLabel="عرض"
        />
      </div>

      <SalesPrintModal open={!!printData} onClose={() => setPrintData(null)} data={printData} />
    </div>
  );
}
