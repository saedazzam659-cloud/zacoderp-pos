// إشعار دائن/مدين مضمَّن داخل تبويب في نموذج الفاتورة (على نمط أودو):
// - فاتورة المشتريات → تبويب "إشعار دائن" (partyType=supplier, noteType=credit)
// - فاتورة المبيعات   → تبويب "إشعار مدين"  (partyType=customer, noteType=debit)
// يعرض الإشعارات المرتبطة بهذه الفاتورة (عبر referenceNumber) + نموذج إنشاء
// مبسّط مسبق التعبئة من بيانات الفاتورة. الشاشات المستقلة الموجودة تبقى كما هي.
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Plus, Printer, Save, Trash2, CheckCircle2, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { AccountCombobox } from "@/components/AccountCombobox";
import { SearchCombobox, type ComboboxItem } from "@/components/ui/search-combobox";
import { DateField } from "@/components/ui/date-field";
import { useToast } from "@/hooks/use-toast";
import { useCostCenters } from "@/hooks/useCostCenters";
import { useAuth } from "@/contexts/AuthContext";
import { fmt2 } from "@/lib/format";
import { printAccountNote } from "@/lib/accountNotePrint";
import {
  accountNotesApi,
  type AccountNote,
  type AccountNotePartyType,
  type AccountNoteType,
} from "@/lib/accountNotesApi";

interface Props {
  partyType: AccountNotePartyType;      // supplier (مشتريات) | customer (مبيعات)
  noteType: AccountNoteType;            // credit (دائن) | debit (مدين)
  partyId: number | null;               // مورد/عميل الفاتورة الحالية
  partyName?: string | null;
  partyVatNumber?: string | null;
  /** حساب ذمم الطرف إن كان معروفاً من صف المورد/العميل. */
  partyAccountId?: number | null;
  invoiceDocNumber: string | null;      // رقم الفاتورة المحفوظ — مرجع الربط
  invoiceDate?: string | null;
  disabled?: boolean;                   // فاتورة مرحّلة → عرض فقط
}

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  draft:     { label: "مسودة",  cls: "bg-amber-100 text-amber-800 border-amber-300" },
  posted:    { label: "مرحّل",  cls: "bg-emerald-100 text-emerald-800 border-emerald-300" },
  cancelled: { label: "ملغى",   cls: "bg-rose-100 text-rose-800 border-rose-300" },
};

export default function EmbeddedAccountNotesTab({
  partyType, noteType, partyId, partyName, partyVatNumber, partyAccountId,
  invoiceDocNumber, invoiceDate, disabled,
}: Props) {
  const { toast } = useToast();
  const { user } = useAuth() as any;
  const qc = useQueryClient();
  const title = noteType === "credit" ? "إشعار دائن" : "إشعار مدين";
  const partyLabel = partyType === "customer" ? "العميل" : "المورد";
  const listKey = ["embedded-account-notes", partyType, noteType, invoiceDocNumber];

  // ── الإشعارات المرتبطة بهذه الفاتورة ────────────────────────────────
  const { data: allNotes = [], isLoading } = useQuery<AccountNote[]>({
    queryKey: listKey,
    enabled: !!invoiceDocNumber,
    queryFn: () => accountNotesApi.list({ partyType, noteType }),
  });
  const linkedNotes = useMemo(
    () => (allNotes as AccountNote[]).filter(
      (n) => n.referenceNumber === invoiceDocNumber &&
             (partyId == null || Number(n.partyId) === Number(partyId))),
    [allNotes, invoiceDocNumber, partyId],
  );
  const postedTotal = useMemo(
    () => linkedNotes.filter(n => n.status === "posted")
      .reduce((s, n) => s + (parseFloat(String(n.totalAmount)) || 0), 0),
    [linkedNotes],
  );

  // ── نموذج الإنشاء المضمَّن ───────────────────────────────────────────
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<any>(null);
  const autoFilledRef = useRef(false);

  const contraTypeFilter = useMemo<string[]>(() => {
    if (partyType === "customer" && noteType === "credit") return ["expense", "revenue"];
    if (partyType === "customer" && noteType === "debit")  return ["revenue"];
    if (partyType === "supplier" && noteType === "credit") return ["revenue", "expense"];
    return ["expense"];
  }, [partyType, noteType]);
  const partyAccountFilter = useMemo<string[]>(
    () => (partyType === "customer" ? ["asset"] : ["liability"]), [partyType]);

  const { data: defaults } = useQuery({
    queryKey: ["account-note-defaults", partyType, noteType],
    enabled: showForm,
    staleTime: 60_000,
    queryFn: () => accountNotesApi.defaults(partyType, noteType),
  });
  const { data: costCenters = [] } = useCostCenters();
  const costCenterItems: ComboboxItem[] = useMemo(
    () => [
      { value: "", label: "— بدون —" },
      ...(costCenters as any[]).map((c: any) => ({
        value: c.code, label: `${c.code} — ${c.nameAr}`, code: c.code,
      })),
    ],
    [costCenters],
  );

  function openForm() {
    autoFilledRef.current = false;
    setForm({
      noteDate: new Date().toISOString().slice(0, 10),
      partyAccountId: partyAccountId ? String(partyAccountId) : "",
      contraAccountId: "",
      amount: "",
      vatEnabled: false,
      vatRate: "15",
      vatAccountId: "",
      description: `${title} على فاتورة ${invoiceDocNumber ?? ""}`.trim(),
      notes: "",
      costCenter: "",
    });
    setShowForm(true);
  }

  // تعبئة الحسابات الافتراضية مرة واحدة (بدون الكتابة فوق إدخال يدوي).
  useEffect(() => {
    if (!showForm || !form || !defaults || autoFilledRef.current) return;
    autoFilledRef.current = true;
    setForm((f: any) => {
      const next = { ...f };
      if (!f.contraAccountId && defaults.contraAccountId &&
          defaults.contraAccountType && contraTypeFilter.includes(defaults.contraAccountType)) {
        next.contraAccountId = String(defaults.contraAccountId);
      }
      if (defaults.vatAccountId && !f.vatAccountId) {
        next.vatAccountId = String(defaults.vatAccountId);
        if (!f.vatEnabled) next.vatEnabled = true;
      }
      return next;
    });
  }, [showForm, form, defaults, contraTypeFilter]);

  const amount    = Number(form?.amount || 0);
  const vatAmount = form?.vatEnabled ? +(amount * Number(form?.vatRate || 0) / 100).toFixed(2) : 0;
  const total     = +(amount + vatAmount).toFixed(2);

  const saveMut = useMutation({
    mutationFn: async (postAfter: boolean) => {
      const body: any = {
        partyType, noteType,
        noteDate: form.noteDate,
        partyId: Number(partyId),
        partyAccountId: Number(form.partyAccountId),
        contraAccountId: Number(form.contraAccountId),
        amount: form.amount,
        vatEnabled: !!form.vatEnabled,
        vatRate: form.vatRate,
        vatAccountId: form.vatEnabled ? Number(form.vatAccountId) : null,
        description: form.description || null,
        notes: form.notes || null,
        operationNumber: null,
        referenceNumber: invoiceDocNumber,
        referenceDate: invoiceDate ? String(invoiceDate).slice(0, 10) : null,
        costCenter: form.costCenter || null,
        projectId: null,
      };
      const created = await accountNotesApi.create(body);
      if (postAfter && created?.id) await accountNotesApi.post(created.id);
      return created;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: listKey });
      qc.invalidateQueries({ queryKey: ["account-notes", partyType, noteType] });
      toast({ title: "تم حفظ الإشعار" });
      setShowForm(false);
      setForm(null);
    },
    onError: (e: any) => toast({ title: "خطأ", description: String(e?.message || e), variant: "destructive" }),
  });

  const actMut = useMutation({
    mutationFn: async (a: { id: number; op: "post" | "unpost" | "delete" }) => {
      if (a.op === "post")   return accountNotesApi.post(a.id);
      if (a.op === "unpost") return accountNotesApi.unpost(a.id);
      return accountNotesApi.delete(a.id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: listKey });
      qc.invalidateQueries({ queryKey: ["account-notes", partyType, noteType] });
      toast({ title: "تم" });
    },
    onError: (e: any) => toast({ title: "خطأ", description: String(e?.message || e), variant: "destructive" }),
  });

  function submit(postAfter: boolean) {
    if (!partyId)             { toast({ title: `لا يوجد ${partyLabel} محدد على الفاتورة`, variant: "destructive" }); return; }
    if (!form.partyAccountId) { toast({ title: `حدّد حساب ذمم ${partyLabel}`, variant: "destructive" }); return; }
    if (!form.contraAccountId){ toast({ title: "حدّد الحساب المقابل", variant: "destructive" }); return; }
    if (!(Number(form.amount) > 0)) { toast({ title: "أدخل مبلغاً صحيحاً", variant: "destructive" }); return; }
    if (form.vatEnabled && !form.vatAccountId) { toast({ title: "حدّد حساب ضريبة القيمة المضافة", variant: "destructive" }); return; }
    saveMut.mutate(postAfter);
  }

  async function printRow(n: AccountNote) {
    try {
      const full = await accountNotesApi.get(n.id);
      printAccountNote({
        note: full,
        party: partyName ? { nameAr: partyName, vatNumber: partyVatNumber ?? undefined } as any : null,
        company: user?.company ?? {},
        partyLabel,
        preparedBy: (full as any).createdByName ?? user?.username ?? null,
        onError: (msg) => toast({ title: msg, variant: "destructive" }),
      });
    } catch (e: any) {
      toast({ title: "تعذّرت الطباعة", description: String(e?.message || e), variant: "destructive" });
    }
  }

  // لم تُحفَظ الفاتورة بعد — لا يوجد رقم مرجع نربط عليه.
  if (!invoiceDocNumber) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        احفظ الفاتورة أولاً ليتوفر رقمها المرجعي، ثم يمكنك إضافة {title} مرتبط بها من هنا.
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4" data-testid={`embedded-${partyType}-${noteType}-notes`}>
      {/* رأس التبويب: عنوان + إجمالي المرحّل + زر إضافة */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-primary" />
          <span className="font-bold text-sm">{title} — فاتورة {invoiceDocNumber}</span>
          {postedTotal > 0 && (
            <Badge variant="outline" className="text-[10px] border-emerald-300 text-emerald-700">
              إجمالي المرحّل: {fmt2(postedTotal)}
            </Badge>
          )}
        </div>
        {!showForm && !disabled && (
          <Button type="button" size="sm" onClick={openForm} data-testid="btn-add-embedded-note">
            <Plus className="h-4 w-4 ms-1" /> إضافة {title}
          </Button>
        )}
      </div>

      {/* نموذج الإنشاء المضمَّن */}
      {showForm && form && (
        <div className="rounded-xl border-2 border-primary/30 bg-primary/[0.03] p-4 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-bold">{title} جديد — {partyLabel}: {partyName ?? "—"}</span>
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7"
              onClick={() => { setShowForm(false); setForm(null); }} data-testid="btn-close-embedded-note">
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-x-4 gap-y-3">
            <label className="flex flex-col gap-1"><span className="text-xs font-medium">التاريخ *</span>
              <DateField value={form.noteDate}
                onChange={(e) => setForm({ ...form, noteDate: e.target.value })} data-testid="embedded-note-date" />
            </label>
            <label className="flex flex-col gap-1"><span className="text-xs font-medium">حساب ذمم {partyLabel} *</span>
              <AccountCombobox
                value={form.partyAccountId ? String(form.partyAccountId) : undefined}
                onValueChange={(v) => setForm({ ...form, partyAccountId: v })}
                filterTypes={partyAccountFilter as any}
                placeholder="ابحث عن الحساب…"
                data-testid="embedded-note-party-account"
              />
            </label>
            <label className="flex flex-col gap-1"><span className="text-xs font-medium">الحساب المقابل *</span>
              <AccountCombobox
                value={form.contraAccountId ? String(form.contraAccountId) : undefined}
                onValueChange={(v) => setForm({ ...form, contraAccountId: v })}
                filterTypes={contraTypeFilter as any}
                placeholder="ابحث عن الحساب…"
                data-testid="embedded-note-contra-account"
              />
            </label>

            <label className="flex flex-col gap-1"><span className="text-xs font-medium">المبلغ (قبل الضريبة) *</span>
              <Input type="number" min="0" step="0.01" value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                data-testid="embedded-note-amount" />
            </label>
            <label className="flex flex-col gap-1"><span className="text-xs font-medium">مركز التكلفة</span>
              <div data-testid="embedded-note-cost-center">
                <SearchCombobox
                  items={costCenterItems}
                  value={form.costCenter || undefined}
                  onValueChange={(v) => setForm({ ...form, costCenter: v })}
                  placeholder="— بدون —"
                  searchPlaceholder="ابحث…"
                />
              </div>
            </label>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium">ضريبة القيمة المضافة</span>
              <div className="flex items-center gap-2 h-9">
                <Checkbox checked={form.vatEnabled}
                  onCheckedChange={(v) => setForm({ ...form, vatEnabled: !!v })}
                  data-testid="embedded-note-vat-toggle" />
                <span className="text-xs">يشمل الضريبة</span>
                {form.vatEnabled && (
                  <Input type="number" min="0" step="0.01" className="h-8 w-20 text-xs"
                    value={form.vatRate}
                    onChange={(e) => setForm({ ...form, vatRate: e.target.value })}
                    data-testid="embedded-note-vat-rate" />
                )}
              </div>
            </div>

            {form.vatEnabled && (
              <label className="flex flex-col gap-1"><span className="text-xs font-medium">حساب ضريبة القيمة المضافة *</span>
                <AccountCombobox
                  value={form.vatAccountId ? String(form.vatAccountId) : undefined}
                  onValueChange={(v) => setForm({ ...form, vatAccountId: v })}
                  filterTypes={["liability", "asset"] as any}
                  placeholder="ابحث عن حساب الضريبة…"
                  data-testid="embedded-note-vat-account"
                />
              </label>
            )}

            <label className="md:col-span-3 flex flex-col gap-1"><span className="text-xs font-medium">البيان</span>
              <Input value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                data-testid="embedded-note-description" />
            </label>
          </div>

          {/* شريط الإجماليات */}
          <div className="grid grid-cols-3 gap-3 rounded-lg border bg-background p-3 text-center">
            <div><div className="text-[10px] text-muted-foreground">المبلغ</div><div className="text-sm font-semibold">{fmt2(amount)}</div></div>
            <div><div className="text-[10px] text-muted-foreground">الضريبة</div><div className="text-sm font-semibold">{fmt2(vatAmount)}</div></div>
            <div><div className="text-[10px] text-muted-foreground">الإجمالي</div><div className="text-sm font-bold text-primary" data-testid="embedded-note-total">{fmt2(total)}</div></div>
          </div>

          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" disabled={saveMut.isPending}
              onClick={() => submit(false)} data-testid="btn-embedded-save-draft">
              <Save className="h-4 w-4 ms-1" /> حفظ كمسودة
            </Button>
            <Button type="button" size="sm" disabled={saveMut.isPending}
              onClick={() => submit(true)} data-testid="btn-embedded-save-post">
              <CheckCircle2 className="h-4 w-4 ms-1" /> حفظ وترحيل
            </Button>
          </div>
        </div>
      )}

      {/* قائمة الإشعارات المرتبطة */}
      {isLoading ? (
        <div className="text-center text-xs text-muted-foreground py-6">جارٍ التحميل…</div>
      ) : linkedNotes.length === 0 ? (
        !showForm && (
          <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            لا توجد إشعارات مرتبطة بهذه الفاتورة بعد.
          </div>
        )
      ) : (
        <div className="rounded-xl border overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-muted/40">
              <tr className="text-start">
                <th className="p-2 text-start font-medium">الرقم</th>
                <th className="p-2 text-start font-medium">التاريخ</th>
                <th className="p-2 text-start font-medium">البيان</th>
                <th className="p-2 text-end font-medium">المبلغ</th>
                <th className="p-2 text-end font-medium">الضريبة</th>
                <th className="p-2 text-end font-medium">الإجمالي</th>
                <th className="p-2 text-center font-medium">الحالة</th>
                <th className="p-2 text-center font-medium">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {linkedNotes.map((n) => {
                const b = STATUS_BADGE[n.status] ?? STATUS_BADGE.draft;
                return (
                  <tr key={n.id} className="border-t hover:bg-muted/20" data-testid={`embedded-note-row-${n.id}`}>
                    <td className="p-2 font-medium" dir="ltr">{n.noteNumber}</td>
                    <td className="p-2" dir="ltr">{String(n.noteDate).slice(0, 10)}</td>
                    <td className="p-2 max-w-[220px] truncate" title={n.description ?? ""}>{n.description ?? "—"}</td>
                    <td className="p-2 text-end">{fmt2(n.amount)}</td>
                    <td className="p-2 text-end">{fmt2(n.vatAmount)}</td>
                    <td className="p-2 text-end font-semibold">{fmt2(n.totalAmount)}</td>
                    <td className="p-2 text-center">
                      <Badge variant="outline" className={`text-[10px] ${b.cls}`}>{b.label}</Badge>
                    </td>
                    <td className="p-2">
                      <div className="flex items-center justify-center gap-1">
                        <Button type="button" variant="ghost" size="icon" className="h-7 w-7" title="طباعة"
                          onClick={() => printRow(n)} data-testid={`btn-print-note-${n.id}`}>
                          <Printer className="h-3.5 w-3.5" />
                        </Button>
                        {!disabled && n.status === "draft" && (
                          <>
                            <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-emerald-600" title="ترحيل"
                              disabled={actMut.isPending}
                              onClick={() => actMut.mutate({ id: n.id, op: "post" })} data-testid={`btn-post-note-${n.id}`}>
                              <CheckCircle2 className="h-3.5 w-3.5" />
                            </Button>
                            <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-rose-600" title="حذف"
                              disabled={actMut.isPending}
                              onClick={() => { if (confirm("حذف هذا الإشعار؟")) actMut.mutate({ id: n.id, op: "delete" }); }}
                              data-testid={`btn-delete-note-${n.id}`}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        )}
                        {!disabled && n.status === "posted" && (
                          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-amber-600" title="فك الترحيل"
                            disabled={actMut.isPending}
                            onClick={() => { if (confirm("فك ترحيل هذا الإشعار؟")) actMut.mutate({ id: n.id, op: "unpost" }); }}
                            data-testid={`btn-unpost-note-${n.id}`}>
                            <Undo2 className="h-3.5 w-3.5" />
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
    </div>
  );
}
