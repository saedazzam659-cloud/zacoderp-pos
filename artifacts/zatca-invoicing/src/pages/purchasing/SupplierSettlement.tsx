import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Plus, Trash2, Banknote, CheckCircle, Printer, Search, X, FileSpreadsheet } from "lucide-react";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { cn } from "@/lib/utils";
import {
  rowToneFor, SEL_TONE, DocColorLegend, buildToneTooltip, type LegendItem,
} from "@/lib/docRowTone";
import { downloadCsv, useAuditGridLayout, useColumnResize } from "@/lib/auditGridLayout";
import {
  type AdvFilter, isAdvActive, matchAdv, describeAdv,
} from "@/lib/advFilter";
import { AdvFilterPopover } from "@/components/auditGrid/AdvFilterPopover";
import {
  AuditGridBulkBar, AuditGridPagination, ColumnReorderPopover,
  FooterColorPicker, HeaderColorPicker, HeaderSelectCheckbox, RowSelectCheckbox,
} from "@/components/auditGrid/AuditGridControls";
import { buildVoucherPrintHtml, openVoucherPrintWindow } from "@/lib/voucherPrint";
import { getSaveToastTitle } from "@/lib/saveToast";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const today = () => new Date().toISOString().slice(0, 10);

const EMPTY = { docNumber: "", settlementDate: today(), supplierId: "", paymentMethod: "bank", accountId: "", amount: "", currencyCode: "SAR", exchangeRate: "1", notes: "" };

export default function SupplierSettlement() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const fmt = (n: any) => Number(n || 0).toLocaleString(isRtl ? "ar-SA" : "en-US", { minimumFractionDigits: 2 });
  const supName = (s: any) => isRtl ? (s?.nameAr ?? s?.nameEn ?? "") : (s?.nameEn ?? s?.nameAr ?? "");
  const accName = (a: any) => isRtl ? (a?.nameAr ?? a?.nameEn ?? "") : (a?.nameEn ?? a?.nameAr ?? "");

  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const cid = (user?.role === "superadmin" ? undefined : user?.company?.id) ?? undefined;
  const [search, setSearch] = useState("");
  const authH   = { Authorization: `Bearer ${token}` };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [showForm, setShowForm] = useState(false);
  const [form, setForm]         = useState<any>(EMPTY);

  const { data: settlements = [], isLoading } = useQuery<any[]>({
    queryKey: ["supplier-settlements", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/purchasing/supplier-settlements?companyId=${cid}` : `${API}/api/purchasing/supplier-settlements`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const { data: suppliers = [] } = useQuery<any[]>({
    queryKey: ["suppliers", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/suppliers?companyId=${cid}` : `${API}/api/suppliers`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const { data: accounts = [] } = useQuery<any[]>({
    queryKey: ["accounts", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/accounts?companyId=${cid}` : `${API}/api/accounts`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["supplier-settlements"] });

  // Per-doc-type print preferences for payment vouchers (سند صرف).
  const autoPrintPayment = !!(user as any)?.company?.printAutoAfterSavePayment;
  const paymentTemplate: "a4" | "thermal" =
    ((user as any)?.company?.printTemplatePayment === "thermal") ? "thermal" : "a4";

  // Print one settlement (used by the row "Print" button and by the
  // post-save auto-print hook). Resolves the supplier, account, and
  // company snapshots locally so the popup window is self-contained.
  function printOne(s: any, template: "a4" | "thermal" = paymentTemplate) {
    const supplier = suppliers.find((c: any) => Number(c.id) === Number(s.supplierId)) || null;
    const account  = accounts.find((a: any) => Number(a.id) === Number(s.accountId)) || null;
    const html = buildVoucherPrintHtml({
      kind: "payment",
      template,
      doc: s,
      counterparty: supplier,
      account,
      company: user?.company ?? null,
    });
    openVoucherPrintWindow(html);
  }

  const saveMut = useMutation({
    mutationFn: async (data: any) => {
      const res = await fetch(`${API}/api/purchasing/supplier-settlements`, { method: "POST", headers, body: JSON.stringify({ ...data, companyId: cid }) });
      const j = await res.json(); if (!res.ok) throw new Error(j.error); return j;
    },
    onSuccess: (saved: any) => {
      invalidate();
      // Open the print popup synchronously off the user-initiated save
      // click so popup blockers continue to allow it. We do this before
      // resetting the form so the supplier/account lookups still resolve.
      if (autoPrintPayment && saved) {
        try { printOne(saved, paymentTemplate); } catch { /* ignore popup-blocker noise */ }
      }
      reset();
      // Reflect whether the auto-print preference actually fired in
      // the toast wording. Posting is a separate row action here, so
      // we never set `posted: true` on the save toast.
      toast({ title: getSaveToastTitle(t, { posted: false, printed: autoPrintPayment && !!saved }) });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const postMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/purchasing/supplier-settlements/${id}/post`, { method: "PATCH", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: t("purchasingPages.supplierSettlement.toasts.posted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/purchasing/supplier-settlements/${id}`, { method: "DELETE", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
    },
    onSuccess: () => { invalidate(); toast({ title: t("purchasingPages.supplierSettlement.toasts.deleted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  function reset() { setForm(EMPTY); setShowForm(false); }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    saveMut.mutate({ ...form, supplierId: form.supplierId || null, accountId: form.accountId || null });
  }

  const supplierItems = [{ value: "", label: t("purchasingPages.supplierSettlement.selectSupplierOpt") }, ...suppliers.map((s: any) => ({ value: String(s.id), label: supName(s) }))];
  const accountItems  = [{ value: "", label: t("purchasingPages.supplierSettlement.selectAccountOpt") }, ...accounts.filter((a: any) => a.isPosting).map((a: any) => ({ value: String(a.id), label: `${a.code} — ${accName(a)}` }))];
  const supMap = Object.fromEntries(suppliers.map((s: any) => [s.id, supName(s)]));
  const accMap = Object.fromEntries(accounts.map((a: any) => [a.id, `${a.code} — ${accName(a)}`]));

  const totalPosted = settlements.filter((s: any) => s.status === "posted").reduce((t: number, s: any) => t + Number(s.amount || 0), 0);

  const methodLabel = (m: string) => m === "bank"
    ? t("purchasingPages.supplierSettlement.methods.bank")
    : m === "cash"
      ? t("purchasingPages.supplierSettlement.methods.cash")
      : t("purchasingPages.supplierSettlement.methods.check");

  const filteredBySearch = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return settlements;
    return settlements.filter((s: any) =>
      String(s.docNumber ?? "").toLowerCase().includes(q) ||
      String(s.settlementDate ?? "").includes(q) ||
      String(supMap[s.supplierId] ?? "").toLowerCase().includes(q) ||
      String(accMap[s.accountId] ?? "").toLowerCase().includes(q) ||
      String(s.amount ?? "").includes(q)
    );
  }, [settlements, search, supMap, accMap]);

  // ── Audit-grid layout ──
  type ColType = "text" | "num" | "none";
  interface ColDef { key: string; label: string; type: ColType; valueOf: (r: any) => string | number }
  const COLUMNS: ColDef[] = useMemo(() => [
    { key: "_sel",     label: "",                                                         type: "none", valueOf: () => "" },
    { key: "_idx",     label: "#",                                                        type: "none", valueOf: () => "" },
    { key: "docNumber", label: t("purchasingPages.supplierSettlement.cols.docNumber"),    type: "text", valueOf: (s) => s.docNumber ?? `SS-${s.id}` },
    { key: "date",     label: t("purchasingPages.supplierSettlement.cols.date"),          type: "text", valueOf: (s) => s.settlementDate ?? "" },
    { key: "supplier", label: t("purchasingPages.supplierSettlement.cols.supplier"),      type: "text", valueOf: (s) => supMap[s.supplierId] ?? "" },
    { key: "method",   label: t("purchasingPages.supplierSettlement.cols.method"),        type: "text", valueOf: (s) => methodLabel(s.paymentMethod) },
    { key: "account",  label: t("purchasingPages.supplierSettlement.cols.account"),       type: "text", valueOf: (s) => accMap[s.accountId] ?? "" },
    { key: "amount",   label: t("purchasingPages.supplierSettlement.cols.amount"),        type: "num",  valueOf: (s) => Number(s.amount) || 0 },
    { key: "currency", label: t("purchasingPages.supplierSettlement.cols.currency"),      type: "text", valueOf: (s) => s.currencyCode ?? "" },
    { key: "status",   label: t("purchasingPages.supplierSettlement.cols.status"),        type: "text", valueOf: (s) => s.status === "posted" ? t("purchasingPages.supplierSettlement.postedF") : t("purchasingPages.supplierSettlement.draft") },
    { key: "_act",     label: t("purchasingPages.supplierSettlement.cols.actions"),       type: "none", valueOf: () => "" },
  ], [t, supMap, accMap]);
  const dataKeys = useMemo(() => COLUMNS.filter(c => !["_sel","_idx","_act"].includes(c.key)).map(c => c.key), [COLUMNS]);
  const allColKeys = useMemo(() => COLUMNS.map(c => c.key), [COLUMNS]);
  const layout = useAuditGridLayout({ screenSlug: "supplierSettlement", cid, dataKeys, allColKeys });
  const { tableRef, gripProps } = useColumnResize(layout.setColWidths);
  const { theme, colWidths, colFilters, clearColFilters,
          isSelected, toggleRow, toggleAll, isAllSelected, isSomeSelected, clearSelection,
          pageSize, page, setPage } = layout;


  // Per-column advanced filter (two conditions joined by AND/OR) — shared
  // primitives in lib/advFilter.ts + components/auditGrid/AdvFilterPopover.
  const [colAdv, setColAdv] = useState<Record<string, AdvFilter>>({});
  const clearColAdv = (key: string) =>
    setColAdv(prev => { const n = { ...prev }; delete n[key]; return n; });
  const clearAllColFilters = () => { clearColFilters(); setColAdv({}); };
  const filtered = useMemo(() => filteredBySearch.filter((s: any) => {
    for (const col of COLUMNS) {
      const adv = colAdv[col.key];
      if (!isAdvActive(adv)) continue;
      if (!matchAdv(col.valueOf(s), adv, col.type)) return false;
    }
    return true;
  }), [filteredBySearch, colAdv, COLUMNS]);

  const totalPages = pageSize === 0 ? 1 : Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  useEffect(() => { if (safePage !== page) setPage(safePage); }, [safePage, page, setPage]);
  const paged = useMemo(() => pageSize === 0 ? filtered : filtered.slice((safePage - 1) * pageSize, safePage * pageSize), [filtered, pageSize, safePage]);
  const pageStart = filtered.length === 0 ? 0 : pageSize === 0 ? 1 : (safePage - 1) * pageSize + 1;
  const pageEnd = pageSize === 0 ? filtered.length : Math.min(safePage * pageSize, filtered.length);

  const visibleColumns = useMemo(() => {
    const dataCols = layout.dataOrder.map(k => COLUMNS.find(c => c.key === k)).filter((c): c is ColDef => !!c);
    const sel = COLUMNS.find(c => c.key === "_sel")!;
    const idx = COLUMNS.find(c => c.key === "_idx")!;
    const act = COLUMNS.find(c => c.key === "_act")!;
    return [sel, idx, ...dataCols, act];
  }, [layout.dataOrder, COLUMNS]);
  const reorderableCols = useMemo(() => layout.dataOrder
    .map(k => COLUMNS.find(c => c.key === k)!)
    .map(c => ({ key: c.key, label: c.label })), [layout.dataOrder, COLUMNS]);
  const allFilteredIds = useMemo(() => filtered.map((s: any) => s.id as number), [filtered]);

  function exportCsv() {
    if (filtered.length === 0) {
      toast({ title: t("purchasingPages.supplierSettlement.noSettlements"), variant: "destructive" });
      return;
    }
    const exportable = visibleColumns.filter(c => !["_sel","_idx","_act"].includes(c.key));
    const header = ["#", ...exportable.map(c => c.label)];
    const rows = filtered.map((s: any, i: number) => [
      i + 1,
      ...exportable.map(col => {
        const v = col.valueOf(s);
        return col.type === "num" ? Number(v).toFixed(2) : String(v ?? "");
      }),
    ]);
    downloadCsv(`supplier-settlements-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
  }

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Banknote className="h-6 w-6 text-primary" />{t("purchasingPages.supplierSettlement.title")}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t("purchasingPages.supplierSettlement.subtitle")}</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
          <Plus className="h-4 w-4" />{t("purchasingPages.supplierSettlement.newSettlement")}
        </Button>
      </div>

      {showForm && (
        <FormPanel
          icon={Banknote}
          title={t("purchasingPages.supplierSettlement.newDialogTitle")}
          subtitle={t("purchasingPages.supplierSettlement.newDialogSubtitle")}
          width="4xl"
          onClose={reset}
          onSave={() => handleSubmit({ preventDefault() {} } as any)}
          saving={saveMut.isPending}
          saveDisabled={!form.settlementDate || !form.supplierId || !form.amount}
          saveLabel={t("purchasingPages.supplierSettlement.saveLabel")}
          footer={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() =>
                toast({
                  title: "احفظ التسوية أولاً قبل الطباعة",
                  description: "بعد الحفظ سيظهر زر طباعة بجانب كل سند في القائمة.",
                })
              }
              data-testid="ss-print"
            >
              <Printer className="h-3.5 w-3.5" />
              طباعة
            </Button>
          }
        >
          <FormGrid>
            <Field label={t("purchasingPages.supplierSettlement.fields.docNumber")}><Input placeholder={t("purchasingPages.supplierSettlement.fields.docNumberPh")} value={form.docNumber} onChange={e => setForm((p: any) => ({ ...p, docNumber: e.target.value }))} /></Field>
            <Field label={t("purchasingPages.supplierSettlement.fields.date")} required><Input type="date" value={form.settlementDate} onChange={e => setForm((p: any) => ({ ...p, settlementDate: e.target.value }))} /></Field>
            <Field label={t("purchasingPages.supplierSettlement.fields.supplier")} required className="md:col-span-2">
              <SearchCombobox items={supplierItems} value={form.supplierId} onValueChange={v => setForm((p: any) => ({ ...p, supplierId: v }))} placeholder={t("purchasingPages.supplierSettlement.fields.supplierPh")} />
            </Field>
            <Field label={t("purchasingPages.supplierSettlement.fields.paymentMethod")}>
              <Select value={form.paymentMethod} onValueChange={v => setForm((p: any) => ({ ...p, paymentMethod: v }))}>
                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="bank">{t("purchasingPages.supplierSettlement.methods.bank")}</SelectItem>
                  <SelectItem value="cash">{t("purchasingPages.supplierSettlement.methods.cash")}</SelectItem>
                  <SelectItem value="check">{t("purchasingPages.supplierSettlement.methods.check")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("purchasingPages.supplierSettlement.fields.bankAccount")}>
              <SearchCombobox items={accountItems} value={form.accountId} onValueChange={v => setForm((p: any) => ({ ...p, accountId: v }))} placeholder={t("purchasingPages.supplierSettlement.fields.accountPh")} />
            </Field>
            <Field label={t("purchasingPages.supplierSettlement.fields.amount")} required><Input type="text" inputMode="decimal" placeholder="0.00" dir="ltr" className="text-left" value={form.amount} onChange={e => setForm((p: any) => ({ ...p, amount: e.target.value.replace(/[^0-9.]/g, "") }))} /></Field>
            <Field label={t("purchasingPages.supplierSettlement.fields.currency")}><Input placeholder="SAR" dir="ltr" className="text-left" value={form.currencyCode} onChange={e => setForm((p: any) => ({ ...p, currencyCode: e.target.value }))} /></Field>
            <Field label={t("purchasingPages.supplierSettlement.fields.notes")} className="md:col-span-2">
              <Textarea className="resize-none text-sm" rows={2} value={form.notes} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} />
            </Field>
          </FormGrid>
        </FormPanel>
      )}

      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <p className="text-xs text-muted-foreground mb-1">{t("purchasingPages.supplierSettlement.stats.total")}</p>
          <p className="text-xl font-bold text-primary">{settlements.length}</p>
        </div>
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <p className="text-xs text-muted-foreground mb-1">{t("purchasingPages.supplierSettlement.stats.posted")}</p>
          <p className="text-xl font-bold text-green-700">{settlements.filter((s: any) => s.status === "posted").length}</p>
        </div>
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <p className="text-xs text-muted-foreground mb-1">{t("purchasingPages.supplierSettlement.stats.totalPaid")}</p>
          <p className="text-xl font-bold font-mono text-primary">{fmt(totalPosted)}</p>
        </div>
      </div>

      {(() => {
        const items: LegendItem[] = [
          { kind: "draft",  count: settlements.filter((s: any) => s.status === "draft").length },
          { kind: "posted", count: settlements.filter((s: any) => s.status === "posted").length },
        ];
        return <DocColorLegend items={items} />;
      })()}

      <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
        {/* Audit-grid toolbar */}
        <div className={cn("border-b shadow-sm transition-colors", theme.border)}>
          <div className={cn("px-3 py-2 flex items-center gap-2 flex-wrap transition-colors", theme.bar, theme.text)} dir="rtl">
            <div className={cn("flex-1 text-sm font-bold tracking-wide flex items-center gap-2", theme.text)}>
              <Banknote className="h-4 w-4 opacity-90" />
              {t("purchasingPages.supplierSettlement.title")}
            </div>
            <div className="flex items-center gap-1.5">
              <HeaderColorPicker layout={layout} isRtl={isRtl} />
              <FooterColorPicker layout={layout} isRtl={isRtl} />
              <ColumnReorderPopover layout={layout} isRtl={isRtl} columns={reorderableCols} />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className={cn("h-7 px-2 text-xs gap-1", theme.btn)}
                onClick={exportCsv}
                data-testid="btn-export-csv-supplier-settlement"
              >
                <FileSpreadsheet className="h-3.5 w-3.5" />
                CSV
              </Button>
            </div>
          </div>
          <div className="bg-slate-50 border-t border-slate-200 px-3 py-2 flex items-center gap-2 flex-wrap text-xs" dir="rtl">
            <div className="relative">
              <Search className="absolute end-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder={t("common.search")}
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pe-7 h-7 text-xs w-64"
              />
            </div>
            {(Object.values(colFilters).some(v => v) || Object.values(colAdv).some(isAdvActive)) && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs text-rose-700 hover:bg-rose-50"
                onClick={clearAllColFilters}
              >
                <X className="h-3.5 w-3.5 me-1" />
                مسح فلاتر الأعمدة
              </Button>
            )}
            <div className="flex-1" />
            <span className="text-slate-700 font-medium">
              {filtered.length} تسوية
              {filtered.length !== settlements.length && <span className="text-slate-400"> / {settlements.length}</span>}
            </span>
          </div>
          <AuditGridBulkBar count={layout.selected.size} onClear={clearSelection}>
            <span className="text-emerald-800">تم تحديد {layout.selected.size} تسوية</span>
          </AuditGridBulkBar>
        </div>

        {/* Audit-grid table */}
        <div className="overflow-x-auto bg-white">
          <table ref={tableRef} className="w-full text-[11px] border-collapse" dir="rtl">
            <colgroup>
              {visibleColumns.map((col) => (
                <col
                  key={col.key}
                  data-col-key={col.key}
                  style={colWidths[col.key] ? { width: `${colWidths[col.key]}px` } : undefined}
                />
              ))}
            </colgroup>
            <thead className="sticky top-0 z-10">
              <tr className="bg-gradient-to-b from-slate-100 to-slate-200 text-slate-700">
                {visibleColumns.map((col, idx) => (
                  <th
                    key={col.key}
                    data-col-key={col.key}
                    className={cn(
                      "relative px-2 py-1.5 text-right font-semibold border-e border-slate-300 select-none",
                      col.key === "_sel" && "w-9 text-center px-1",
                      col.key === "_idx" && "w-10 text-center px-1",
                      col.key === "_act" && "w-28 text-center",
                      col.type === "num" && "text-end",
                    )}
                  >
                    {col.key === "_sel" ? (
                      <HeaderSelectCheckbox
                        allSelected={isAllSelected(allFilteredIds)}
                        someSelected={isSomeSelected(allFilteredIds)}
                        onToggle={() => toggleAll(allFilteredIds)}
                        disabled={allFilteredIds.length === 0}
                      />
                    ) : (
                      <span className="inline-flex items-center gap-1"><span className="inline-block truncate">{col.label}</span>{col.type !== "none" && (<AdvFilterPopover colLabel={col.label || col.key} colType={col.type} value={colAdv[col.key]} active={isAdvActive(colAdv[col.key])} onApply={v => setColAdv(prev => ({ ...prev, [col.key]: v }))} onClear={() => clearColAdv(col.key)} />)}</span>
                    )}
                    {col.key !== "_sel" && (
                      <span
                        {...gripProps(col.key, idx)}
                        className="absolute inset-y-0 start-0 w-1 cursor-col-resize hover:bg-blue-400/40 active:bg-blue-500/60"
                      />
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={visibleColumns.length} className="p-12 text-center text-muted-foreground text-sm">{t("purchasingPages.supplierSettlement.loading")}</td></tr>
              ) : paged.length === 0 ? (
                <tr><td colSpan={visibleColumns.length} className="p-12 text-center text-muted-foreground text-sm">{t("purchasingPages.supplierSettlement.noSettlements")}</td></tr>
              ) : (
                paged.map((s: any, rowIdx: number) => {
                  const sel = isSelected(s.id);
                  return (
                    <tr key={s.id}
                      data-status={s.status}
                      className={cn(
                        "border-b border-slate-200 transition-colors group",
                        sel ? SEL_TONE : rowToneFor({ status: s.status }),
                      )}
                      title={buildToneTooltip({ status: s.status })}
                    >
                      {visibleColumns.map((col) => {
                        if (col.key === "_sel") {
                          return (
                            <td key={col.key} className="px-1 py-1 text-center border-e border-slate-200/60">
                              <RowSelectCheckbox
                                checked={sel}
                                onToggle={() => toggleRow(s.id)}
                                ariaLabel={`تحديد ${s.docNumber ?? s.id}`}
                              />
                            </td>
                          );
                        }
                        if (col.key === "_idx") {
                          return (
                            <td key={col.key} className="px-1 py-1 text-center text-slate-500 font-mono border-e border-slate-200/60">
                              {pageStart + rowIdx}
                            </td>
                          );
                        }
                        if (col.key === "docNumber") {
                          return <td key={col.key} className="px-2 py-1 font-mono text-[10px] font-semibold text-primary border-e border-slate-200/60">{s.docNumber ?? `SS-${s.id}`}</td>;
                        }
                        if (col.key === "date") {
                          return <td key={col.key} className="px-2 py-1 border-e border-slate-200/60">{s.settlementDate}</td>;
                        }
                        if (col.key === "supplier") {
                          return <td key={col.key} className="px-2 py-1 border-e border-slate-200/60 truncate">{supMap[s.supplierId] ?? "—"}</td>;
                        }
                        if (col.key === "method") {
                          return <td key={col.key} className="px-2 py-1 text-muted-foreground border-e border-slate-200/60">{methodLabel(s.paymentMethod)}</td>;
                        }
                        if (col.key === "account") {
                          return <td key={col.key} className="px-2 py-1 text-muted-foreground border-e border-slate-200/60 truncate">{accMap[s.accountId] ?? "—"}</td>;
                        }
                        if (col.key === "amount") {
                          return <td key={col.key} className="px-2 py-1 font-mono font-semibold tabular-nums text-end border-e border-slate-200/60">{fmt(s.amount)}</td>;
                        }
                        if (col.key === "currency") {
                          return <td key={col.key} className="px-2 py-1 border-e border-slate-200/60">{s.currencyCode}</td>;
                        }
                        if (col.key === "status") {
                          return (
                            <td key={col.key} className="px-2 py-1 border-e border-slate-200/60">
                              <span className={cn("text-[10px] rounded-full px-1.5 py-0.5 font-medium border",
                                s.status === "posted" ? "bg-green-50 text-green-700 border-green-200" : "bg-amber-50 text-amber-700 border-amber-200"
                              )}>{s.status === "posted" ? t("purchasingPages.supplierSettlement.postedF") : t("purchasingPages.supplierSettlement.draft")}</span>
                            </td>
                          );
                        }
                        if (col.key === "_act") {
                          return (
                            <td key={col.key} className="px-1 py-1">
                              <div className="flex items-center justify-center gap-0.5">
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-primary" title="طباعة سند الصرف"
                                  onClick={() => printOne(s)}>
                                  <Printer className="h-3.5 w-3.5" />
                                </Button>
                                {s.status === "draft" && (
                                  <Button variant="ghost" size="icon" className="h-6 w-6 text-green-700" title={t("purchasingPages.supplierSettlement.postTip")}
                                    onClick={() => { if (confirm(t("purchasingPages.supplierSettlement.confirmPost"))) postMut.mutate(s.id); }}>
                                    <CheckCircle className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                                {s.status === "draft" && (
                                  <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive"
                                    onClick={() => { if (confirm(t("purchasingPages.supplierSettlement.confirmDelete"))) deleteMut.mutate(s.id); }}>
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                              </div>
                            </td>
                          );
                        }
                        return null;
                      })}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <AuditGridPagination
          layout={layout}
          totalRows={filtered.length}
          pageStart={pageStart}
          pageEnd={pageEnd}
          totalPages={totalPages}
          unitLabel="تسوية"
        />
      </div>

    </div>
  );
}
