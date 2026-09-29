import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Info, Lock, Plus, RefreshCw, RotateCcw, Save, Trash2, Receipt, Layers, FileWarning } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  documentExpensesApi, setDocumentExpensesDirty, DocumentExpensesError,
  type DocumentExpenseType, type DocumentExpenseRow, type DocumentExpensesResponse, type AllocationMethod,
} from "@/lib/documentExpensesApi";

interface Props {
  documentType: DocumentExpenseType;
  documentId: number | null | undefined;
  isRtl?: boolean;
  /** Force read-only (e.g. details / view mode). */
  readOnly?: boolean;
  /** Purchase invoice is linked to a documentary credit (LC). */
  hasLc?: boolean;
}

const EMPTY_ROW: DocumentExpenseRow = {
  description: "", amount: 0, treatment: "period", allocationMethod: "value", allocations: [], costCenterId: null, reference: "",
};

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const sig = (rows: DocumentExpenseRow[]) => JSON.stringify(rows);

export function DocumentExpensesTab({ documentType, documentId, isRtl = true, readOnly = false, hasLc = false }: Props) {
  const { toast } = useToast();
  const L = (ar: string, en: string) => (isRtl ? ar : en);
  const fmt = (n: number) => (Number(n) || 0).toLocaleString(isRtl ? "ar-SA" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const [data, setData] = useState<DocumentExpensesResponse | null>(null);
  const [rows, setRows] = useState<DocumentExpenseRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ msg: string; conflict: boolean } | null>(null);
  const savedSig = useRef("[]");

  const load = useCallback(async () => {
    if (!documentId) return;
    setLoading(true); setLoadError(null); setSaveError(null);
    try {
      const res = await documentExpensesApi.get(documentType, documentId);
      setData(res); setRows(res.rows ?? []); savedSig.current = sig(res.rows ?? []);
    } catch (e: any) {
      setLoadError(e?.message || "Error");
    } finally { setLoading(false); }
  }, [documentType, documentId]);

  useEffect(() => { load(); }, [load]);

  const dirty = !!data && sig(rows) !== savedSig.current;
  const editable = !!data?.editable && !readOnly;

  useEffect(() => {
    if (!documentId || readOnly) return;
    setDocumentExpensesDirty(documentType, documentId, dirty);
    return () => setDocumentExpensesDirty(documentType, documentId, false);
  }, [dirty, documentType, documentId, readOnly]);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const lines = data?.options.lines ?? [];
  const canCapitalize = !!data?.options.canCapitalize && documentType === "purchase_invoice";
  const isReturn = documentType === "sales_return" || documentType === "purchase_return";
  const total = useMemo(() => rows.reduce((s, r) => s + (Number(r.amount) || 0), 0), [rows]);
  const capTotal = useMemo(() => rows.filter(r => r.treatment === "capitalized").reduce((s, r) => s + (Number(r.amount) || 0), 0), [rows]);

  const patch = (i: number, p: Partial<DocumentExpenseRow>) => setRows(prev => prev.map((r, idx) => idx === i ? { ...r, ...p } : r));
  const setManual = (i: number, lineId: number, amount: number) => setRows(prev => prev.map((r, idx) => {
    if (idx !== i) return r;
    const others = r.allocations.filter(a => a.lineId !== lineId);
    return { ...r, allocations: amount ? [...others, { lineId, amount }] : others };
  }));

  const validate = (): string | null => {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const n = i + 1;
      if (!r.description.trim()) return L(`البند ${n}: الوصف مطلوب`, `Row ${n}: description is required`);
      if (!(r2(r.amount) > 0)) return L(`البند ${n}: المبلغ يجب أن يكون أكبر من صفر`, `Row ${n}: amount must be positive`);
      if (r.treatment === "capitalized" && !canCapitalize) return L(`البند ${n}: الرسملة غير متاحة لهذا المستند`, `Row ${n}: capitalization not available for this document`);
      if (r.allocationMethod === "manual" && lines.length > 0) {
        const sum = r2(r.allocations.reduce((s, a) => s + (Number(a.amount) || 0), 0));
        if (sum !== r2(r.amount)) return L(`البند ${n}: مجموع التوزيع اليدوي (${fmt(sum)}) لا يساوي المبلغ (${fmt(r.amount)})`, `Row ${n}: manual allocation (${fmt(sum)}) must equal amount (${fmt(r.amount)})`);
      }
    }
    return null;
  };

  const save = async () => {
    if (!documentId || !data) return;
    const err = validate();
    if (err) { setSaveError({ msg: err, conflict: false }); return; }
    setSaving(true); setSaveError(null);
    try {
      const payload = rows.map(r => ({
        ...r, description: r.description.trim(), amount: r2(r.amount), reference: r.reference.trim(),
        allocations: r.allocationMethod === "manual" ? r.allocations.map(a => ({ lineId: a.lineId, amount: r2(a.amount) })) : [],
      }));
      const res = await documentExpensesApi.put(documentType, documentId, data.version, payload);
      setData(res); setRows(res.rows ?? []); savedSig.current = sig(res.rows ?? []);
      toast({ title: L("تم حفظ المصروفات والتكاليف", "Expenses & costs saved") });
    } catch (e: any) {
      const conflict = e instanceof DocumentExpensesError && e.status === 409;
      setSaveError({ msg: conflict ? L("تم تعديل المصروفات من مكان آخر. أعد التحميل ثم أعد تطبيق تعديلاتك.", "Expenses were changed elsewhere. Reload, then re-apply your edits.") : (e?.message || "Error"), conflict });
    } finally { setSaving(false); }
  };

  // ── Unsaved document ────────────────────────────────────────────────
  if (!documentId) {
    return (
      <Shell isRtl={isRtl}>
        <div className="flex flex-col items-center text-center gap-3 py-12 px-6">
          <div className="h-12 w-12 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center"><Save className="h-5 w-5" /></div>
          <h3 className="font-semibold text-base">{L("احفظ المستند أولاً", "Save the document first")}</h3>
          <p className="text-sm text-muted-foreground max-w-md leading-relaxed">
            {L("المصروفات والتكاليف الداخلية تُربط بمسودة محفوظة. احفظ المستند كمسودة ثم عُد إلى هذا التبويب لإضافة المصروفات قبل الترحيل.",
               "Internal expenses attach to a saved draft. Save the document as a draft, then return to this tab to add expenses before posting.")}
          </p>
        </div>
      </Shell>
    );
  }

  if (loading && !data) {
    return (
      <Shell isRtl={isRtl}>
        <div className="p-4 space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </Shell>
    );
  }

  if (loadError) {
    return (
      <Shell isRtl={isRtl}>
        <div className="flex flex-col items-center text-center gap-3 py-10">
          <FileWarning className="h-8 w-8 text-destructive" />
          <p className="text-sm font-medium">{L("تعذّر تحميل المصروفات", "Could not load expenses")}</p>
          <p className="text-xs text-muted-foreground max-w-md">{loadError}</p>
          <Button type="button" size="sm" variant="outline" onClick={load} className="gap-1.5"><RefreshCw className="h-3.5 w-3.5" />{L("إعادة المحاولة", "Retry")}</Button>
        </div>
      </Shell>
    );
  }

  if (!data) return null;
  const previewFor = (i: number) => (!dirty ? data.allocationPreviews?.find(p => p.rowIndex === i)?.allocations : undefined);

  return (
    <Shell isRtl={isRtl}>
      {/* Header strip */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b bg-gradient-to-l from-primary/[0.06] to-transparent">
        <div className="flex items-center gap-2">
          <Receipt className="h-4 w-4 text-primary" />
          <span className="font-semibold text-sm">{L("المصروفات والتكاليف", "Expenses & Costs")}</span>
        </div>
        {!editable ? (
          <Badge variant="outline" className="gap-1 text-[11px]"><Lock className="h-3 w-3" />{L("للعرض فقط", "Read-only")}{data.status === "posted" ? L(" - مرحّل", " - posted") : ""}</Badge>
        ) : dirty ? (
          <Badge className="bg-amber-100 text-amber-800 border border-amber-300 hover:bg-amber-100 text-[11px]">{L("تعديلات غير محفوظة", "Unsaved changes")}</Badge>
        ) : (
          <Badge variant="outline" className="text-[11px] text-emerald-700 border-emerald-300">{L("محفوظ", "Saved")}</Badge>
        )}
        <div className={cn("flex items-baseline gap-4 text-xs", isRtl ? "mr-auto" : "ml-auto")}>
          <span className="text-muted-foreground">{L("الإجمالي", "Total")} <strong className="font-mono text-foreground text-sm">{fmt(total)}</strong></span>
          {canCapitalize && <span className="text-muted-foreground">{L("مرسمل", "Capitalized")} <strong className="font-mono text-foreground">{fmt(capTotal)}</strong></span>}
        </div>
      </div>

      {/* Policy notes */}
      <div className="grid gap-2 px-4 pt-3 text-xs md:grid-cols-2">
        <Note tone="info">
          {L("المبالغ صافية بدون ضريبة القيمة المضافة القابلة للاسترداد. ضريبة المدخلات تُسجَّل فقط عبر فاتورة مورد مستقلة داعمة، ولا يغيّر هذا التبويب الضريبة أو إجماليات المستند أو رصيد العميل/المورد أو زاتكا.",
             "Amounts exclude recoverable VAT. Input VAT must be recorded via a separate supporting supplier invoice; this tab never changes tax, document totals, customer/supplier balance or ZATCA.")}
        </Note>
        {isReturn ? (
          <Note tone="warn">
            {L("مصروفات المرتجع تكاليف فترة إضافية، وليست استرداداً تلقائياً لمصروفات المستند الأصلي.",
               "Return expenses are additional period costs, not an automatic refund of the original document's expenses.")}
          </Note>
        ) : documentType === "purchase_invoice" ? (
          <Note tone={hasLc ? "warn" : "info"}>
            {hasLc
              ? L("هذه الفاتورة مرتبطة باعتماد مستندي: تكاليف الاعتماد تُحمَّل من شاشة الاعتماد فقط. الرسملة هنا ممنوعة لتجنب تكرار التكلفة، ويُسمح بمصروفات الفترة فقط. لا تُدخل هنا أي تكلفة سبق تسجيلها على الاعتماد.",
                  "Linked to a documentary credit: LC costs are attributed from the LC screen only. Capitalization is blocked here to avoid duplicate landed cost; only period expenses are allowed. Do not enter any cost already recorded on the LC.")
              : L("لا تكرر تكاليف الاعتماد المستندي هنا. الرسملة تضيف التكلفة إلى المخزون حسب طريقة التوزيع.",
                  "Do not duplicate documentary-credit costs here. Capitalization adds the cost to inventory by the allocation method.")}
          </Note>
        ) : (
          <Note tone="info">{L("تُسجَّل كمصروف فترة داخلي ولا تظهر في فاتورة العميل.", "Recorded as an internal period cost; never shown on the customer invoice.")}</Note>
        )}
      </div>

      {/* Rows */}
      <div className="p-4 space-y-3">
        {rows.length === 0 && (
          <div className="rounded-lg border border-dashed py-10 flex flex-col items-center gap-2 text-center">
            <Layers className="h-7 w-7 text-muted-foreground/60" />
            <p className="text-sm font-medium">{L("لا توجد مصروفات على هذا المستند", "No expenses on this document")}</p>
            <p className="text-xs text-muted-foreground">{editable ? L("أضف مصروفاً مثل الشحن أو التخليص أو العمولة.", "Add a cost such as freight, clearance or commission.") : L("لم تُسجَّل مصروفات داخلية.", "No internal expenses were recorded.")}</p>
          </div>
        )}

        {rows.map((r, i) => {
          const preview = previewFor(i);
          const manualSum = r2(r.allocations.reduce((s, a) => s + (Number(a.amount) || 0), 0));
          return (
            <div key={i} className="rounded-lg border bg-card shadow-[0_1px_0_hsl(var(--border))] overflow-hidden">
              <div className={cn("flex items-center gap-2 px-3 py-1.5 text-[11px] bg-muted/40 border-b", r.treatment === "capitalized" && "bg-primary/[0.07]")}>
                <span className="font-mono text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
                <span className="font-medium">{r.treatment === "capitalized" ? L("مرسمل على المخزون", "Capitalized to inventory") : L("مصروف فترة", "Period expense")}</span>
                {editable && (
                  <Button type="button" size="icon" variant="ghost" className={cn("h-6 w-6 text-destructive", isRtl ? "mr-auto" : "ml-auto")} onClick={() => setRows(prev => prev.filter((_, idx) => idx !== i))} aria-label={L("حذف", "Delete")}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
              <div className="grid gap-3 p-3 md:grid-cols-12">
                <Field label={L("الوصف", "Description")} className="md:col-span-5">
                  <Input value={r.description} disabled={!editable} maxLength={300} onChange={e => patch(i, { description: e.target.value })} className="h-8 text-sm" />
                </Field>
                <Field label={L("المبلغ (بدون ضريبة)", "Amount (net of VAT)")} className="md:col-span-2">
                  <Input type="number" min={0} step="0.01" value={r.amount || ""} disabled={!editable} onChange={e => patch(i, { amount: Number(e.target.value) })} className="h-8 text-sm font-mono" dir="ltr" />
                </Field>
                <Field label={L("المعالجة", "Treatment")} className="md:col-span-2">
                  <Select value={r.treatment} disabled={!editable} onValueChange={v => patch(i, { treatment: v as any })}>
                    <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="period">{L("مصروف فترة", "Period")}</SelectItem>
                      {(canCapitalize || r.treatment === "capitalized") && <SelectItem value="capitalized" disabled={!canCapitalize}>{L("رسملة", "Capitalized")}</SelectItem>}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={L("طريقة التوزيع", "Allocation")} className="md:col-span-3">
                  <Select value={r.allocationMethod} disabled={!editable} onValueChange={v => patch(i, { allocationMethod: v as AllocationMethod })}>
                    <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="value">{L("حسب القيمة", "By value")}</SelectItem>
                      <SelectItem value="quantity">{L("حسب الكمية", "By quantity")}</SelectItem>
                      <SelectItem value="manual">{L("يدوي", "Manual")}</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={L("مركز التكلفة (اختياري)", "Cost center (optional)")} className="md:col-span-5">
                  <Select value={r.costCenterId ? String(r.costCenterId) : "none"} disabled={!editable} onValueChange={v => patch(i, { costCenterId: v === "none" ? null : Number(v) })}>
                    <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{L("بدون", "None")}</SelectItem>
                      {data.options.costCenters.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.code} - {c.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={L("المرجع (اختياري)", "Reference (optional)")} className="md:col-span-7">
                  <Input value={r.reference} disabled={!editable} maxLength={120} onChange={e => patch(i, { reference: e.target.value })} className="h-8 text-sm" />
                </Field>
              </div>

              {lines.length > 0 && (r.allocationMethod === "manual" || preview) && (
                <div className="border-t bg-muted/20 px-3 py-2">
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-1.5">
                    <span>{r.allocationMethod === "manual" ? L("التوزيع اليدوي على البنود", "Manual allocation per line") : L("معاينة التوزيع على البنود", "Per-line allocation preview")}</span>
                    {r.allocationMethod === "manual" && (
                      <span className={cn("font-mono", manualSum === r2(r.amount) ? "text-emerald-700" : "text-amber-700")}>{fmt(manualSum)} / {fmt(r.amount)}</span>
                    )}
                  </div>
                  <div className="divide-y rounded border bg-background text-xs">
                    {lines.map(l => {
                      const manual = r.allocations.find(a => a.lineId === l.lineId)?.amount ?? 0;
                      const prev = preview?.find(a => a.lineId === l.lineId)?.amount;
                      return (
                        <div key={l.lineId} className="flex items-center gap-3 px-2 py-1">
                          <span className="flex-1 truncate">{l.description}</span>
                          <span className="text-muted-foreground font-mono w-16 text-end" title={L("الكمية", "Qty")}>{l.quantity}</span>
                          <span className="text-muted-foreground font-mono w-24 text-end" title={L("القيمة", "Value")}>{fmt(l.value)}</span>
                          {r.allocationMethod === "manual" && editable ? (
                            <Input type="number" step="0.01" min={0} dir="ltr" value={manual || ""} onChange={e => setManual(i, l.lineId, Number(e.target.value))} className="h-7 w-28 text-xs font-mono" />
                          ) : (
                            <span className="font-mono w-28 text-end font-medium">{fmt(r.allocationMethod === "manual" ? manual : (prev ?? 0))}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {dirty && r.allocationMethod !== "manual" && lines.length > 0 && editable && (
                <p className="px-3 pb-2 text-[11px] text-muted-foreground">{L("احفظ لتحديث معاينة التوزيع.", "Save to refresh the allocation preview.")}</p>
              )}
            </div>
          );
        })}

        {lines.length === 0 && rows.length > 0 && (
          <p className="text-[11px] text-muted-foreground">{L("لا توجد بنود محفوظة للتوزيع عليها بعد. احفظ المستند مع أصنافه لعرض معاينة التوزيع.", "No saved lines to allocate to yet. Save the document with its items to see allocation previews.")}</p>
        )}

        {saveError && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span className="flex-1">{saveError.msg}</span>
            {saveError.conflict && <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={load}>{L("إعادة التحميل", "Reload")}</Button>}
          </div>
        )}

        {editable && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => setRows(prev => [...prev, { ...EMPTY_ROW }])}>
              <Plus className="h-3.5 w-3.5" />{L("إضافة مصروف", "Add expense")}
            </Button>
            <div className={cn("flex items-center gap-2", isRtl ? "mr-auto" : "ml-auto")}>
              {dirty && (
                <Button type="button" size="sm" variant="ghost" className="gap-1.5" disabled={saving} onClick={() => { setRows(JSON.parse(savedSig.current)); setSaveError(null); }}>
                  <RotateCcw className="h-3.5 w-3.5" />{L("تجاهل التعديلات", "Discard")}
                </Button>
              )}
              <Button type="button" size="sm" className="gap-1.5" disabled={!dirty || saving} onClick={save}>
                <Save className="h-3.5 w-3.5" />{saving ? L("جارٍ الحفظ...", "Saving...") : L("حفظ المصروفات", "Save expenses")}
              </Button>
            </div>
          </div>
        )}
        {editable && (
          <p className="text-[11px] text-muted-foreground">
            {L("تُحفظ المصروفات بشكل مستقل عن حفظ المستند. لن يُسمح بالترحيل أثناء وجود تعديلات غير محفوظة هنا.", "Expenses save separately from the document. Posting is blocked while unsaved changes exist here.")}
          </p>
        )}
      </div>
    </Shell>
  );
}

function Shell({ children, isRtl }: { children: ReactNode; isRtl: boolean }) {
  return <div dir={isRtl ? "rtl" : "ltr"} className="rounded-xl border bg-background/60 overflow-hidden">{children}</div>;
}
function Field({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return <label className={cn("flex flex-col gap-1", className)}><span className="text-[11px] text-muted-foreground">{label}</span>{children}</label>;
}
function Note({ tone, children }: { tone: "info" | "warn"; children: ReactNode }) {
  return (
    <div className={cn("flex gap-2 rounded-md border p-2.5 leading-relaxed",
      tone === "warn" ? "bg-amber-50 border-amber-200 text-amber-900" : "bg-sky-50/70 border-sky-200 text-sky-900")}>
      {tone === "warn" ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" /> : <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />}
      <span>{children}</span>
    </div>
  );
}

export default DocumentExpensesTab;
