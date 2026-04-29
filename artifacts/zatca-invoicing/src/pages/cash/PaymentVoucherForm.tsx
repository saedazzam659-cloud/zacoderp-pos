import { useState, useEffect, useRef, useMemo } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useFormatters } from "@/lib/format";
import { useNextSequenceNumber } from "@/hooks/useNextSequenceNumber";
import { parseError } from "@/lib/parseError";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { SearchCombobox, type ComboboxItem } from "@/components/ui/search-combobox";
import {
  ArrowUpCircle, ArrowRight, ChevronLeft, Search,
  Loader2, Save, Send, Lock, FileText, Banknote,
  Wallet, Building2, Truck, Printer, Link2, X, Settings2,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const today = () => new Date().toISOString().slice(0, 10);

interface FormState {
  date: string;
  paymentType: "cash" | "bank";
  cashBoxId: string;
  bankAccountId: string;
  entityId: string;          // supplier id (always)
  entityName: string;        // cached name for JE preview
  amount: string;
  exchangeRate: string;
  purchaseInvoiceId: string; // optional link
  refType: string;
  refNumber: string;
  description: string;
  notes: string;
}

const EMPTY: FormState = {
  date: today(),
  paymentType: "cash",
  cashBoxId: "",
  bankAccountId: "",
  entityId: "",
  entityName: "",
  amount: "",
  exchangeRate: "1",
  purchaseInvoiceId: "",
  refType: "",
  refNumber: "",
  description: "",
  notes: "",
};

export default function PaymentVoucherForm() {
  const { user, token } = useAuth();
  const { t } = useTranslation();
  const { fmt, isRtl } = useFormatters();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();

  const [matchNew] = useRoute("/cash/payment-vouchers/new");
  const [matchEdit, params] = useRoute("/cash/payment-vouchers/:id");
  const isNew  = !!matchNew;
  // Wouter matches "/new" against ":id" too — guard against opening the
  // create-mode URL in edit mode.
  const rawId  = matchEdit && !isNew ? (params as any).id : null;
  const editId = rawId && /^\d+$/.test(String(rawId)) ? Number(rawId) : null;

  const NS = "paymentVouchers";
  const cid = user?.companyId;
  const h = { Authorization: `Bearer ${token}` };

  const [form, setForm] = useState<FormState>(EMPTY);
  const [linkInvoice, setLinkInvoice] = useState(false);

  // ── Sequence preview for new vouchers ───────────────────────────
  const seqPeek = useNextSequenceNumber("payment_voucher", isNew);

  // ── Data fetches ─────────────────────────────────────────────────
  const { data: cashBoxes = [] } = useQuery<any[]>({
    queryKey: ["cash-boxes", cid],
    queryFn: () => fetch(`${API}/api/cash-boxes?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
  });
  const { data: bankAccounts = [] } = useQuery<any[]>({
    queryKey: ["bank-accounts", cid],
    queryFn: () => fetch(`${API}/api/bank-accounts?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
  });
  const { data: suppliers = [] } = useQuery<any[]>({
    queryKey: ["suppliers", cid],
    queryFn: () => fetch(`${API}/api/suppliers?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
  });
  // Purchase invoices for the optional link picker. We pull the full list
  // for this tenant once and filter client-side per selected supplier —
  // simpler than maintaining a per-supplier endpoint and the data is
  // small (already used elsewhere in the UI).
  const { data: purchaseInvoices = [] } = useQuery<any[]>({
    queryKey: ["purchase-invoices", cid],
    queryFn: () => fetch(`${API}/api/purchasing/purchase-invoices?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
    staleTime: 30_000,
  });

  // ── Voucher list (used both for prev/next nav and for edit-mode load) ─
  const { data: vouchers = [] } = useQuery<any[]>({
    queryKey: ["payment-vouchers", cid],
    queryFn: () => fetch(`${API}/api/payment-vouchers?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
    staleTime: 30_000,
  });

  // ── Edit-mode: load the single voucher ─────────────────────────
  const { data: existing, isLoading: loadingEdit } = useQuery<any>({
    queryKey: ["payment-voucher", editId],
    queryFn: () => fetch(`${API}/api/payment-vouchers/${editId}`, { headers: h }).then(r => r.json()),
    enabled: !!editId,
  });

  useEffect(() => {
    if (!existing) return;
    setForm({
      date: existing.date ?? today(),
      paymentType: (existing.paymentType ?? "cash") as "cash" | "bank",
      cashBoxId: existing.cashBoxId ? String(existing.cashBoxId) : "",
      bankAccountId: existing.bankAccountId ? String(existing.bankAccountId) : "",
      entityId: existing.entityId ? String(existing.entityId) : "",
      entityName: existing.entityName ?? "",
      amount: existing.amount ?? "",
      exchangeRate: existing.exchangeRate ?? "1",
      purchaseInvoiceId: existing.purchaseInvoiceId ? String(existing.purchaseInvoiceId) : "",
      refType: existing.refType ?? "",
      refNumber: existing.refNumber ?? "",
      description: existing.description ?? "",
      notes: existing.notes ?? "",
    });
    setLinkInvoice(!!existing.purchaseInvoiceId);
  }, [existing]);

  // ── Document navigation (prev/next/jump-by-search) ─────────────
  const navList = vouchers as any[];
  const currentIndex = editId != null
    ? navList.findIndex(v => Number(v.id) === Number(editId))
    : -1;
  const prevVoucher = currentIndex >= 0 && currentIndex < navList.length - 1
    ? navList[currentIndex + 1] : null;
  const nextVoucher = currentIndex > 0 ? navList[currentIndex - 1] : null;

  const [navSearch, setNavSearch] = useState("");
  function jumpFromSearch() {
    const q = navSearch.trim().toLowerCase();
    if (!q) return;
    const hit =
      navList.find(v => String(v.code ?? "").toLowerCase() === q) ||
      navList.find(v => String(v.code ?? "").toLowerCase().includes(q)) ||
      navList.find(v => String(v.description ?? "").toLowerCase().includes(q)) ||
      navList.find(v => String(v.entityName ?? "").toLowerCase().includes(q));
    if (!hit) {
      toast({ title: t(`${NS}.searchNotFound`, "لم يتم العثور على سند مطابق"), variant: "destructive" });
      return;
    }
    setNavSearch("");
    navigate(`/cash/payment-vouchers/${hit.id}`);
  }

  // ── Build searchable combobox items ────────────────────────────
  const cashBoxItems: ComboboxItem[] = useMemo(() =>
    (cashBoxes as any[]).map(c => ({
      value: String(c.id),
      label: isRtl ? c.nameAr : (c.nameEn || c.nameAr),
    })), [cashBoxes, isRtl]);

  const bankAccountItems: ComboboxItem[] = useMemo(() =>
    (bankAccounts as any[]).map(b => ({
      value: String(b.id),
      label: isRtl ? b.nameAr : (b.nameEn || b.nameAr),
      description: b.accountNumber ?? b.iban ?? undefined,
    })), [bankAccounts, isRtl]);

  const supplierItems: ComboboxItem[] = useMemo(() =>
    (suppliers as any[]).map(s => ({
      value: String(s.id),
      label: isRtl ? s.nameAr : (s.nameEn || s.nameAr),
      code: s.code ?? undefined,
      description: s.phone ?? s.email ?? undefined,
    })), [suppliers, isRtl]);

  // Purchase invoices the picked supplier still has open / payable. We
  // include posted invoices (most common case — settle a credit invoice)
  // and exclude cancelled ones; if the form is editing an existing
  // voucher whose linked invoice was since cancelled, we still surface
  // it so the user can see the (stale) link.
  const invoiceItems: ComboboxItem[] = useMemo(() => {
    if (!form.entityId) return [];
    const sid = Number(form.entityId);
    const list = (purchaseInvoices as any[])
      .filter((inv: any) => Number(inv.supplierId) === sid && inv.status !== "cancelled")
      .map((inv: any) => ({
        value: String(inv.id),
        label: inv.docNumber ?? `PI-${inv.id}`,
        description: `${inv.invoiceDate} • ${Number(inv.totalAmount || 0).toFixed(2)} ${inv.currencyCode || "SAR"}`,
        code: inv.status,
      }));
    // Make sure the currently-linked invoice is always selectable, even
    // if it's owned by a different supplier or is cancelled.
    if (form.purchaseInvoiceId && !list.some(i => i.value === form.purchaseInvoiceId)) {
      const inv = (purchaseInvoices as any[]).find((x: any) => String(x.id) === form.purchaseInvoiceId);
      if (inv) {
        list.unshift({
          value: String(inv.id),
          label: inv.docNumber ?? `PI-${inv.id}`,
          description: `${inv.invoiceDate} • ${Number(inv.totalAmount || 0).toFixed(2)} ${inv.currencyCode || "SAR"}`,
          code: inv.status,
        });
      }
    }
    return list;
  }, [purchaseInvoices, form.entityId, form.purchaseInvoiceId]);

  // ── Live Journal-Entry preview (mirrors backend posting logic) ──
  function jePreview() {
    const amt = Number(form.amount || 0);
    if (!isFinite(amt) || amt <= 0) return null;
    const cb = (cashBoxes as any[]).find((c: any) => String(c.id) === form.cashBoxId);
    const ba = (bankAccounts as any[]).find((b: any) => String(b.id) === form.bankAccountId);
    const cbName = cb ? (isRtl ? cb.nameAr : (cb.nameEn || cb.nameAr)) : "";
    const baName = ba ? (isRtl ? ba.nameAr : (ba.nameEn || ba.nameAr)) : "";
    const crLabel = form.paymentType === "bank"
      ? (ba ? t(`${NS}.bankPrefix`, { name: baName }) : t(`${NS}.noBankSelected`))
      : (cb ? t(`${NS}.cashPrefix`, { name: cbName }) : t(`${NS}.noCashSelected`));
    const drLabel = form.entityName
      ? t(`${NS}.supplierPrefix`, { name: form.entityName })
      : t(`${NS}.noSupplierSelected`, "— لم يتم اختيار المورد —");
    return { drLabel, crLabel, amount: amt };
  }

  // ── Save / Save-and-post mutation ──────────────────────────────
  const [pendingMode, setPendingMode] = useState<"draft" | "post" | null>(null);
  const isLockedSourceEntry = !isNew && existing?.status === "posted";

  const saveMut = useMutation({
    mutationFn: async (mode: "draft" | "post") => {
      const cleanAmt = String(form.amount).replace(/[^\d.\-]/g, "");
      const amtNum = Number(cleanAmt);
      if (!isFinite(amtNum) || amtNum <= 0) throw new Error(t(`${NS}.invalidAmount`));
      if (!form.date) throw new Error(t(`${NS}.dateRequired`, "التاريخ مطلوب"));
      if (form.paymentType === "cash" && !form.cashBoxId)
        throw new Error(t(`${NS}.cashBoxRequired`, "الخزنة مطلوبة عند الدفع نقداً"));
      if (form.paymentType === "bank" && !form.bankAccountId)
        throw new Error(t(`${NS}.bankRequired`, "الحساب البنكي مطلوب عند الدفع بنكاً"));
      if (!form.entityId)
        throw new Error(t(`${NS}.supplierRequired`, "اختيار المورد مطلوب"));

      const body = {
        ...form,
        amount: amtNum.toFixed(2),
        companyId: cid,
        // Server force-overrides to "supplier" but we send it for clarity.
        entityType: "supplier",
        cashBoxId:    form.cashBoxId    ? parseInt(form.cashBoxId)    : null,
        bankAccountId:form.bankAccountId? parseInt(form.bankAccountId): null,
        entityId:     form.entityId     ? parseInt(form.entityId)     : null,
        purchaseInvoiceId: linkInvoice && form.purchaseInvoiceId
          ? parseInt(form.purchaseInvoiceId) : null,
      };

      const url = isNew
        ? `${API}/api/payment-vouchers`
        : `${API}/api/payment-vouchers/${editId}`;
      const res = await fetch(url, {
        method: isNew ? "POST" : "PUT",
        headers: { ...h, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      const saved = await res.json();

      if (mode === "post" && saved?.id && (saved.status ?? "draft") === "draft") {
        const pr = await fetch(`${API}/api/payment-vouchers/${saved.id}/post`, { method: "POST", headers: h });
        const pj = await pr.json().catch(() => ({}));
        if (!pr.ok) {
          // Saved as draft, posting failed — surface the partial success
          // to the toast so the user knows the voucher already exists
          // and won't accidentally re-create it.
          return { ...saved, _posted: false, _postError: pj?.error || pr.statusText };
        }
        return { ...pj, _posted: true };
      }
      return { ...saved, _posted: false };
    },
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["payment-vouchers"] });
      qc.invalidateQueries({ queryKey: ["payment-voucher", data.id] });
      // The purchase-invoices listing surfaces the linked payment, so
      // make sure it refetches after a save that touches a link.
      qc.invalidateQueries({ queryKey: ["purchase-invoices"] });
      if (data?._postError) {
        toast({
          variant: "destructive",
          title: t(`${NS}.savedButPostFailed`, "تم الحفظ كمسودة — لكن فشل الترحيل"),
          description: data._postError,
        });
      } else {
        toast({
          title: data?._posted
            ? (isNew ? t(`${NS}.saved_create`) : t(`${NS}.saved_update`))
            : t(`${NS}.savedDraft`, "تم الحفظ كمسودة"),
        });
      }
      navigate("/cash/payment-vouchers");
    },
    onError: (e: any) => toast({ title: t(`${NS}.err_save`), description: parseError(e), variant: "destructive" }),
    onSettled: () => setPendingMode(null),
  });

  function save(mode: "draft" | "post") {
    if (isLockedSourceEntry) {
      toast({
        title: t(`${NS}.cantEditPosted`, "لا يمكن تعديل سند مرحَّل"),
        description: t(`${NS}.unpostFirst`, "افتح السند من القائمة وقم بفك ترحيله أولاً."),
        variant: "destructive",
      });
      return;
    }
    setPendingMode(mode);
    saveMut.mutate(mode);
  }

  // ── Form-wide Enter-key navigation ─────────────────────────────
  const formRef = useRef<HTMLDivElement>(null);

  function getNavList(): HTMLElement[] {
    const root = formRef.current;
    if (!root) return [];
    const SEL = [
      'input:not([type="hidden"]):not([disabled])',
      'textarea:not([disabled])',
      'button[role="combobox"]:not([disabled])',
      'select:not([disabled])',
    ].join(", ");
    return Array.from(root.querySelectorAll<HTMLElement>(SEL))
      .filter(el => el.offsetParent !== null && el.tabIndex !== -1);
  }
  function advanceFromTarget(target: HTMLElement) {
    const all = getNavList();
    const i = all.indexOf(target);
    if (i === -1) return false;
    if (i + 1 < all.length) {
      const next = all[i + 1];
      next.focus();
      if (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement) {
        try { next.select(); } catch { /* date inputs don't support select */ }
      }
    } else {
      if (!saveMut.isPending && !isLockedSourceEntry) save("draft");
    }
    return true;
  }
  function handleFormKeyDownCapture(e: React.KeyboardEvent) {
    if (e.key !== "Enter") return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if ((e.nativeEvent as any).isComposing) return;
    const target = e.target as HTMLElement;
    if (!target || target.tagName !== "BUTTON") return;
    if (target.getAttribute("role") !== "combobox") return;
    e.preventDefault(); e.stopPropagation();
    advanceFromTarget(target);
  }
  function handleFormKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "Enter") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.nativeEvent as any).isComposing) return;
    const target = e.target as HTMLElement;
    if (!target) return;
    if (target.tagName === "TEXTAREA" && e.shiftKey) return;
    e.preventDefault();
    advanceFromTarget(target);
  }

  // ── Print (single voucher) ─────────────────────────────────────
  function escapeHtml(s: any) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  }
  function openPrintWindow() {
    if (!existing) return;
    const w = window.open("", "_blank", "width=900,height=700");
    if (!w) return;
    const cb = (cashBoxes as any[]).find((c: any) => String(c.id) === String(existing.cashBoxId));
    const ba = (bankAccounts as any[]).find((b: any) => String(b.id) === String(existing.bankAccountId));
    const treasuryName = existing.paymentType === "bank"
      ? (ba ? (isRtl ? ba.nameAr : (ba.nameEn || ba.nameAr)) : "—")
      : (cb ? (isRtl ? cb.nameAr : (cb.nameEn || cb.nameAr)) : "—");
    const linkedInv = existing.purchaseInvoiceId
      ? (purchaseInvoices as any[]).find((i: any) => i.id === existing.purchaseInvoiceId)
      : null;
    const html = `<!doctype html><html dir="rtl"><head><meta charset="utf-8"/><title>سند صرف ${escapeHtml(existing.code)}</title>
<style>
body { font-family: "Segoe UI","Tahoma","Arial",system-ui,sans-serif; color:#111; margin:24px; }
h1 { color:#b91c1c; border-bottom: 2px solid #b91c1c; padding-bottom:8px; margin:0 0 16px; font-size:22px; }
.grid { display:grid; grid-template-columns: 1fr 1fr; gap:8px 16px; font-size:13px; padding:12px; border:1px solid #e5e7eb; border-radius:8px; background:#fafbfd; margin-bottom:16px; }
.lbl { color:#6b7280; font-size:11px; }
.val { font-weight:600; }
.amount-box { padding:14px; border:2px solid #b91c1c; border-radius:8px; background:#fef2f2; text-align:center; margin:12px 0; }
.amount-box .lbl { font-size:12px; color:#b91c1c; }
.amount-box .num { font-size:28px; font-weight:800; color:#b91c1c; font-family:"Consolas",monospace; }
.desc { padding:10px; border:1px dashed #cbd5e1; border-radius:6px; font-size:13px; }
.print-btn { position:fixed; top:10px; left:10px; padding:8px 14px; background:#b91c1c; color:#fff; border:none; border-radius:6px; cursor:pointer; }
@media print { .print-btn { display:none; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">طباعة</button>
<h1>سند صرف — ${escapeHtml(existing.code)}</h1>
<div class="grid">
  <div><div class="lbl">التاريخ</div><div class="val">${escapeHtml(existing.date)}</div></div>
  <div><div class="lbl">الحالة</div><div class="val">${existing.status === "posted" ? "مرحَّل" : "مسودة"}</div></div>
  <div><div class="lbl">وسيلة الدفع</div><div class="val">${existing.paymentType === "bank" ? "بنك" : "نقداً"}</div></div>
  <div><div class="lbl">${existing.paymentType === "bank" ? "الحساب البنكي" : "الخزنة"}</div><div class="val">${escapeHtml(treasuryName)}</div></div>
  <div><div class="lbl">المورد</div><div class="val">${escapeHtml(existing.entityName ?? "—")}</div></div>
  <div><div class="lbl">فاتورة الشراء المرتبطة</div><div class="val">${linkedInv ? escapeHtml(linkedInv.docNumber ?? `PI-${linkedInv.id}`) : "—"}</div></div>
</div>
<div class="amount-box">
  <div class="lbl">المبلغ المدفوع</div>
  <div class="num">${Number(existing.amount).toFixed(2)} ${escapeHtml(existing.currency || "SAR")}</div>
</div>
${existing.description ? `<div class="desc"><div class="lbl">البيان</div>${escapeHtml(existing.description)}</div>` : ""}
<script>setTimeout(()=>window.print(),300);</script>
</body></html>`;
    w.document.open(); w.document.write(html); w.document.close();
  }

  // ── Loading state ──────────────────────────────────────────────
  if (!isNew && loadingEdit) {
    return <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">جارٍ التحميل...</div>;
  }

  const preview = jePreview();
  const docLabel = existing?.code ?? (isNew && seqPeek.number ? seqPeek.number : (seqPeek.loading ? "..." : t(`${NS}.autoCode`)));
  const autoPostingEnabled = (user as any)?.company?.autoPostingEnabled !== false;

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div
      ref={formRef}
      onKeyDownCapture={handleFormKeyDownCapture}
      onKeyDown={handleFormKeyDown}
      className="p-6 space-y-5 max-w-6xl mx-auto pb-24"
      dir={isRtl ? "rtl" : "ltr"}
      data-testid="payment-voucher-form"
    >
      {/* ─── Header bar ────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/cash/payment-vouchers")} className="h-8 w-8" title={t(`${NS}.backToList`, "عودة للقائمة")}>
            <ArrowRight className={cn("h-4 w-4", !isRtl && "rotate-180")} />
          </Button>
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-red-100 text-red-700">
              <ArrowUpCircle className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold">{isNew ? t(`${NS}.newLong`) : t(`${NS}.editVoucher`)}</h1>
              <p className="text-xs text-muted-foreground">
                {isNew
                  ? t(`${NS}.subtitle`)
                  : t(`${NS}.editingCode`, { code: existing?.code ?? `#${editId}`, defaultValue: `تعديل السند ${existing?.code ?? `#${editId}`}` })}
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {!isNew && navList.length > 0 && (
            <div className="flex items-center gap-1 rounded-md border bg-background px-1 py-0.5 print:hidden">
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2 gap-1 text-xs"
                disabled={!prevVoucher}
                onClick={() => prevVoucher && navigate(`/cash/payment-vouchers/${prevVoucher.id}`)}
                title={prevVoucher ? `${prevVoucher.code}` : ""}>
                <ChevronLeft className={cn("h-3.5 w-3.5", isRtl && "rotate-180")} />
                {t(`${NS}.prev`, "السابق")}
              </Button>
              <span className="text-[11px] tabular-nums px-1.5 text-muted-foreground select-none">
                {currentIndex >= 0 ? `${currentIndex + 1} / ${navList.length}` : navList.length}
              </span>
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2 gap-1 text-xs"
                disabled={!nextVoucher}
                onClick={() => nextVoucher && navigate(`/cash/payment-vouchers/${nextVoucher.id}`)}
                title={nextVoucher ? `${nextVoucher.code}` : ""}>
                {t(`${NS}.next`, "التالي")}
                <ChevronLeft className={cn("h-3.5 w-3.5", !isRtl && "rotate-180")} />
              </Button>
              <div className="relative">
                <Search className={cn("absolute top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground", isRtl ? "right-2" : "left-2")} />
                <Input
                  value={navSearch}
                  onChange={e => setNavSearch(e.target.value)}
                  onKeyDown={e => {
                    if (e.key !== "Enter") return;
                    if ((e.nativeEvent as any).isComposing) return;
                    e.preventDefault(); e.stopPropagation(); jumpFromSearch();
                  }}
                  placeholder={t(`${NS}.searchPh`, "ابحث برقم السند...")}
                  className={cn("h-7 text-xs w-48", isRtl ? "pe-7 ps-2" : "ps-7 pe-2")}
                />
              </div>
            </div>
          )}

          {!isNew && existing && (
            <Button variant="outline" size="sm" onClick={openPrintWindow} className="gap-1.5 print:hidden">
              <Printer className="h-4 w-4" /> {t(`${NS}.print`, "طباعة")}
            </Button>
          )}

          {!isNew && existing && (
            <span className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border",
              existing.status === "posted"
                ? "bg-green-50 text-green-700 border-green-200"
                : "bg-amber-50 text-amber-700 border-amber-200",
            )}>
              {existing.status === "posted" ? t("cashCommon.posted") : t("cashCommon.draft")}
            </span>
          )}
        </div>
      </div>

      {/* ─── Locked banner (for posted vouchers) ──────────────── */}
      {isLockedSourceEntry && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900" role="alert">
          <Lock className="h-5 w-5 mt-0.5 shrink-0 text-amber-700" />
          <div className="flex-1 text-sm leading-relaxed">
            <div className="font-semibold">{t(`${NS}.lockedTitle`, "السند مرحَّل — لا يمكن تعديله")}</div>
            <div className="mt-0.5 text-amber-800">{t(`${NS}.lockedHint`, "للتعديل، عُد إلى القائمة وقم بفك الترحيل أولاً.")}</div>
          </div>
        </div>
      )}

      {/* ─── Two-column body: form + live preview ─────────────── */}
      <fieldset disabled={isLockedSourceEntry} className="m-0 p-0 border-0 disabled:opacity-75">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-5 items-start">
          {/* ── Left column: SINGLE-TAB form ──────────────────── */}
          <div className="space-y-4">
            {/* Section: Header */}
            <Card className="border-2">
              <CardHeader className="py-3 px-4 border-b bg-muted/30">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <FileText className="h-4 w-4 text-amber-700" />
                  {t(`${NS}.section_header`, "بيانات السند")}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4 pb-4 space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">{t(`${NS}.code`)}</Label>
                    <Input value={docLabel} readOnly disabled className="h-9 font-mono text-sm bg-muted/30" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">
                      {t(`${NS}.date`)} <span className="text-destructive">*</span>
                    </Label>
                    <Input type="date" value={form.date} onChange={e => setForm(p => ({ ...p, date: e.target.value }))} className="h-9 text-sm" data-testid="pv-date" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">{t(`${NS}.exchangeRate`)}</Label>
                    <Input type="number" step="0.000001" value={form.exchangeRate} onChange={e => setForm(p => ({ ...p, exchangeRate: e.target.value }))} placeholder="1" dir="ltr" className="h-9 text-sm text-left font-mono" />
                  </div>
                </div>

                {/* Payment method as visual segmented buttons (cash | bank) */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t(`${NS}.paymentMethod`)} <span className="text-destructive">*</span></Label>
                  <div className="inline-flex rounded-lg border bg-muted/20 p-0.5">
                    <button type="button"
                      onClick={() => setForm(p => ({ ...p, paymentType: "cash", bankAccountId: "" }))}
                      data-testid="pv-paytype-cash"
                      className={cn(
                        "px-4 h-8 rounded-md text-xs font-medium flex items-center gap-1.5 transition",
                        form.paymentType === "cash"
                          ? "bg-amber-100 text-amber-800 shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}>
                      <Wallet className="h-3.5 w-3.5" /> {t(`${NS}.cash`)}
                    </button>
                    <button type="button"
                      onClick={() => setForm(p => ({ ...p, paymentType: "bank", cashBoxId: "" }))}
                      data-testid="pv-paytype-bank"
                      className={cn(
                        "px-4 h-8 rounded-md text-xs font-medium flex items-center gap-1.5 transition",
                        form.paymentType === "bank"
                          ? "bg-blue-100 text-blue-800 shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}>
                      <Building2 className="h-3.5 w-3.5" /> {t(`${NS}.bank`)}
                    </button>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {t(`${NS}.jeHintCash`, "هذا الجانب سيكون دائناً في القيد المحاسبي")}
                  </p>
                </div>

                {/* Cash box / bank account — searchable comboboxes */}
                {form.paymentType === "cash" ? (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">
                      {t(`${NS}.cashBox`)} <span className="text-destructive">*</span>
                    </Label>
                    <SearchCombobox
                      items={cashBoxItems}
                      value={form.cashBoxId}
                      onValueChange={v => setForm(p => ({ ...p, cashBoxId: v }))}
                      placeholder={t(`${NS}.selectCashBox`)}
                      searchPlaceholder={t(`${NS}.searchCashBox`, "ابحث عن خزنة...")}
                      emptyText={t(`${NS}.noResults`, "لا توجد نتائج")}
                    />
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">
                      {t(`${NS}.bankAccount`)} <span className="text-destructive">*</span>
                    </Label>
                    <SearchCombobox
                      items={bankAccountItems}
                      value={form.bankAccountId}
                      onValueChange={v => setForm(p => ({ ...p, bankAccountId: v }))}
                      placeholder={t(`${NS}.selectBank`)}
                      searchPlaceholder={t(`${NS}.searchBank`, "ابحث عن حساب...")}
                      emptyText={t(`${NS}.noResults`, "لا توجد نتائج")}
                    />
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Section: Supplier + Amount */}
            <Card className="border-2 border-red-100">
              <CardHeader className="py-3 px-4 border-b bg-red-50/40">
                <CardTitle className="text-sm font-semibold flex items-center gap-2 text-red-900">
                  <Truck className="h-4 w-4" />
                  {t(`${NS}.section_supplier`, "المورد والمبلغ")}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4 pb-4 space-y-4">
                {/* Supplier (only entity option) */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">
                    {t(`${NS}.supplier`)} <span className="text-destructive">*</span>
                  </Label>
                  <SearchCombobox
                    items={supplierItems}
                    value={form.entityId}
                    onValueChange={v => {
                      const found = (suppliers as any[]).find((x: any) => String(x.id) === v);
                      setForm(p => ({
                        ...p,
                        entityId: v,
                        entityName: (isRtl ? found?.nameAr : (found?.nameEn || found?.nameAr)) || "",
                        // Linking a different supplier invalidates the linked invoice.
                        purchaseInvoiceId: "",
                      }));
                    }}
                    placeholder={t(`${NS}.selectSupplier`, "— اختر المورد —")}
                    searchPlaceholder={t(`${NS}.searchEntity`, "ابحث بالاسم أو الكود...")}
                    emptyText={t(`${NS}.noResults`, "لا توجد نتائج")}
                  />
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {t(`${NS}.jeHintEntity`, "المورد سيكون مديناً في القيد المحاسبي")}
                  </p>
                </div>

                {/* Amount — large prominent input */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">
                    {t(`${NS}.amount`)} <span className="text-destructive">*</span>
                  </Label>
                  <div className="relative">
                    <Banknote className={cn("h-5 w-5 absolute top-1/2 -translate-y-1/2 text-red-600 pointer-events-none", isRtl ? "right-3" : "left-3")} />
                    <Input
                      type="number" step="0.01" placeholder="0.00"
                      value={form.amount}
                      onChange={e => setForm(p => ({ ...p, amount: e.target.value }))}
                      dir="ltr"
                      data-testid="pv-amount"
                      className={cn("h-12 text-xl font-mono font-bold text-left", isRtl ? "pr-11" : "pl-11")}
                    />
                  </div>
                </div>

                {/* Optional: link to a purchase invoice */}
                <div className="rounded-lg border border-dashed border-red-200 bg-red-50/30 p-3 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Link2 className="h-4 w-4 text-red-700" />
                      <Label htmlFor="pv-link-toggle" className="text-xs font-semibold text-red-900 cursor-pointer">
                        {t(`${NS}.linkInvoiceTitle`, "سداد مقابل فاتورة شراء (اختياري)")}
                      </Label>
                    </div>
                    <Switch
                      id="pv-link-toggle"
                      checked={linkInvoice}
                      onCheckedChange={(v) => {
                        setLinkInvoice(v);
                        if (!v) setForm(p => ({ ...p, purchaseInvoiceId: "" }));
                      }}
                      data-testid="pv-link-toggle"
                    />
                  </div>
                  {linkInvoice && (
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium">
                        {t(`${NS}.selectInvoiceToLink`, "اختر فاتورة الشراء")}
                      </Label>
                      <div className="flex gap-2 items-stretch">
                        <div className="flex-1">
                          <SearchCombobox
                            items={invoiceItems}
                            value={form.purchaseInvoiceId}
                            onValueChange={v => setForm(p => ({ ...p, purchaseInvoiceId: v }))}
                            placeholder={form.entityId
                              ? t(`${NS}.selectInvoicePh`, "— اختر فاتورة —")
                              : t(`${NS}.pickSupplierFirst`, "اختر المورد أولاً")}
                            searchPlaceholder={t(`${NS}.searchInvoice`, "ابحث برقم الفاتورة...")}
                            emptyText={form.entityId
                              ? t(`${NS}.noOpenInvoices`, "لا توجد فواتير لهذا المورد")
                              : t(`${NS}.pickSupplierFirst`, "اختر المورد أولاً")}
                          />
                        </div>
                        {form.purchaseInvoiceId && (
                          <Button
                            type="button" variant="ghost" size="icon"
                            className="h-9 w-9 text-muted-foreground hover:text-destructive"
                            onClick={() => setForm(p => ({ ...p, purchaseInvoiceId: "" }))}
                            title={t(`${NS}.clearLink`, "إلغاء الربط")}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-1">
                        {t(`${NS}.linkHint`, "عند الربط ستظهر فاتورة الشراء «مسددة» في قائمة فواتير المشتريات بنوع السداد المحدد.")}
                      </p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Section: References & Notes */}
            <Card className="border-2 border-slate-100">
              <CardHeader className="py-3 px-4 border-b bg-slate-50/40">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <FileText className="h-4 w-4 text-slate-700" />
                  {t(`${NS}.section_refs`, "المراجع والبيان")}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4 pb-4 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">{t(`${NS}.refType`)}</Label>
                    <Input value={form.refType} onChange={e => setForm(p => ({ ...p, refType: e.target.value }))} placeholder={t(`${NS}.refTypePh`)} className="h-9 text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">{t(`${NS}.refNumber`)}</Label>
                    <Input value={form.refNumber} onChange={e => setForm(p => ({ ...p, refNumber: e.target.value }))} placeholder="INV-0001" dir="ltr" className="h-9 text-sm text-left font-mono" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t(`${NS}.description`)}</Label>
                  <Input value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} placeholder={t(`${NS}.descriptionPh`)} className="h-9 text-sm" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t("cashCommon.notes")}</Label>
                  <Textarea value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} placeholder={t("cashCommon.notesPlaceholder")} className="text-sm resize-none" rows={2} />
                </div>
              </CardContent>
            </Card>
          </div>

          {/* ── Right column: live JE preview (sticky on desktop) ── */}
          <aside className="lg:sticky lg:top-4 space-y-4">
            <Card className="border-2 border-blue-200 bg-blue-50/40">
              <CardHeader className="py-3 px-4 border-b border-blue-200/60">
                <CardTitle className="text-sm font-semibold flex items-center gap-2 text-blue-900">
                  <FileText className="h-4 w-4" />
                  {t(`${NS}.jePreview`)}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-3 pb-3">
                {!preview ? (
                  <p className="text-xs text-muted-foreground text-center py-6">
                    {t(`${NS}.previewEmpty`, "أدخل المبلغ لمعاينة القيد")}
                  </p>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-blue-800/70 border-b border-blue-200/60">
                        <th className="text-start pb-1.5 font-medium">{t(`${NS}.jeCol`)}</th>
                        <th className={cn("pb-1.5 font-medium", isRtl ? "text-left" : "text-right")}>{t(`${NS}.jeDr`)}</th>
                        <th className={cn("pb-1.5 font-medium", isRtl ? "text-left" : "text-right")}>{t(`${NS}.jeCr`)}</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      <tr className="border-b border-blue-200/40">
                        <td className="py-1.5 text-start text-[11px]">{preview.drLabel}</td>
                        <td className={cn("text-red-700 font-semibold", isRtl ? "text-left" : "text-right")}>{fmt(preview.amount)}</td>
                        <td className={cn("text-muted-foreground", isRtl ? "text-left" : "text-right")}>—</td>
                      </tr>
                      <tr>
                        <td className="py-1.5 text-start text-[11px]">{preview.crLabel}</td>
                        <td className={cn("text-muted-foreground", isRtl ? "text-left" : "text-right")}>—</td>
                        <td className={cn("text-green-700 font-semibold", isRtl ? "text-left" : "text-right")}>{fmt(preview.amount)}</td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>

            <div className="text-[11px] text-blue-900/80 leading-relaxed bg-blue-50/40 border border-blue-200 rounded-lg p-3">
              <div className="flex items-start gap-2">
                <Settings2 className="h-4 w-4 mt-0.5 text-blue-700 shrink-0" />
                <div className="space-y-1.5">
                  <p className="font-semibold">{t(`${NS}.mappingsHintTitle`, "روابط الحسابات العامة")}</p>
                  <p>
                    {t(`${NS}.mappingsHintBody`, "حسابات الخزينة/البنك/المورد الافتراضية تُدار الآن من شاشة «ربط القيود المحاسبية» في لوحة التحكم — قسم «تسوية الموردين (سندات الصرف)».")}
                  </p>
                  <button
                    type="button"
                    className="text-[11px] text-blue-700 hover:text-blue-900 underline underline-offset-2"
                    onClick={() => navigate("/settings/accounting-mappings")}
                  >
                    {t(`${NS}.openMappings`, "فتح شاشة ربط القيود المحاسبية")}
                  </button>
                </div>
              </div>
            </div>

            <div className="text-[11px] text-muted-foreground leading-relaxed bg-muted/20 border rounded-lg p-3">
              <p className="font-semibold mb-1">{t(`${NS}.tipsTitle`, "اختصارات سريعة")}</p>
              <ul className="space-y-0.5 list-disc list-inside">
                <li>{t(`${NS}.tip_enter`, "Enter للانتقال للحقل التالي")}</li>
                <li>{t(`${NS}.tip_search`, "اكتب في القوائم للبحث الفوري")}</li>
                <li>{t(`${NS}.tip_link`, "فعّل الربط لربط السند بفاتورة شراء")}</li>
              </ul>
            </div>
          </aside>
        </div>
      </fieldset>

      {/* ─── Sticky bottom action bar ──────────────────────────── */}
      {!isLockedSourceEntry && (
        <div className="fixed bottom-0 inset-x-0 bg-background/95 backdrop-blur border-t z-40 print:hidden">
          <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between gap-3">
            <Button variant="ghost" onClick={() => navigate("/cash/payment-vouchers")} disabled={saveMut.isPending}>
              {t("cashCommon.cancel")}
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => save("draft")} disabled={saveMut.isPending} className="gap-1.5" data-testid="pv-save-draft">
                {pendingMode === "draft" && saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {t(`${NS}.saveDraft`, "حفظ كمسودة")}
              </Button>
              {autoPostingEnabled && (
                <Button onClick={() => save("post")} disabled={saveMut.isPending} className="gap-1.5 bg-red-600 hover:bg-red-700" data-testid="pv-save-post">
                  {pendingMode === "post" && saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  {t(`${NS}.saveAndPost`, "حفظ وترحيل")}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
