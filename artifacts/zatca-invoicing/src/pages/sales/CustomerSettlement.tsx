import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "react-i18next";
import { getSaveToastTitle } from "@/lib/saveToast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchCombobox } from "@/components/ui/search-combobox";
import {
  Plus, Trash2, ArrowDownCircle, CheckCircle, Printer, FileSpreadsheet, X,
  Loader2, Send,
} from "lucide-react";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { cn } from "@/lib/utils";
import { buildVoucherPrintHtml, openVoucherPrintWindow } from "@/lib/voucherPrint";
import {
  downloadCsv, matchCol, useAuditGridLayout, useColumnResize,
} from "@/lib/auditGridLayout";
import {
  AuditGridBulkBar, AuditGridPagination, ColumnReorderPopover,
  FooterColorPicker, HeaderColorPicker, HeaderSelectCheckbox, RowSelectCheckbox,
} from "@/components/auditGrid/AuditGridControls";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const fmt = (n: any) => Number(n || 0).toLocaleString("ar-SA", { minimumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);

const EMPTY = { docNumber: "", settlementDate: today(), customerId: "", paymentMethod: "bank", accountId: "", amount: "", currencyCode: "SAR", exchangeRate: "1", notes: "" };

/* Column descriptors for the audit-grid table. `_idx` and `_act` are pinned
   at the start/end and are not part of the reorderable data set. */
type ColDef = { key: string; label: string; type: "text" | "num" | "none"; valueOf: (s: any, ctx: Ctx) => string | number };
type Ctx = { cusMap: Record<number, string>; accMap: Record<number, string> };

const PAYMENT_LABEL: Record<string, string> = {
  bank:  "تحويل بنكي",
  cash:  "نقدي",
  check: "شيك",
};

const COLUMNS: ColDef[] = [
  { key: "_sel",     label: "",             type: "none", valueOf: () => "" },
  { key: "_idx",     label: "#",            type: "none", valueOf: () => "" },
  { key: "doc",      label: "رقم المستند",  type: "text", valueOf: (s) => s.docNumber ?? `CR-${s.id}` },
  { key: "date",     label: "التاريخ",      type: "text", valueOf: (s) => s.settlementDate ?? "" },
  { key: "customer", label: "العميل",       type: "text", valueOf: (s, c) => c.cusMap[s.customerId] ?? "" },
  { key: "payment",  label: "طريقة الدفع",  type: "text", valueOf: (s) => PAYMENT_LABEL[s.paymentMethod] ?? s.paymentMethod ?? "" },
  { key: "account",  label: "الحساب",       type: "text", valueOf: (s, c) => c.accMap[s.accountId] ?? "" },
  { key: "amount",   label: "المبلغ",       type: "num",  valueOf: (s) => Number(s.amount ?? 0) },
  { key: "currency", label: "العملة",       type: "text", valueOf: (s) => s.currencyCode ?? "" },
  { key: "notes",    label: "ملاحظات",      type: "text", valueOf: (s) => s.notes ?? "" },
  { key: "status",   label: "الحالة",       type: "text", valueOf: (s) => s.status === "posted" ? "مرحّلة" : "مسودة" },
  { key: "_act",     label: "إجراءات",      type: "none", valueOf: () => "" },
];
const DATA_KEYS = COLUMNS.filter(c => c.key !== "_sel" && c.key !== "_idx" && c.key !== "_act").map(c => c.key);
const ALL_KEYS  = COLUMNS.map(c => c.key);

export default function CustomerSettlement() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const qc = useQueryClient();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const authH   = { Authorization: `Bearer ${token}` };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [showForm, setShowForm] = useState(false);
  const [form, setForm]         = useState<any>(EMPTY);
  const [search, setSearch]     = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "draft" | "posted">("all");

  const layout = useAuditGridLayout({
    screenSlug: "customerSettlementAuditGrid",
    cid,
    dataKeys: DATA_KEYS,
    allColKeys: ALL_KEYS,
  });
  const { tableRef, gripProps } = useColumnResize(layout.setColWidths);

  const { data: settlements = [], isLoading } = useQuery<any[]>({
    queryKey: ["customer-settlements", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/sales/customer-settlements?companyId=${cid}` : `${API}/api/sales/customer-settlements`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const { data: customers = [] } = useQuery<any[]>({
    queryKey: ["customers", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/customers?companyId=${cid}` : `${API}/api/customers`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const { data: accounts = [] } = useQuery<any[]>({
    queryKey: ["accounts", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/accounts?companyId=${cid}` : `${API}/api/accounts`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["customer-settlements"] });

  // Pull the per-doc-type print preferences for receipt vouchers so
  // the form can auto-print after save and the row-level button can
  // honour the chosen template (A4 vs thermal).
  const autoPrintReceipt = !!(user as any)?.company?.printAutoAfterSaveReceipt;
  const receiptTemplate: "a4" | "thermal" =
    ((user as any)?.company?.printTemplateReceipt === "thermal") ? "thermal" : "a4";

  // Print one settlement (used by the row "Print" button and by the
  // post-save auto-print hook). Resolves the customer, account, and
  // company snapshots locally so the popup is fully self-contained.
  function printOne(s: any, template: "a4" | "thermal" = receiptTemplate) {
    const customer = customers.find((c: any) => Number(c.id) === Number(s.customerId)) || null;
    const account  = accounts.find((a: any) => Number(a.id) === Number(s.accountId)) || null;
    const html = buildVoucherPrintHtml({
      kind: "receipt",
      template,
      doc: s,
      counterparty: customer,
      account,
      company: user?.company ?? null,
    });
    openVoucherPrintWindow(html);
  }

  const saveMut = useMutation({
    mutationFn: async (data: any) => {
      const res = await fetch(`${API}/api/sales/customer-settlements`, { method: "POST", headers, body: JSON.stringify({ ...data, companyId: cid }) });
      const j = await res.json(); if (!res.ok) throw new Error(j.error); return j;
    },
    onSuccess: (saved: any) => {
      invalidate();
      // Open the print popup synchronously off the user-initiated save
      // click so popup blockers continue to allow it. We do this before
      // resetting the form so customer/account lookups still resolve.
      if (autoPrintReceipt && saved) {
        try { printOne(saved, receiptTemplate); } catch { /* ignore popup-blocker noise */ }
      }
      reset();
      toast({ title: getSaveToastTitle(t, { posted: false, printed: autoPrintReceipt && !!saved }) });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const postMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/sales/customer-settlements/${id}/post`, { method: "PATCH", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: "تم ترحيل التحصيل" }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/sales/customer-settlements/${id}`, { method: "DELETE", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
    },
    onSuccess: () => { invalidate(); toast({ title: "تم الحذف" }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  /* ── Bulk-action helpers ─────────────────────────────────────────────── */
  const [bulkBusy, setBulkBusy] = useState(false);

  // Run a one-by-one bulk operation against the selected ids and surface
  // an aggregated success/failure toast. We deliberately avoid Promise.all
  // because the backend posts each settlement transactionally and racing
  // multiple identical companies can hit ledger conflicts.
  async function bulkRun(
    ids: number[],
    fn: (id: number) => Promise<any>,
    successMsg: (ok: number) => string,
  ): Promise<void> {
    if (ids.length === 0) return;
    setBulkBusy(true);
    let ok = 0;
    const failures: string[] = [];
    for (const id of ids) {
      try { await fn(id); ok++; } catch (e: any) { failures.push(e?.message || String(e)); }
    }
    setBulkBusy(false);
    invalidate();
    layout.clearSelection();
    if (ok > 0) toast({ title: successMsg(ok) });
    if (failures.length > 0) {
      toast({
        title: `فشل ${failures.length} عنصر`,
        description: failures.slice(0, 3).join(" • "),
        variant: "destructive",
      });
    }
  }

  // Settlements API only supports POST and DELETE on draft rows. We surface
  // the available subset so the toolbar buttons can show the actionable count.
  const selectedIds = useMemo(
    () => Array.from(layout.selected).map((x) => Number(x)).filter((n) => Number.isFinite(n)),
    [layout.selected],
  );
  const { selectedDrafts, selectedDeletable } = useMemo(() => {
    const drafts: number[] = [];
    const deletable: number[] = [];
    const sset = new Set(selectedIds);
    for (const s of (settlements as any[])) {
      const id = Number(s.id);
      if (!sset.has(id)) continue;
      if (s.status === "draft") { drafts.push(id); deletable.push(id); }
    }
    return { selectedDrafts: drafts, selectedDeletable: deletable };
  }, [selectedIds, settlements]);

  async function bulkPost() {
    if (selectedDrafts.length === 0) return;
    if (!confirm(`ترحيل ${selectedDrafts.length} تحصيل؟`)) return;
    await bulkRun(
      selectedDrafts,
      async (id) => {
        const res = await fetch(`${API}/api/sales/customer-settlements/${id}/post`, { method: "PATCH", headers });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `HTTP ${res.status}`); }
      },
      (ok) => `تم ترحيل ${ok} تحصيل`,
    );
  }
  async function bulkDelete() {
    if (selectedDeletable.length === 0) return;
    const skipped = selectedIds.length - selectedDeletable.length;
    const msg = skipped > 0
      ? `حذف ${selectedDeletable.length} تحصيل (مسوّدة)؟ سيتم تجاهل ${skipped} تحصيل مرحَّل.`
      : `حذف ${selectedDeletable.length} تحصيل؟`;
    if (!confirm(msg)) return;
    await bulkRun(
      selectedDeletable,
      async (id) => {
        const res = await fetch(`${API}/api/sales/customer-settlements/${id}`, { method: "DELETE", headers });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `HTTP ${res.status}`); }
      },
      (ok) => `تم حذف ${ok} تحصيل`,
    );
  }

  function reset() { setForm(EMPTY); setShowForm(false); }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    saveMut.mutate({ ...form, customerId: form.customerId || null, accountId: form.accountId || null });
  }

  const customerItems = [{ value: "", label: "— اختر العميل —" }, ...customers.map((c: any) => ({ value: String(c.id), label: c.nameAr ?? c.nameEn ?? `#${c.id}` }))];
  const accountItems  = [{ value: "", label: "— حساب البنك/الخزنة —" }, ...accounts.filter((a: any) => a.isPosting).map((a: any) => ({ value: String(a.id), label: `${a.code} — ${a.nameAr}` }))];
  const cusMap: Record<number, string> = useMemo(
    () => Object.fromEntries(customers.map((c: any) => [c.id, c.nameAr ?? c.nameEn ?? ""])),
    [customers],
  );
  const accMap: Record<number, string> = useMemo(
    () => Object.fromEntries(accounts.map((a: any) => [a.id, `${a.code} — ${a.nameAr}`])),
    [accounts],
  );
  const ctx: Ctx = { cusMap, accMap };

  /* ── Filtering ── */
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (settlements as any[]).filter((s) => {
      if (statusFilter !== "all" && s.status !== statusFilter) return false;
      if (q) {
        const hay = [
          s.docNumber, `CR-${s.id}`, s.settlementDate, cusMap[s.customerId],
          accMap[s.accountId], s.notes,
        ].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      // Per-column filters.
      for (const col of COLUMNS) {
        const f = layout.colFilters[col.key];
        if (!f) continue;
        if (!matchCol(col.valueOf(s, ctx), f, col.type)) return false;
      }
      return true;
    });
  }, [settlements, search, statusFilter, layout.colFilters, cusMap, accMap, ctx]);

  /* ── Pagination ── */
  const { pageSize, page, setPage } = layout;
  const totalPages = pageSize === 0 ? 1 : Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  if (safePage !== page) setPage(safePage);
  const paged = useMemo(
    () => pageSize === 0 ? filtered : filtered.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filtered, pageSize, safePage],
  );
  const pageStart = filtered.length === 0 ? 0 : pageSize === 0 ? 1 : (safePage - 1) * pageSize + 1;
  const pageEnd   = pageSize === 0 ? filtered.length : Math.min(safePage * pageSize, filtered.length);

  /* ── Totals ── */
  const totals = useMemo(() => {
    return filtered.reduce(
      (a, s: any) => { a.amount += Number(s.amount ?? 0); return a; },
      { amount: 0 },
    );
  }, [filtered]);

  /* ── Visible columns in the user's saved order ── */
  const visibleColumns = useMemo(() => {
    const dataCols = layout.dataOrder
      .map((k) => COLUMNS.find((c) => c.key === k))
      .filter((c): c is ColDef => !!c);
    const sel = COLUMNS.find((c) => c.key === "_sel")!;
    const idx = COLUMNS.find((c) => c.key === "_idx")!;
    const act = COLUMNS.find((c) => c.key === "_act")!;
    return [sel, idx, ...dataCols, act];
  }, [layout.dataOrder]);
  const reorderableCols = useMemo(
    () => DATA_KEYS.map((k) => COLUMNS.find((c) => c.key === k)!).map((c) => ({ key: c.key, label: c.label })),
    [],
  );

  /* ── CSV export ── */
  function exportCsv() {
    if (filtered.length === 0) {
      toast({ title: "لا يوجد بيانات للتصدير", variant: "destructive" });
      return;
    }
    const header = ["#", ...visibleColumns.filter((c) => c.key !== "_sel" && c.key !== "_idx" && c.key !== "_act").map((c) => c.label)];
    const rows = filtered.map((s: any, i: number) => [
      i + 1,
      ...visibleColumns
        .filter((c) => c.key !== "_sel" && c.key !== "_idx" && c.key !== "_act")
        .map((c) => {
          const v = c.valueOf(s, ctx);
          return c.type === "num" ? Number(v).toFixed(2) : String(v);
        }),
    ]);
    downloadCsv(`customer-settlements-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
    toast({ title: "تم تصدير ملف CSV بنجاح" });
  }

  const { theme, footerTheme, colWidths, colFilters, setColFilter, clearColFilters } = layout;

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><ArrowDownCircle className="h-6 w-6 text-primary" />تحصيل العملاء</h1>
          <p className="text-sm text-muted-foreground mt-1">قبض مستحقات العملاء وترحيل القيود</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
          <Plus className="h-4 w-4" />تحصيل جديد
        </Button>
      </div>

      {showForm && (
        <FormPanel
          icon={ArrowDownCircle}
          title="تحصيل جديد"
          subtitle="قبض مستحقات العميل عبر بنك أو نقد أو شيك"
          width="4xl"
          onClose={reset}
          onSave={() => handleSubmit({ preventDefault() {} } as any)}
          saving={saveMut.isPending}
          saveDisabled={!form.settlementDate || !form.customerId || !form.amount}
          saveLabel="حفظ التحصيل"
          footer={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() =>
                toast({
                  title: "احفظ التحصيل أولاً قبل الطباعة",
                  description: "بعد الحفظ سيظهر زر طباعة بجانب كل سند في القائمة.",
                })
              }
              data-testid="cs-print"
            >
              <Printer className="h-3.5 w-3.5" />
              طباعة
            </Button>
          }
        >
          <FormGrid>
            <Field label="رقم المستند"><Input placeholder="تلقائي" dir="ltr" className="text-left" value={form.docNumber} onChange={e => setForm((p: any) => ({ ...p, docNumber: e.target.value }))} /></Field>
            <Field label="التاريخ" required><Input type="date" value={form.settlementDate} onChange={e => setForm((p: any) => ({ ...p, settlementDate: e.target.value }))} /></Field>
            <Field label="العميل" required className="md:col-span-2">
              <SearchCombobox items={customerItems} value={form.customerId} onValueChange={v => setForm((p: any) => ({ ...p, customerId: v }))} placeholder="اختر العميل..." />
            </Field>
            <Field label="طريقة الدفع">
              <Select value={form.paymentMethod} onValueChange={v => setForm((p: any) => ({ ...p, paymentMethod: v }))}>
                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="bank">تحويل بنكي</SelectItem><SelectItem value="cash">نقدي</SelectItem><SelectItem value="check">شيك</SelectItem></SelectContent>
              </Select>
            </Field>
            <Field label="حساب البنك / الخزنة">
              <SearchCombobox items={accountItems} value={form.accountId} onValueChange={v => setForm((p: any) => ({ ...p, accountId: v }))} placeholder="اختر الحساب..." />
            </Field>
            <Field label="المبلغ" required><Input type="text" inputMode="decimal" placeholder="0.00" dir="ltr" className="text-left" value={form.amount} onChange={e => setForm((p: any) => ({ ...p, amount: e.target.value.replace(/[^0-9.]/g, "") }))} /></Field>
            <Field label="العملة"><Input placeholder="SAR" dir="ltr" className="text-left" value={form.currencyCode} onChange={e => setForm((p: any) => ({ ...p, currencyCode: e.target.value }))} /></Field>
            <Field label="ملاحظات" className="md:col-span-2">
              <Textarea className="resize-none text-sm" rows={2} value={form.notes} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} />
            </Field>
          </FormGrid>
        </FormPanel>
      )}

      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <p className="text-xs text-muted-foreground mb-1">إجمالي التحصيلات</p>
          <p className="text-xl font-bold text-primary">{settlements.length}</p>
        </div>
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <p className="text-xs text-muted-foreground mb-1">المرحّلة</p>
          <p className="text-xl font-bold text-green-700">{settlements.filter((s: any) => s.status === "posted").length}</p>
        </div>
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <p className="text-xs text-muted-foreground mb-1">إجمالي المُحصَّل</p>
          <p className="text-xl font-bold font-mono text-primary">{fmt(totals.amount)}</p>
        </div>
      </div>

      {/* ── Audit-grid toolbar ───────────────────────────────────────────── */}
      <div className={cn("rounded-t-lg overflow-hidden border shadow-sm transition-colors", theme.border)}>
        <div className={cn("px-3 py-2 flex items-center gap-2 flex-wrap transition-colors", theme.bar, theme.text)}>
          <div className={cn("flex-1 text-sm font-bold tracking-wide flex items-center gap-2", theme.text)}>
            <FileSpreadsheet className="h-4 w-4 opacity-90" />
            جرد سندات تحصيل العملاء
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

        {/* Filter strip */}
        <div className="bg-slate-50 border-t border-slate-200 px-3 py-2 flex items-center gap-2 flex-wrap text-xs">
          <Input
            placeholder="بحث (مستند، عميل، حساب، ملاحظات)…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 text-xs w-56"
          />
          <div className="flex gap-1">
            {(["all", "draft", "posted"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={cn(
                  "px-2 py-1 rounded text-[11px] font-medium border transition-colors",
                  statusFilter === s
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100",
                )}
              >
                {s === "all" ? "الكل" : s === "draft" ? "مسودة" : "مرحّلة"}
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
            {filtered.length} سند
            {filtered.length !== settlements.length && <span className="text-slate-400"> / {settlements.length}</span>}
          </span>
        </div>
        {/* ── Bulk-action bar (visible only when one or more rows selected) ── */}
        <AuditGridBulkBar
          count={layout.selected.size}
          onClear={layout.clearSelection}
          busy={bulkBusy}
        >
          <Button
            type="button" size="sm"
            className="h-7 px-3 text-xs gap-1 bg-emerald-700 hover:bg-emerald-600 text-white"
            onClick={bulkPost}
            disabled={bulkBusy || selectedDrafts.length === 0}
            title={selectedDrafts.length === 0 ? "لا توجد مسوّدات ضمن المحدَّد" : `ترحيل ${selectedDrafts.length} تحصيل`}
          >
            {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            ترحيل ({selectedDrafts.length})
          </Button>
          <Button
            type="button" size="sm"
            className="h-7 px-3 text-xs gap-1 bg-rose-600 hover:bg-rose-500 text-white"
            onClick={bulkDelete}
            disabled={bulkBusy || selectedDeletable.length === 0}
            title={selectedDeletable.length === 0
              ? "لا يمكن حذف التحصيلات المرحَّلة. التراجع غير مدعوم لهذه الشاشة."
              : `حذف ${selectedDeletable.length} تحصيل (مسوّدة فقط)`}
          >
            <Trash2 className="h-3.5 w-3.5" />
            حذف ({selectedDeletable.length})
          </Button>
        </AuditGridBulkBar>
      </div>

      {/* ── Audit-grid table ─────────────────────────────────────────────── */}
      <div className="border border-slate-300 rounded-b-lg bg-white overflow-hidden shadow-sm -mt-3">
        <div className="overflow-x-auto" style={{ maxHeight: "calc(100vh - 360px)" }}>
          {isLoading ? (
            <div className="p-12 text-center text-muted-foreground text-sm">جاري التحميل…</div>
          ) : filtered.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground text-sm">لا توجد تحصيلات ضمن التصفية الحالية</div>
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
                    if (col.key === "_sel") {
                      const visibleIds = paged.map((s: any) => Number(s.id));
                      return (
                        <th
                          key={col.key}
                          data-col-key={col.key}
                          style={colWidths[col.key] ? { width: `${colWidths[col.key]}px`, minWidth: `${colWidths[col.key]}px` } : undefined}
                          className="relative px-2 py-1.5 border border-slate-300 text-center font-semibold whitespace-nowrap text-[10.5px] w-9"
                        >
                          <HeaderSelectCheckbox
                            allSelected={layout.isAllSelected(visibleIds)}
                            someSelected={layout.isSomeSelected(visibleIds)}
                            onToggle={() => layout.toggleAll(visibleIds)}
                            disabled={visibleIds.length === 0 || bulkBusy}
                          />
                        </th>
                      );
                    }
                    return (
                      <th
                        key={col.key}
                        data-col-key={col.key}
                        style={colWidths[col.key] ? { width: `${colWidths[col.key]}px`, minWidth: `${colWidths[col.key]}px` } : undefined}
                        className="relative px-2 py-1.5 border border-slate-300 text-center font-semibold whitespace-nowrap text-[10.5px]"
                      >
                        {col.label}
                        <span
                          {...gripProps(col.key, idx)}
                          className="print:hidden absolute top-0 bottom-0 w-2 cursor-col-resize select-none touch-none hover:bg-blue-400/60 active:bg-blue-500/80 z-20"
                          style={{ insetInlineEnd: -4 }}
                        />
                      </th>
                    );
                  })}
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
                {paged.map((s: any, idx: number) => {
                  const absIdx = pageSize === 0 ? idx : (safePage - 1) * pageSize + idx;
                  const rid = Number(s.id);
                  const isSel = layout.isSelected(rid);
                  const renderCell = (col: ColDef) => {
                    switch (col.key) {
                      case "_sel":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            <RowSelectCheckbox
                              checked={isSel}
                              onToggle={() => layout.toggleRow(rid)}
                              ariaLabel={`تحديد التحصيل ${s.docNumber ?? `CR-${rid}`}`}
                            />
                          </td>
                        );
                      case "_idx":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center text-slate-500 font-mono">{absIdx + 1}</td>;
                      case "doc":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 font-mono font-semibold text-primary text-center">{s.docNumber ?? `CR-${s.id}`}</td>;
                      case "date":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center whitespace-nowrap">{s.settlementDate}</td>;
                      case "customer":
                        return <td key={col.key} className={cn("px-2 py-1 border border-slate-200 truncate", colWidths.customer ? "" : "max-w-[200px]")} title={cusMap[s.customerId] ?? ""}>{cusMap[s.customerId] ?? "—"}</td>;
                      case "payment":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center text-slate-600">{PAYMENT_LABEL[s.paymentMethod] ?? s.paymentMethod}</td>;
                      case "account":
                        return <td key={col.key} className={cn("px-2 py-1 border border-slate-200 truncate text-slate-600", colWidths.account ? "" : "max-w-[200px]")} title={accMap[s.accountId] ?? ""}>{accMap[s.accountId] ?? "—"}</td>;
                      case "amount":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-end font-mono font-bold text-slate-900">{fmt(s.amount)}</td>;
                      case "currency":
                        return <td key={col.key} className="px-2 py-1 border border-slate-200 text-center text-slate-500 font-mono">{s.currencyCode}</td>;
                      case "notes":
                        return <td key={col.key} className={cn("px-2 py-1 border border-slate-200 text-slate-600 truncate", colWidths.notes ? "" : "max-w-[160px]")} title={s.notes ?? ""}>{s.notes ?? "—"}</td>;
                      case "status":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            <span className={cn("inline-flex items-center text-[10px] rounded px-1.5 py-0.5 font-medium border",
                              s.status === "posted"
                                ? "bg-emerald-100 text-emerald-800 border-emerald-300"
                                : "bg-amber-100 text-amber-800 border-amber-300",
                            )}>
                              {s.status === "posted" ? "مرحّلة" : "مسودة"}
                            </span>
                          </td>
                        );
                      case "_act":
                        return (
                          <td key={col.key} className="px-2 py-1 border border-slate-200 text-center">
                            <div className="flex items-center justify-center gap-0.5">
                              <Button variant="ghost" size="icon" className="h-6 w-6 text-primary" title="طباعة سند القبض"
                                onClick={(e) => { e.stopPropagation(); printOne(s); }}>
                                <Printer className="h-3.5 w-3.5" />
                              </Button>
                              {s.status === "draft" && (
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-emerald-700 hover:bg-emerald-50" title="ترحيل"
                                  onClick={(e) => { e.stopPropagation(); if (confirm("ترحيل التحصيل؟")) postMut.mutate(s.id); }}>
                                  <CheckCircle className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              {s.status === "draft" && (
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                                  onClick={(e) => { e.stopPropagation(); if (confirm("حذف التحصيل؟")) deleteMut.mutate(s.id); }}>
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
                    <tr
                      key={s.id}
                      className={cn(
                        "transition-colors cursor-pointer",
                        isSel ? "bg-emerald-100/70 hover:bg-emerald-100" : "hover:bg-amber-50/60",
                      )}
                      onClick={(e) => {
                        const tag = (e.target as HTMLElement).tagName;
                        if (tag === "BUTTON" || tag === "INPUT" || tag === "A" || (e.target as HTMLElement).closest("button,a,input")) return;
                        layout.toggleRow(rid);
                      }}
                      title="اضغط لتحديد الصف"
                    >
                      {visibleColumns.map(renderCell)}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="sticky bottom-0">
                <tr className={cn("text-[11px] font-semibold", footerTheme.bg, footerTheme.text)}>
                  {visibleColumns.map((col, i) => {
                    // _sel sits at index 0 now; the "الإجمالي:" label belongs in the next cell.
                    if (col.key === "_sel") {
                      return <td key={col.key} className={cn("px-2 py-2 border", footerTheme.border)} />;
                    }
                    if (i === 1) {
                      return <td key={col.key} className={cn("px-2 py-2 border text-end whitespace-nowrap", footerTheme.border)}>الإجمالي:</td>;
                    }
                    if (col.key === "amount") {
                      return <td key={col.key} className={cn("px-2 py-2 border text-end font-mono", footerTheme.border)}>{fmt(totals.amount)}</td>;
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
          totalRows={filtered.length}
          pageStart={pageStart}
          pageEnd={pageEnd}
          totalPages={totalPages}
          unitLabel="سند"
        />
      </div>
    </div>
  );
}
