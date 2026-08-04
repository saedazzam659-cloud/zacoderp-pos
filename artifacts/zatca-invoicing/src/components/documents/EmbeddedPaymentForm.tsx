// نموذج «تسجيل دفعة» مضمَّن داخل تبويب المدفوعات في الفاتورة — بنفس نمط
// الإشعار الدائن/المدين المضمَّن: بطاقة قابلة للطي بإطار مميّز، بدون مغادرة
// شاشة الفاتورة. يدعم توزيع الدفعة على عدة طرق (نقدي/بنك/شيك/تحويل/شبكة/محفظة)
// في نفس العملية — كل سطر يُنشئ سند قبض/صرف مرتبطاً بالفاتورة، ويأخذ رقمه من
// محرّك التسلسلات الرسمي (سلسلة السندات حسب طريقة الدفع)، والقيد المحاسبي
// يُنشأ عند الترحيل من نفس مسار السندات المعتاد — لا ترقيم جانبي.
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Save, CheckCircle2, X, Trash2, Wallet, Landmark, CreditCard, FileText, ArrowLeftRight, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateField } from "@/components/ui/date-field";
import { SearchCombobox, type ComboboxItem } from "@/components/ui/search-combobox";
import { useToast } from "@/hooks/use-toast";
import { fetchJsonArray } from "@/lib/fetchJsonArray";
import { useFormatters } from "@/lib/format";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

/** طرق الدفع المعروضة — تُترجم إلى paymentType الرسمي للسند (cash|bank). */
const METHODS = [
  { key: "cash",     label: "نقدي",         pt: "cash", Icon: Wallet },
  { key: "bank",     label: "بنك",          pt: "bank", Icon: Landmark },
  { key: "transfer", label: "تحويل بنكي",   pt: "bank", Icon: ArrowLeftRight },
  { key: "cheque",   label: "شيك",          pt: "bank", Icon: FileText },
  { key: "card",     label: "بطاقة/شبكة",   pt: "bank", Icon: CreditCard },
  { key: "wallet",   label: "محفظة إلكترونية", pt: "bank", Icon: Smartphone },
] as const;
type MethodKey = typeof METHODS[number]["key"];
const methodOf = (k: MethodKey) => METHODS.find(m => m.key === k)!;

interface PayLine {
  method: MethodKey;
  treasuryId: string;   // cashBoxId عند نقدي، وإلا bankAccountId
  amount: string;
  reference: string;    // رقم شيك/مرجع تحويل… اختياري
  /** نتيجة سطر تم تنفيذه فعلاً — تمنع إعادة إنشاء سند مكرر عند إعادة المحاولة. */
  done?: { id: number; code?: string; posted: boolean };
}

interface Props {
  kind: "sales" | "purchase";
  invoiceId: number;
  companyId?: number;
  token?: string | null;
  entityId?: string;
  entityName?: string;
  docNumber?: string;
  /** أقصى مبلغ يمكن تسجيله الآن (المتبقّي بعد المرحّل + المسودّات). */
  available: number;
  /** سعر صرف الفاتورة — تُسجَّل الدفعات بعملة الفاتورة وبنفس السعر. */
  exchangeRate?: number;
  /** كود عملة الفاتورة (مثل SAR/USD) — يُحوَّل داخلياً إلى currencyId للسند. */
  currencyCode?: string | null;
  onClose: () => void;
  onSaved: () => void;
}

export default function EmbeddedPaymentForm({
  kind, invoiceId, companyId, token, entityId, entityName, docNumber,
  available, exchangeRate = 1, currencyCode, onClose, onSaved,
}: Props) {
  const { fmt } = useFormatters();
  const { toast } = useToast();
  const authH = { Authorization: `Bearer ${token}` };
  const isSales = kind === "sales";
  const voucherBase = isSales ? "receipt-vouchers" : "payment-vouchers";
  const voucherWord = isSales ? "سند قبض" : "سند صرف";

  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState<PayLine[]>([
    { method: "cash", treasuryId: "", amount: available > 0 ? available.toFixed(2) : "", reference: "" },
  ]);

  const { data: cashBoxes = [] } = useQuery<any[]>({
    queryKey: ["cash-boxes", companyId],
    queryFn: () => fetchJsonArray(`${API}/api/cash-boxes?companyId=${companyId}`, authH),
    enabled: !!companyId,
    staleTime: 60_000,
  });
  const { data: bankAccounts = [] } = useQuery<any[]>({
    queryKey: ["bank-accounts", companyId],
    queryFn: () => fetchJsonArray(`${API}/api/bank-accounts?companyId=${companyId}`, authH),
    enabled: !!companyId,
    staleTime: 60_000,
  });
  // عملات الشركة — لتحويل كود عملة الفاتورة إلى currencyId على السند.
  const { data: currencies = [] } = useQuery<any[]>({
    queryKey: ["currencies", companyId],
    queryFn: () => fetchJsonArray(`${API}/api/currencies?companyId=${companyId}`, authH),
    enabled: !!companyId,
    staleTime: 60_000,
  });
  const currencyId = useMemo(() => {
    const code = (currencyCode || "").trim();
    if (!code) return null;
    const m = (currencies as any[]).find((c: any) => String(c.code ?? "").toUpperCase() === code.toUpperCase());
    return m ? String(m.id) : null;
  }, [currencies, currencyCode]);

  const cashItems: ComboboxItem[] = useMemo(
    () => (cashBoxes as any[]).filter((c: any) => c.isActive !== false)
      .map((c: any) => ({ value: String(c.id), label: c.nameAr ?? c.name ?? `#${c.id}` })),
    [cashBoxes]);
  const bankItems: ComboboxItem[] = useMemo(
    () => (bankAccounts as any[]).filter((b: any) => b.isActive !== false)
      .map((b: any) => ({ value: String(b.id), label: b.nameAr ?? b.name ?? b.bankName ?? `#${b.id}` })),
    [bankAccounts]);

  const distributed = lines.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);
  const leftToDistribute = +(available - distributed).toFixed(2);

  function setLine(i: number, patch: Partial<PayLine>) {
    setLines(ls => ls.map((l, idx) => {
      if (idx !== i) return l;
      const next = { ...l, ...patch };
      // تغيير الطريقة بين نقدي/بنكي يُبطل الخزينة المختارة.
      if (patch.method && methodOf(patch.method).pt !== methodOf(l.method).pt) next.treasuryId = "";
      return next;
    }));
  }
  function addLine() {
    setLines(ls => [...ls, {
      method: "bank", treasuryId: "",
      amount: leftToDistribute > 0 ? leftToDistribute.toFixed(2) : "",
      reference: "",
    }]);
  }
  function fillRemaining(i: number) {
    const others = lines.reduce((s, l, idx) => idx === i ? s : s + (parseFloat(l.amount) || 0), 0);
    const rest = +(available - others).toFixed(2);
    setLine(i, { amount: rest > 0 ? rest.toFixed(2) : "" });
  }

  const saveMut = useMutation({
    // تنفيذ آمن لإعادة المحاولة: كل سطر يحمل نتيجة تنفيذه (done)، فالسطر الذي
    // أُنشئ سنده لا يُنشأ مرة أخرى عند إعادة الضغط بعد فشل جزئي — يُستكمل
    // ترحيله فقط إن لزم. سند لكل سطر يحافظ على سلاسل الترقيم لكل طريقة دفع.
    mutationFn: async (postAfter: boolean) => {
      const work = [...lines];
      const progress = (i: number, done: PayLine["done"]) => {
        work[i] = { ...work[i], done };
        setLines(ls => ls.map((l, idx) => (idx === i ? { ...l, done } : l)));
      };
      for (let i = 0; i < work.length; i++) {
        const l = work[i];
        const m = methodOf(l.method);
        let created = l.done;
        if (!created) {
          const body: any = {
            companyId,
            date,
            paymentType: m.pt,
            cashBoxId: m.pt === "cash" ? l.treasuryId : null,
            bankAccountId: m.pt === "bank" ? l.treasuryId : null,
            entityId: entityId || null,
            entityName: entityName || null,
            amount: (parseFloat(l.amount) || 0).toFixed(2),
            exchangeRate: String(exchangeRate || 1),
            currencyId: currencyId || null,
            refNumber: l.reference || null,
            description: `${voucherWord} — ${m.label}${docNumber ? ` على فاتورة ${docNumber}` : ""}`,
            [isSales ? "salesInvoiceId" : "purchaseInvoiceId"]: invoiceId,
          };
          const res = await fetch(`${API}/api/${voucherBase}`, {
            method: "POST",
            headers: { ...authH, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) {
            const doneCodes = work.filter(w => w.done).map(w => w.done!.code).filter(Boolean);
            throw new Error(
              `${j.error || `فشل إنشاء ${voucherWord}`} (السطر ${i + 1} — ${m.label})` +
              (doneCodes.length ? `. السندات المُنشأة قبل الفشل: ${doneCodes.join("، ")}` : ""),
            );
          }
          created = { id: j.id, code: j.code, posted: false };
          progress(i, created);
        }
        if (postAfter && !created.posted) {
          const pr = await fetch(`${API}/api/${voucherBase}/${created.id}/post?companyId=${companyId}`, {
            method: "POST", headers: { ...authH, "Content-Type": "application/json" },
          });
          const pj = await pr.json().catch(() => ({}));
          if (!pr.ok) {
            throw new Error(
              `${pj.error || "تعذّر الترحيل"} — أُنشئ ${voucherWord} ${created.code ?? ""} كمسودة (السطر ${i + 1})؛ أعد المحاولة لاستكمال الترحيل دون تكرار`,
            );
          }
          progress(i, { ...created, posted: true });
        }
      }
      return work.map(w => w.done!);
    },
    onSuccess: (rs, postAfter) => {
      toast({
        title: postAfter ? "تم تسجيل الدفعة وترحيلها" : "تم حفظ الدفعة كمسودة",
        description: rs.map(r => r.code).filter(Boolean).join("، ") || undefined,
      });
      onSaved();
      onClose();
    },
    onError: (e: any) => {
      toast({ title: "لم تكتمل العملية", description: String(e?.message || e), variant: "destructive" });
      // قد تكون بعض السندات أُنشئت قبل الفشل — حدِّث القائمة ليظهر ما تم،
      // وأبقِ النموذج مفتوحاً: السطور المُنفَّذة معلَّمة ولن تتكرر عند الإعادة.
      onSaved();
    },
  });

  function submit(postAfter: boolean) {
    if (lines.length === 0) { toast({ title: "أضف طريقة دفع واحدة على الأقل", variant: "destructive" }); return; }
    for (const [i, l] of lines.entries()) {
      const m = methodOf(l.method);
      if (!(parseFloat(l.amount) > 0)) { toast({ title: `أدخل مبلغاً صحيحاً في السطر ${i + 1}`, variant: "destructive" }); return; }
      if (!l.treasuryId) {
        toast({ title: m.pt === "cash" ? `حدّد الصندوق في السطر ${i + 1}` : `حدّد الحساب البنكي في السطر ${i + 1}`, variant: "destructive" });
        return;
      }
    }
    if (distributed > available + 0.005) {
      toast({ title: "إجمالي التوزيع يتجاوز المتبقّي على الفاتورة", description: `الموزَّع ${fmt(distributed)} والمتاح ${fmt(available)}`, variant: "destructive" });
      return;
    }
    saveMut.mutate(postAfter);
  }

  return (
    <div className="rounded-xl border-2 border-primary/30 bg-primary/[0.03] p-4 space-y-4" data-testid="embedded-payment-form">
      <div className="flex items-center justify-between">
        <span className="text-sm font-bold">
          {isSales ? "تسجيل دفعة (سند قبض)" : "تسجيل دفعة (سند صرف)"}
          {entityName ? ` — ${entityName}` : ""}
        </span>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} data-testid="btn-close-payment-form">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-x-4 gap-y-3">
        <label className="flex flex-col gap-1"><span className="text-xs font-medium">تاريخ الدفعة *</span>
          <DateField value={date} onChange={(e) => setDate(e.target.value)} data-testid="payment-date" />
        </label>
        <div className="md:col-span-2 flex items-end justify-end">
          <span className="text-xs text-muted-foreground">
            المتبقّي على الفاتورة: <span className="font-semibold text-foreground tabular-nums" dir="ltr">{fmt(available)}</span>
          </span>
        </div>
      </div>

      {/* سطور توزيع الدفعة على الطرق */}
      <div className="space-y-2">
        {lines.map((l, i) => {
          const m = methodOf(l.method);
          const items = m.pt === "cash" ? cashItems : bankItems;
          const locked = !!l.done; // سطر نُفِّذ فعلاً (فشل جزئي سابق) — لا يُعدَّل ولا يتكرر
          return (
            <div key={i} className={`grid grid-cols-2 md:grid-cols-[1.1fr_1.3fr_0.9fr_1fr_auto] gap-2 items-end rounded-lg border p-2.5 ${locked ? "bg-emerald-50/50 border-emerald-200" : "bg-background"}`} data-testid={`payment-line-${i}`}>
              <label className="flex flex-col gap-1"><span className="text-[11px] font-medium">الطريقة</span>
                <SearchCombobox
                  items={METHODS.map(mm => ({ value: mm.key, label: mm.label }))}
                  value={l.method}
                  onValueChange={(v) => setLine(i, { method: (v || "cash") as MethodKey })}
                  placeholder="الطريقة"
                  disabled={locked}
                />
              </label>
              <label className="flex flex-col gap-1"><span className="text-[11px] font-medium">{m.pt === "cash" ? "الصندوق *" : "الحساب البنكي *"}</span>
                <SearchCombobox
                  items={items}
                  value={l.treasuryId || undefined}
                  onValueChange={(v) => setLine(i, { treasuryId: v || "" })}
                  placeholder={m.pt === "cash" ? "اختر الصندوق…" : "اختر البنك…"}
                  searchPlaceholder="ابحث…"
                  disabled={locked}
                />
              </label>
              <label className="flex flex-col gap-1"><span className="text-[11px] font-medium">المبلغ *</span>
                <div className="flex gap-1">
                  <Input type="number" min="0" step="0.01" value={l.amount} dir="ltr" disabled={locked}
                    onChange={(e) => setLine(i, { amount: e.target.value })}
                    data-testid={`payment-amount-${i}`} />
                  {!locked && (
                    <Button type="button" variant="outline" size="sm" className="h-9 px-2 text-[10px] whitespace-nowrap shrink-0"
                      onClick={() => fillRemaining(i)} title="تعبئة المتبقّي بالكامل في هذا السطر">
                      الكل
                    </Button>
                  )}
                </div>
              </label>
              <label className="flex flex-col gap-1"><span className="text-[11px] font-medium">مرجع (شيك/تحويل)</span>
                <Input value={l.reference} disabled={locked} onChange={(e) => setLine(i, { reference: e.target.value })}
                  placeholder="اختياري" data-testid={`payment-ref-${i}`} />
              </label>
              {locked ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-[10px] font-medium text-emerald-700 whitespace-nowrap" title={l.done!.posted ? "سند مرحّل" : "سند مسودة — أعد المحاولة لترحيله"}>
                  <CheckCircle2 className="h-3 w-3" />
                  {l.done!.code ?? `#${l.done!.id}`}{l.done!.posted ? "" : " (مسودة)"}
                </span>
              ) : (
                <Button type="button" variant="ghost" size="icon" className="h-9 w-9 text-rose-600"
                  disabled={lines.length <= 1}
                  onClick={() => setLines(ls => ls.filter((_, idx) => idx !== i))}
                  title="حذف السطر" data-testid={`btn-remove-line-${i}`}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          );
        })}
        <Button type="button" variant="outline" size="sm" onClick={addLine} data-testid="btn-add-payment-line">
          <Plus className="h-4 w-4 ms-1" /> إضافة طريقة دفع أخرى
        </Button>
      </div>

      {/* شريط الإجماليات اللحظي */}
      <div className="grid grid-cols-3 gap-3 rounded-lg border bg-background p-3 text-center">
        <div><div className="text-[10px] text-muted-foreground">المتبقّي على الفاتورة</div><div className="text-sm font-semibold tabular-nums" dir="ltr">{fmt(available)}</div></div>
        <div><div className="text-[10px] text-muted-foreground">الموزَّع في هذه الدفعة</div><div className="text-sm font-semibold tabular-nums text-primary" dir="ltr" data-testid="payment-distributed">{fmt(distributed)}</div></div>
        <div>
          <div className="text-[10px] text-muted-foreground">المتبقّي بعد الدفعة</div>
          <div className={`text-sm font-bold tabular-nums ${leftToDistribute < -0.005 ? "text-rose-600" : leftToDistribute <= 0.005 ? "text-emerald-600" : ""}`} dir="ltr" data-testid="payment-left-after">
            {fmt(leftToDistribute)}
          </div>
        </div>
      </div>
      {leftToDistribute < -0.005 && (
        <p className="text-[11px] text-rose-600">إجمالي التوزيع يتجاوز المتبقّي على الفاتورة — قلّل المبالغ.</p>
      )}

      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" disabled={saveMut.isPending}
          onClick={() => submit(false)} data-testid="btn-payment-save-draft">
          <Save className="h-4 w-4 ms-1" /> حفظ كمسودة
        </Button>
        <Button type="button" size="sm" disabled={saveMut.isPending}
          onClick={() => submit(true)} data-testid="btn-payment-save-post">
          <CheckCircle2 className="h-4 w-4 ms-1" /> حفظ وترحيل
        </Button>
      </div>
    </div>
  );
}
