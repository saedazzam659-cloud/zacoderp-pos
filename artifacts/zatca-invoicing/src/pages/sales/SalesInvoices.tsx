import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useFormatters } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search, ShoppingBag, Eye, Trash2, CheckCircle, FileText, RotateCcw, Undo2, Copy, Printer, FileSpreadsheet, FileDown, User } from "lucide-react";
import { cn } from "@/lib/utils";
import SalesPrintModal from "./SalesPrintModal";
import { TablePagination, usePagination } from "@/components/TablePagination";
import { exportToExcel, exportToPDF, type ExportColumn } from "@/lib/export";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function SalesInvoices() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const { t } = useTranslation();
  const { fmt, isRtl } = useFormatters();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const authH   = { Authorization: `Bearer ${token}` };

  const STATUS: Record<string, { label: string; cls: string }> = {
    draft:     { label: t("status.draft"),     cls: "bg-amber-50 text-amber-700 border-amber-200" },
    posted:    { label: t("status.posted"),    cls: "bg-green-50 text-green-700 border-green-200" },
    cancelled: { label: t("status.cancelled"), cls: "bg-muted text-muted-foreground border-border" },
  };

  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [printData, setPrintData] = useState<any>(null);
  // Holds the user-chosen template for the currently-open print modal.
  // Defaulted to the company's saved sales template so the modal opens
  // on the right preset whether triggered manually or via auto-print.
  const salesTemplatePref: "a4" | "thermal" =
    ((user as any)?.company?.printTemplateSales === "thermal") ? "thermal" : "a4";
  const [printTemplate, setPrintTemplate] = useState<"a4" | "thermal">(salesTemplatePref);
  // When true, the modal triggers window.print() automatically once mounted.
  // We flip it back off after each open so manual reopens don't re-print.
  const [autoPrintOnOpen, setAutoPrintOnOpen] = useState(false);

  async function openPrint(inv: any, opts?: { template?: "a4" | "thermal"; autoPrint?: boolean }) {
    try {
      const res = await fetch(`${API}/api/sales/sales-invoices/${inv.id}`, { headers: authH });
      const full = await res.json();
      const customer = customers.find((c: any) => c.id === inv.customerId) ?? null;
      setPrintTemplate(opts?.template ?? salesTemplatePref);
      setAutoPrintOnOpen(!!opts?.autoPrint);
      setPrintData({ type: "invoice", doc: full, lines: full.lines ?? [], customer, company: user?.company ?? null });
    } catch (e: any) {
      toast({ title: e?.message ?? "تعذّر تحميل الفاتورة للطباعة", variant: "destructive" });
    }
  }

  const autoPrintHandledRef = useRef(false);

  const { data: invoices = [], isLoading } = useQuery<any[]>({
    queryKey: ["sales-invoices", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/sales/sales-invoices?companyId=${cid}` : `${API}/api/sales/sales-invoices`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const { data: customers = [] } = useQuery<any[]>({
    queryKey: ["customers", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/customers?companyId=${cid}` : `${API}/api/customers`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  // Plan-based monthly invoice quota — invalidated on `subscription_changed`
  // SSE (handled globally by AuthContext) so SuperAdmin upgrades reflect
  // without a re-login. Counts only the current calendar month so the badge
  // resets automatically at month-rollover.
  const { data: invQuota } = useQuery<{ limit: number; used: number; remaining: number; hasSubscription: boolean }>({
    queryKey: ["sales-invoices-quota", cid],
    enabled: !!user && !!cid,
    queryFn: async () => {
      const r = await fetch(`${API}/api/sales/sales-invoices/quota?companyId=${cid}`, { headers: authH });
      if (!r.ok) return { limit: 0, used: 0, remaining: 0, hasSubscription: false };
      return r.json();
    },
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  // Click-guard helper for both "new invoice" entry points: blocks
  // navigation to the form when the monthly cap is exhausted and toasts
  // an actionable upgrade message instead of letting the user fill in
  // the whole form just to be rejected at save-time.
  const guardedNewInvoice = () => {
    if (invQuota && invQuota.remaining === 0) {
      toast({
        title: "وصلت للحد الأقصى",
        description: `خطتك تسمح بـ ${invQuota.limit} فاتورة شهرياً فقط. يرجى ترقية الخطة لإضافة المزيد.`,
        variant: "destructive",
      });
      return;
    }
    navigate("/sales/invoices/new");
  };

  // Pick up the auto-print hint planted by SalesDocumentForm via
  // sessionStorage when redirecting back here after save. We wait
  // until invoices and customers have loaded so the invoice lookup
  // and customer enrichment in openPrint both succeed, then clear
  // the marker so refresh / re-visits don't re-print. We use
  // sessionStorage rather than window.history.state because
  // wouter's navigate() pushes a fresh state object which would
  // otherwise wipe the hint.
  useEffect(() => {
    if (autoPrintHandledRef.current) return;
    if (!invoices || invoices.length === 0) return;
    if (!customers) return;
    let hint: { id: number; template?: string; ts?: number } | null = null;
    try {
      const raw = sessionStorage.getItem("autoPrintSalesInvoice");
      if (raw) hint = JSON.parse(raw);
    } catch { /* ignore parse failures */ }
    // Stale hints (>2 minutes old) are ignored to avoid printing on
    // accidental back-navigations long after the original save.
    if (hint?.ts && Date.now() - hint.ts > 2 * 60 * 1000) hint = null;
    const id = hint?.id;
    if (!id) return;
    const tpl: "a4" | "thermal" = hint?.template === "thermal" ? "thermal" : "a4";
    const inv = invoices.find((x: any) => Number(x.id) === Number(id));
    if (!inv) return;
    autoPrintHandledRef.current = true;
    try { sessionStorage.removeItem("autoPrintSalesInvoice"); } catch { /* noop */ }
    openPrint(inv, { template: tpl, autoPrint: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoices, customers]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["sales-invoices"] });

  const postMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/sales/sales-invoices/${id}/post`, { method: "PATCH", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: t("salesInvoices.toastPosted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const unpostMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/sales/sales-invoices/${id}/unpost`, { method: "PATCH", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: t("salesInvoices.toastUnposted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/sales/sales-invoices/${id}`, { method: "DELETE", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
    },
    onSuccess: () => { invalidate(); toast({ title: t("salesInvoices.toastDeleted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const cusMap = Object.fromEntries(customers.map((c: any) => [c.id, c.nameAr ?? c.nameEn]));

  const filtered = invoices.filter(inv => {
    const q = search.toLowerCase();
    const matchText = !search || (inv.docNumber ?? "").includes(q) || (cusMap[inv.customerId] ?? "").includes(search);
    const matchStatus = filterStatus === "all" || inv.status === filterStatus;
    return matchText && matchStatus;
  });

  const pager = usePagination(filtered);

  const totalPosted = invoices.filter(i => i.status === "posted").reduce((s, i) => s + Number(i.totalAmount || 0), 0);

  // ─── Excel / PDF export of the currently filtered list ──────────────────
  // We export `filtered` (search + status filters honoured) instead of the
  // raw `invoices` so the file matches what the user sees on screen. Each
  // row mirrors the visible columns; the totals row sums totals/VAT/sub
  // across the filtered set so the file is self-explanatory.
  const exportColumns: ExportColumn[] = [
    { header: t("salesInvoices.colNumber"),         key: "docNumber",       width: 14 },
    { header: t("salesInvoices.colDate"),           key: "invoiceDate",     width: 12 },
    { header: t("salesInvoices.colCustomer"),       key: "customerName",    width: 26 },
    { header: t("salesInvoices.colPaymentType"),    key: "paymentLabel",    width: 12 },
    { header: t("salesInvoices.colCurrency"),       key: "currencyCode",    width: 8  },
    { header: t("salesInvoices.colSubtotal"),       key: "subtotal",        width: 14 },
    { header: t("salesInvoices.colVat"),            key: "vatAmount",       width: 14 },
    { header: t("salesInvoices.colTotal"),          key: "totalAmount",     width: 14 },
    { header: t("salesInvoices.colStatus"),         key: "statusLabel",     width: 12 },
  ];
  function buildExportRows() {
    return filtered.map(inv => {
      const payLabel = inv.paymentType === "cash"
        ? t("salesInvoices.paymentCash")
        : inv.paymentType === "bank"
          ? t("salesInvoices.paymentBank")
          : t("salesInvoices.paymentCredit");
      return {
        docNumber:    inv.docNumber ?? `SI-${inv.id}`,
        invoiceDate:  inv.invoiceDate ?? "",
        customerName: cusMap[inv.customerId] ?? "—",
        paymentLabel: payLabel,
        currencyCode: inv.currencyCode ?? "SAR",
        subtotal:     fmt(inv.subtotal),
        vatAmount:    fmt(inv.vatAmount),
        totalAmount:  fmt(inv.totalAmount),
        statusLabel:  STATUS[inv.status]?.label ?? inv.status,
      };
    });
  }
  function buildTotalsRow() {
    const sumSub = filtered.reduce((s, i) => s + Number(i.subtotal    || 0), 0);
    const sumVat = filtered.reduce((s, i) => s + Number(i.vatAmount   || 0), 0);
    const sumTot = filtered.reduce((s, i) => s + Number(i.totalAmount || 0), 0);
    return {
      docNumber:    t("common.total", "الإجمالي"),
      invoiceDate:  "",
      customerName: `${filtered.length} ${t("salesInvoices.itemLabel", { defaultValue: "فاتورة" })}`,
      paymentLabel: "",
      currencyCode: "",
      subtotal:     fmt(sumSub),
      vatAmount:    fmt(sumVat),
      totalAmount:  fmt(sumTot),
      statusLabel:  "",
    };
  }
  function exportFilenameBase() {
    const today = new Date().toISOString().slice(0, 10);
    return `sales-invoices-${today}`;
  }
  function handleExportExcel() {
    if (filtered.length === 0) {
      toast({ title: "لا توجد فواتير للتصدير" });
      return;
    }
    exportToExcel(buildExportRows(), exportColumns, exportFilenameBase(), "فواتير المبيعات", buildTotalsRow());
    toast({ title: `تم تصدير ${filtered.length} فاتورة إلى Excel` });
  }
  function handleExportPDF() {
    if (filtered.length === 0) {
      toast({ title: "لا توجد فواتير للتصدير" });
      return;
    }
    exportToPDF(
      buildExportRows(),
      exportColumns,
      exportFilenameBase(),
      "فواتير المبيعات",
      `إجمالي السجلات المعروضة: ${filtered.length}`,
      true,
      buildTotalsRow(),
      null,
      (user as any)?.company?.logo ?? null,
    );
    toast({ title: `جارٍ فتح ${filtered.length} فاتورة بصيغة PDF` });
  }

  const headerCells: string[] = [
    t("salesInvoices.colNumber"), t("salesInvoices.colDate"), t("salesInvoices.colCustomer"),
    t("salesInvoices.colPaymentType"), t("salesInvoices.colCurrency"), t("salesInvoices.colSubtotal"),
    t("salesInvoices.colVat"), t("salesInvoices.colTotal"),
    t("salesInvoices.colPaymentStatus", "حالة السداد"),
    t("salesInvoices.colJournal"),
    t("salesInvoices.colStatus"),
    t("salesInvoices.colCreatedBy", "أنشأه"),
    t("salesInvoices.colPostedBy", "رحّله"),
    t("salesInvoices.colActions"),
  ];
  const align = isRtl ? "text-right" : "text-left";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShoppingBag className="h-6 w-6 text-primary" />{t("salesInvoices.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t("salesInvoices.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            variant="outline"
            className="gap-2 text-emerald-700 border-emerald-200 hover:bg-emerald-50 hover:text-emerald-800"
            onClick={() => handleExportExcel()}
            disabled={filtered.length === 0}
            title="تصدير الفواتير المعروضة إلى ملف Excel"
            data-testid="button-export-excel"
          >
            <FileSpreadsheet className="h-4 w-4" />
            تصدير Excel
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-2 text-rose-700 border-rose-200 hover:bg-rose-50 hover:text-rose-800"
            onClick={() => handleExportPDF()}
            disabled={filtered.length === 0}
            title="تصدير الفواتير المعروضة إلى PDF"
            data-testid="button-export-pdf"
          >
            <FileDown className="h-4 w-4" />
            تصدير PDF
          </Button>
          {invQuota && (
            <div
              className={
                "rounded-lg border px-3 py-1.5 text-xs font-medium tabular-nums " +
                (invQuota.remaining === 0
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : invQuota.remaining <= Math.max(1, Math.floor(invQuota.limit * 0.2))
                    ? "border-amber-300 bg-amber-50 text-amber-800"
                    : "border-emerald-200 bg-emerald-50 text-emerald-800")
              }
              title={invQuota.remaining === 0 ? "وصلت إلى الحد الأقصى الشهري لخطتك" : `يمكنك إصدار ${invQuota.remaining} فاتورة إضافية هذا الشهر`}
            >
              فواتير الشهر: <span className="font-bold">{invQuota.used}</span> / {invQuota.limit}
            </div>
          )}
          <Button size="sm" className="gap-2" onClick={guardedNewInvoice}>
            <Plus className="h-4 w-4" />{t("salesInvoices.newInvoice")}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: t("salesInvoices.totalInvoices"), value: invoices.length, color: "text-primary" },
          { label: t("salesInvoices.posted"),        value: invoices.filter(i => i.status === "posted").length, color: "text-green-700" },
          { label: t("salesInvoices.drafts"),        value: invoices.filter(i => i.status === "draft").length,  color: "text-amber-700" },
          { label: t("salesInvoices.totalSales"),    value: `${fmt(totalPosted)} ${t("common.currencySAR")}`,    color: "text-primary" },
        ].map((c, i) => (
          <div key={i} className="rounded-xl border bg-card p-4 shadow-sm">
            <p className="text-xs text-muted-foreground mb-1">{c.label}</p>
            <p className={cn("text-xl font-bold font-mono", c.color)}>{c.value}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-48">
          <Search className={cn("absolute top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground", isRtl ? "right-3" : "left-3")} />
          <Input className={isRtl ? "pr-9" : "pl-9"} placeholder={t("salesInvoices.searchPlaceholder")} value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-1">
          {["all", "draft", "posted", "cancelled"].map(s => (
            <button key={s} onClick={() => setFilterStatus(s)}
              className={cn("text-xs rounded-full px-3 py-1 border font-medium transition-colors",
                filterStatus === s ? "bg-primary text-primary-foreground border-primary" : "border-input bg-background hover:bg-muted"
              )}>
              {s === "all" ? t("common.all") : STATUS[s]?.label}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
        {isLoading ? (
          <div className="p-12 text-center text-muted-foreground text-sm">{t("common.loading")}</div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center">
            <FileText className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-40" />
            <p className="text-muted-foreground text-sm">{t("salesInvoices.noInvoices")}</p>
            <Button size="sm" className="mt-4 gap-2" onClick={guardedNewInvoice}>
              <Plus className="h-4 w-4" />{t("salesInvoices.createFirst")}
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 border-b">
                  {headerCells.map(h => (
                    <th key={h} className={cn("px-3 py-3 font-semibold text-muted-foreground text-xs", align)}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pager.pagedItems.map(inv => {
                  const st = STATUS[inv.status] ?? STATUS.draft;
                  const payLabel = inv.paymentType === "cash"
                    ? t("salesInvoices.paymentCash")
                    : inv.paymentType === "bank"
                      ? t("salesInvoices.paymentBank")
                      : t("salesInvoices.paymentCredit");
                  return (
                    <tr key={inv.id} className="border-b hover:bg-muted/30 transition-colors cursor-pointer"
                      onDoubleClick={() => navigate(`/sales/invoices/${inv.id}`)}
                      title={t("common.doubleClickToOpen")}>
                      <td className="px-3 py-2.5 font-mono text-xs font-semibold text-primary">{inv.docNumber ?? `SI-${inv.id}`}</td>
                      <td className="px-3 py-2.5">{inv.invoiceDate}</td>
                      <td className="px-3 py-2.5">{cusMap[inv.customerId] ?? "—"}</td>
                      <td className="px-3 py-2.5 text-muted-foreground text-xs">{payLabel}</td>
                      <td className="px-3 py-2.5">{inv.currencyCode}</td>
                      <td className="px-3 py-2.5 font-mono">{fmt(inv.subtotal)}</td>
                      <td className="px-3 py-2.5 font-mono text-amber-700">{fmt(inv.vatAmount)}</td>
                      <td className="px-3 py-2.5 font-mono font-semibold">{fmt(inv.totalAmount)}</td>
                      <td className="px-3 py-2.5">
                        {inv.paymentSettlement ? (
                          <button
                            onClick={() => navigate(`/cash/receipt-vouchers/${inv.paymentSettlement.voucherId}`)}
                            className={cn(
                              "inline-flex items-center gap-1 text-[11px] rounded-full px-2 py-0.5 font-medium border transition-colors",
                              inv.paymentSettlement.paymentType === "bank"
                                ? "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100"
                                : "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100",
                              inv.paymentSettlement.status !== "posted" && "opacity-70"
                            )}
                            title={`${inv.paymentSettlement.code} • ${fmt(inv.paymentSettlement.amount)}`}
                            data-testid={`pay-status-${inv.id}`}
                          >
                            {inv.paymentSettlement.paymentType === "bank"
                              ? t("salesInvoices.paidViaBank", "سُدِّد بنكاً")
                              : t("salesInvoices.paidViaCash", "سُدِّد نقداً")}
                            <span className="font-mono opacity-80">• {inv.paymentSettlement.code}</span>
                          </button>
                        ) : <span className="text-muted-foreground text-xs">—</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        {inv.journalEntryId ? (
                          <button onClick={() => navigate(`/accounting/journals/${inv.journalEntryId}?tab=lines`)}
                            className="font-mono text-xs text-blue-600 hover:underline">
                            JE-{inv.journalEntryId}
                          </button>
                        ) : <span className="text-muted-foreground text-xs">—</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={cn("text-xs rounded-full px-2 py-0.5 font-medium border", st.cls)}>{st.label}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        {(inv as any).createdByName ? (
                          <span className="inline-flex items-center gap-1 text-[11px] rounded-full px-2 py-0.5 font-medium border bg-emerald-50 text-emerald-700 border-emerald-200">
                            <User className="h-3 w-3" />{(inv as any).createdByName}
                          </span>
                        ) : <span className="text-muted-foreground text-xs">—</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        {(inv as any).postedByName ? (
                          <span className="inline-flex items-center gap-1 text-[11px] rounded-full px-2 py-0.5 font-medium border bg-blue-50 text-blue-700 border-blue-200">
                            <User className="h-3 w-3" />{(inv as any).postedByName}
                          </span>
                        ) : <span className="text-muted-foreground text-xs">—</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-slate-700 hover:text-primary hover:bg-muted"
                            title="طباعة"
                            onClick={() => openPrint(inv)}>
                            <Printer className="h-3.5 w-3.5" />
                          </Button>
                          {inv.status === "posted" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-orange-600 hover:text-orange-700 hover:bg-orange-50"
                              title={t("salesInvoices.createReturn")}
                              onClick={() => navigate(`/sales/returns?fromInvoice=${inv.id}`)}>
                              <RotateCcw className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {inv.status === "posted" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                              title={t("salesInvoices.unpostTitle")}
                              onClick={() => { if (confirm(t("salesInvoices.confirmUnpost"))) unpostMut.mutate(inv.id); }}>
                              <Undo2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          <Button variant="ghost" size="icon" className="h-7 w-7" title={t("common.openEdit")}
                            onClick={() => navigate(`/sales/invoices/${inv.id}`)}>
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                            title={t("common.duplicate")}
                            onClick={() => navigate(`/sales/invoices/new?from=${inv.id}`)}>
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                          {inv.status === "draft" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-green-700" title={t("common.post")}
                              onClick={() => { if (confirm(t("salesInvoices.confirmPost"))) postMut.mutate(inv.id); }}>
                              <CheckCircle className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {inv.status === "draft" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive"
                              onClick={() => { if (confirm(t("salesInvoices.confirmDelete"))) deleteMut.mutate(inv.id); }}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {filtered.length > 0 && (
          <TablePagination
            page={pager.page}
            pageSize={pager.pageSize}
            pageCount={pager.pageCount}
            total={pager.total}
            onPageChange={pager.setPage}
            onPageSizeChange={pager.setPageSize}
            itemLabel={t("salesInvoices.itemLabel", { defaultValue: "فاتورة" })}
          />
        )}
      </div>
      <SalesPrintModal
        open={!!printData}
        onClose={() => { setPrintData(null); setAutoPrintOnOpen(false); }}
        data={printData}
        defaultTemplate={printTemplate}
        autoPrintOnOpen={autoPrintOnOpen}
      />
    </div>
  );
}
