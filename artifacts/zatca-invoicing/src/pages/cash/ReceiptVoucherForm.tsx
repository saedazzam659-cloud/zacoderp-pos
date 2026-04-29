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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { AccountCombobox } from "@/components/AccountCombobox";
import { SearchCombobox, type ComboboxItem } from "@/components/ui/search-combobox";
import {
  ArrowDownCircle, ArrowRight, ChevronRight, ChevronLeft, Search,
  Sparkles, Loader2, Save, Send, Lock, FileText, Banknote,
  Wallet, Building2, User2, Printer,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const today = () => new Date().toISOString().slice(0, 10);

interface FormState {
  date: string;
  paymentType: "cash" | "bank";
  cashBoxId: string;
  bankAccountId: string;
  entityType: "customer" | "supplier" | "other";
  entityId: string;
  entityName: string;
  accountId: string;
  amount: string;
  exchangeRate: string;
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
  entityType: "customer",
  entityId: "",
  entityName: "",
  accountId: "",
  amount: "",
  exchangeRate: "1",
  refType: "",
  refNumber: "",
  description: "",
  notes: "",
};

export default function ReceiptVoucherForm() {
  const { user, token } = useAuth();
  const { t } = useTranslation();
  const { fmt, isRtl } = useFormatters();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();

  const [matchNew] = useRoute("/cash/receipt-vouchers/new");
  const [matchEdit, params] = useRoute("/cash/receipt-vouchers/:id");
  const isNew  = !!matchNew;
  const editId = matchEdit && !isNew ? Number((params as any).id) : null;

  const NS = "receiptVouchers";
  const cid = user?.companyId;
  const h = { Authorization: `Bearer ${token}` };

  const [form, setForm] = useState<FormState>(EMPTY);
  const [aiBusy, setAiBusy]     = useState(false);
  const [aiReason, setAiReason] = useState("");

  // ── Sequence preview for new vouchers ───────────────────────────
  const seqPeek = useNextSequenceNumber("receipt_voucher", isNew);

  // ── Data fetches (cash boxes, banks, customers, suppliers) ───────
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
  const { data: customers = [] } = useQuery<any[]>({
    queryKey: ["customers", cid],
    queryFn: () => fetch(`${API}/api/customers?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
  });
  const { data: suppliers = [] } = useQuery<any[]>({
    queryKey: ["suppliers", cid],
    queryFn: () => fetch(`${API}/api/suppliers?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
  });

  // ── Voucher list (used both for prev/next nav and for edit-mode load) ─
  const { data: vouchers = [] } = useQuery<any[]>({
    queryKey: ["receipt-vouchers", cid],
    queryFn: () => fetch(`${API}/api/receipt-vouchers?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
    staleTime: 30_000,
  });

  // ── Edit-mode: load the single voucher ─────────────────────────
  const { data: existing, isLoading: loadingEdit } = useQuery<any>({
    queryKey: ["receipt-voucher", editId],
    queryFn: () => fetch(`${API}/api/receipt-vouchers/${editId}`, { headers: h }).then(r => r.json()),
    enabled: !!editId,
  });

  useEffect(() => {
    if (!existing) return;
    setForm({
      date: existing.date ?? today(),
      paymentType: (existing.paymentType ?? "cash") as "cash" | "bank",
      cashBoxId: existing.cashBoxId ? String(existing.cashBoxId) : "",
      bankAccountId: existing.bankAccountId ? String(existing.bankAccountId) : "",
      entityType: (existing.entityType ?? "customer") as "customer" | "supplier" | "other",
      entityId: existing.entityId ? String(existing.entityId) : "",
      entityName: existing.entityName ?? "",
      accountId: existing.accountId ? String(existing.accountId) : "",
      amount: existing.amount ?? "",
      exchangeRate: existing.exchangeRate ?? "1",
      refType: existing.refType ?? "",
      refNumber: existing.refNumber ?? "",
      description: existing.description ?? "",
      notes: existing.notes ?? "",
    });
  }, [existing]);

  // ── Auto-pre-fill the counter account from last-used (per company) ──
  const ACCT_KEY = `rv:lastAccountId:${cid}`;
  useEffect(() => {
    if (!isNew || form.accountId) return;
    try {
      const last = localStorage.getItem(ACCT_KEY) || "";
      if (last) setForm(p => ({ ...p, accountId: last }));
    } catch {}
  }, [isNew]); // eslint-disable-line react-hooks/exhaustive-deps

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
    navigate(`/cash/receipt-vouchers/${hit.id}`);
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

  const entityList = form.entityType === "customer"
    ? customers
    : form.entityType === "supplier" ? suppliers : [];

  const entityItems: ComboboxItem[] = useMemo(() =>
    (entityList as any[]).map(e => ({
      value: String(e.id),
      label: isRtl ? e.nameAr : (e.nameEn || e.nameAr),
      code: e.code ?? undefined,
      description: e.phone ?? e.email ?? undefined,
    })), [entityList, isRtl]);

  // ── Live Journal-Entry preview (mirrors backend posting logic) ──
  function jePreview() {
    const amt = Number(form.amount || 0);
    if (!isFinite(amt) || amt <= 0) return null;
    const cb = (cashBoxes as any[]).find((c: any) => String(c.id) === form.cashBoxId);
    const ba = (bankAccounts as any[]).find((b: any) => String(b.id) === form.bankAccountId);
    const cbName = cb ? (isRtl ? cb.nameAr : (cb.nameEn || cb.nameAr)) : "";
    const baName = ba ? (isRtl ? ba.nameAr : (ba.nameEn || ba.nameAr)) : "";
    const drLabel = form.paymentType === "bank"
      ? (ba ? t(`${NS}.bankPrefix`, { name: baName }) : t(`${NS}.noBankSelected`))
      : (cb ? t(`${NS}.cashPrefix`, { name: cbName }) : t(`${NS}.noCashSelected`));
    const crLabel = form.accountId ? t(`${NS}.pickedAccount`) :
      (form.entityType === "customer" && form.entityName) ? t(`${NS}.customerPrefix`, { name: form.entityName }) :
      (form.entityType === "supplier" && form.entityName) ? t(`${NS}.supplierPrefix`, { name: form.entityName }) :
      t(`${NS}.noCounter`);
    return { drLabel, crLabel, amount: amt };
  }

  // ── AI: suggest counter account ────────────────────────────────
  async function suggestAccount() {
    setAiBusy(true);
    setAiReason("");
    try {
      const res = await fetch(`${API}/api/ai/suggest-receipt-account?companyId=${cid}`, {
        method: "POST",
        headers: { ...h, "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: form.entityType,
          entityId: form.entityId ? parseInt(form.entityId) : null,
          entityName: form.entityName,
          description: form.description,
          refType: form.refType,
          refNumber: form.refNumber,
          notes: form.notes,
          amount: Number(form.amount || 0),
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || t(`${NS}.aiFailed`));
      if (j.accountId) {
        setForm(p => ({ ...p, accountId: String(j.accountId) }));
        setAiReason(j.reasoning || "");
        toast({ title: t(`${NS}.aiSuggested`), description: j.accountLabel });
      } else {
        toast({ title: t(`${NS}.aiNotFound`), description: j.reasoning, variant: "destructive" });
      }
    } catch (e: any) {
      toast({ title: t(`${NS}.aiFailed`), description: parseError(e), variant: "destructive" });
    } finally {
      setAiBusy(false);
    }
  }

  // ── Save / Save-and-post mutation ──────────────────────────────
  // `mode` decides whether we just save (draft) or save and immediately
  // post. The backend always returns the voucher in its CURRENT state
  // (draft after POST/PUT), so we chain /post when the user explicitly
  // asked for it.
  const [pendingMode, setPendingMode] = useState<"draft" | "post" | null>(null);
  const [tab, setTab] = useState<"voucher" | "entity">("voucher");
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

      const body = {
        ...form,
        amount: amtNum.toFixed(2),
        companyId: cid,
        accountId:    form.accountId    ? parseInt(form.accountId)    : null,
        cashBoxId:    form.cashBoxId    ? parseInt(form.cashBoxId)    : null,
        bankAccountId:form.bankAccountId? parseInt(form.bankAccountId): null,
        entityId:     form.entityId     ? parseInt(form.entityId)     : null,
      };

      const url = isNew
        ? `${API}/api/receipt-vouchers`
        : `${API}/api/receipt-vouchers/${editId}`;
      const res = await fetch(url, {
        method: isNew ? "POST" : "PUT",
        headers: { ...h, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      const saved = await res.json();

      if (mode === "post" && saved?.id && (saved.status ?? "draft") === "draft") {
        const pr = await fetch(`${API}/api/receipt-vouchers/${saved.id}/post`, { method: "POST", headers: h });
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
      try { if (form.accountId) localStorage.setItem(ACCT_KEY, form.accountId); } catch {}
      qc.invalidateQueries({ queryKey: ["receipt-vouchers"] });
      qc.invalidateQueries({ queryKey: ["receipt-voucher", data.id] });
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
      navigate("/cash/receipt-vouchers");
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
    // Auto-switch to whichever tab contains a missing required field
    // so the user actually sees the highlighted control.
    if (
      !form.date ||
      (form.paymentType === "cash" && !form.cashBoxId) ||
      (form.paymentType === "bank" && !form.bankAccountId)
    ) {
      setTab("voucher");
    } else {
      const cleanAmt = String(form.amount).replace(/[^\d.\-]/g, "");
      const amtNum = Number(cleanAmt);
      if (!isFinite(amtNum) || amtNum <= 0) setTab("entity");
    }
    setPendingMode(mode);
    saveMut.mutate(mode);
  }

  // ── Form-wide Enter-key navigation ─────────────────────────────
  // Same pattern as JournalEntryForm: Enter advances focus to the next
  // editable control; Enter on the last control saves as draft (we do
  // NOT auto-post on Enter — posting is an explicit user action).
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

  // ── Print (single voucher) — opens a printer-friendly window ──
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
    const html = `<!doctype html><html dir="rtl"><head><meta charset="utf-8"/><title>سند قبض ${escapeHtml(existing.code)}</title>
<style>
body { font-family: "Segoe UI","Tahoma","Arial",system-ui,sans-serif; color:#111; margin:24px; }
h1 { color:#1e3a8a; border-bottom: 2px solid #1e3a8a; padding-bottom:8px; margin:0 0 16px; font-size:22px; }
.grid { display:grid; grid-template-columns: 1fr 1fr; gap:8px 16px; font-size:13px; padding:12px; border:1px solid #e5e7eb; border-radius:8px; background:#fafbfd; margin-bottom:16px; }
.lbl { color:#6b7280; font-size:11px; }
.val { font-weight:600; }
.amount-box { padding:14px; border:2px solid #1e3a8a; border-radius:8px; background:#eef2ff; text-align:center; margin:12px 0; }
.amount-box .lbl { font-size:12px; color:#1e3a8a; }
.amount-box .num { font-size:28px; font-weight:800; color:#1e3a8a; font-family:"Consolas",monospace; }
.desc { padding:10px; border:1px dashed #cbd5e1; border-radius:6px; font-size:13px; }
.print-btn { position:fixed; top:10px; left:10px; padding:8px 14px; background:#1e3a8a; color:#fff; border:none; border-radius:6px; cursor:pointer; }
@media print { .print-btn { display:none; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">طباعة</button>
<h1>سند قبض — ${escapeHtml(existing.code)}</h1>
<div class="grid">
  <div><div class="lbl">التاريخ</div><div class="val">${escapeHtml(existing.date)}</div></div>
  <div><div class="lbl">الحالة</div><div class="val">${existing.status === "posted" ? "مرحَّل" : "مسودة"}</div></div>
  <div><div class="lbl">وسيلة الدفع</div><div class="val">${existing.paymentType === "bank" ? "بنك" : "نقداً"}</div></div>
  <div><div class="lbl">${existing.paymentType === "bank" ? "الحساب البنكي" : "الخزنة"}</div><div class="val">${escapeHtml(treasuryName)}</div></div>
  <div><div class="lbl">الجهة</div><div class="val">${escapeHtml(existing.entityName ?? "—")}</div></div>
  <div><div class="lbl">المرجع</div><div class="val">${escapeHtml(existing.refType ?? "")} ${escapeHtml(existing.refNumber ?? "")}</div></div>
</div>
<div class="amount-box">
  <div class="lbl">المبلغ المستلم</div>
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
    >
      {/* ─── Header bar ────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/cash/receipt-vouchers")} className="h-8 w-8" title={t(`${NS}.backToList`, "عودة للقائمة")}>
            <ArrowRight className={cn("h-4 w-4", !isRtl && "rotate-180")} />
          </Button>
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-green-100 text-green-700">
              <ArrowDownCircle className="h-5 w-5" />
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
          {/* prev/next/search — only on edit views */}
          {!isNew && navList.length > 0 && (
            <div className="flex items-center gap-1 rounded-md border bg-background px-1 py-0.5 print:hidden">
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2 gap-1 text-xs"
                disabled={!prevVoucher}
                onClick={() => prevVoucher && navigate(`/cash/receipt-vouchers/${prevVoucher.id}`)}
                title={prevVoucher ? `${prevVoucher.code}` : ""}>
                <ChevronRight className={cn("h-3.5 w-3.5", !isRtl && "rotate-180")} />
                {t(`${NS}.prev`, "السابق")}
              </Button>
              <span className="text-[11px] tabular-nums px-1.5 text-muted-foreground select-none">
                {currentIndex >= 0 ? `${currentIndex + 1} / ${navList.length}` : navList.length}
              </span>
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2 gap-1 text-xs"
                disabled={!nextVoucher}
                onClick={() => nextVoucher && navigate(`/cash/receipt-vouchers/${nextVoucher.id}`)}
                title={nextVoucher ? `${nextVoucher.code}` : ""}>
                {t(`${NS}.next`, "التالي")}
                <ChevronLeft className={cn("h-3.5 w-3.5", !isRtl && "rotate-180")} />
              </Button>
              <div className="relative">
                <Search className={cn("h-3.5 w-3.5 absolute top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none", isRtl ? "right-2" : "left-2")} />
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

          {/* Status badge */}
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
          {/* ── Left column: form (two-tab layout) ────────────── */}
          <div>
            <Tabs value={tab} onValueChange={(v) => setTab(v as "voucher" | "entity")} className="w-full">
              <TabsList className="grid grid-cols-2 w-full h-11">
                <TabsTrigger value="voucher" className="gap-2 data-[state=active]:bg-amber-50 data-[state=active]:text-amber-900 data-[state=active]:shadow-sm">
                  <FileText className="h-4 w-4" />
                  <span className="font-semibold">{t(`${NS}.section_voucher`, "بيانات السند")}</span>
                </TabsTrigger>
                <TabsTrigger value="entity" className="gap-2 data-[state=active]:bg-blue-50 data-[state=active]:text-blue-900 data-[state=active]:shadow-sm">
                  <User2 className="h-4 w-4" />
                  <span className="font-semibold">{t(`${NS}.section_entity`, "الجهة والمبلغ")}</span>
                </TabsTrigger>
              </TabsList>

              {/* Tab 1: voucher header */}
              <TabsContent value="voucher" className="mt-4 space-y-3">
                <Card className="border-2">
                  <CardContent className="pt-5 pb-5 space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">{t(`${NS}.code`)}</Label>
                    <Input value={docLabel} readOnly disabled className="h-9 font-mono text-sm bg-muted/30" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">
                      {t(`${NS}.date`)} <span className="text-destructive">*</span>
                    </Label>
                    <Input type="date" value={form.date} onChange={e => setForm(p => ({ ...p, date: e.target.value }))} className="h-9 text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">{t(`${NS}.exchangeRate`)}</Label>
                    <Input type="number" step="0.000001" value={form.exchangeRate} onChange={e => setForm(p => ({ ...p, exchangeRate: e.target.value }))} placeholder="1" dir="ltr" className="h-9 text-sm text-left font-mono" />
                  </div>
                </div>

                {/* Payment method as visual segmented buttons (cash | bank) */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t(`${NS}.paymentMethod`)}</Label>
                  <div className="inline-flex rounded-lg border bg-muted/20 p-0.5">
                    <button type="button"
                      onClick={() => setForm(p => ({ ...p, paymentType: "cash", bankAccountId: "" }))}
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
                      className={cn(
                        "px-4 h-8 rounded-md text-xs font-medium flex items-center gap-1.5 transition",
                        form.paymentType === "bank"
                          ? "bg-blue-100 text-blue-800 shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}>
                      <Building2 className="h-3.5 w-3.5" /> {t(`${NS}.bank`)}
                    </button>
                  </div>
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
                <div className="flex justify-end pt-1">
                  <Button type="button" onClick={() => setTab("entity")} className="gap-1.5 bg-blue-600 hover:bg-blue-700">
                    {t(`${NS}.nextStep`, "التالي: الجهة والمبلغ")}
                    {isRtl ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </Button>
                </div>
              </TabsContent>

              {/* Tab 2: entity, amount, counter account */}
              <TabsContent value="entity" className="mt-4 space-y-3">
                <Card className="border-2">
                  <CardContent className="pt-5 pb-5 space-y-4">
                {/* Entity type as segmented buttons */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t(`${NS}.entityType`)}</Label>
                  <div className="inline-flex rounded-lg border bg-muted/20 p-0.5">
                    {(["customer", "supplier", "other"] as const).map(et => (
                      <button key={et} type="button"
                        onClick={() => setForm(p => ({ ...p, entityType: et, entityId: "", entityName: "" }))}
                        className={cn(
                          "px-4 h-8 rounded-md text-xs font-medium transition",
                          form.entityType === et
                            ? "bg-background text-foreground shadow-sm border"
                            : "text-muted-foreground hover:text-foreground",
                        )}>
                        {t(`${NS}.${et}`)}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Entity selector — searchable for customer/supplier; free text for other */}
                {form.entityType === "other" ? (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">{t(`${NS}.entityName`)}</Label>
                    <Input value={form.entityName} onChange={e => setForm(p => ({ ...p, entityName: e.target.value }))} placeholder={t(`${NS}.entityName`)} className="h-9 text-sm" />
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">
                      {form.entityType === "customer" ? t(`${NS}.customer`) : t(`${NS}.supplier`)}
                    </Label>
                    <SearchCombobox
                      items={entityItems}
                      value={form.entityId}
                      onValueChange={v => {
                        const found = (entityList as any[]).find((x: any) => String(x.id) === v);
                        setForm(p => ({
                          ...p,
                          entityId: v,
                          entityName: (isRtl ? found?.nameAr : (found?.nameEn || found?.nameAr)) || "",
                        }));
                      }}
                      placeholder={t(`${NS}.selectEntity`)}
                      searchPlaceholder={t(`${NS}.searchEntity`, "ابحث بالاسم أو الكود...")}
                      emptyText={t(`${NS}.noResults`, "لا توجد نتائج")}
                    />
                  </div>
                )}

                {/* Counter account + AI suggest */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t(`${NS}.counterAccount`)}</Label>
                  <div className="flex gap-2 items-stretch">
                    <div className="flex-1">
                      <AccountCombobox value={form.accountId} onValueChange={v => setForm(p => ({ ...p, accountId: v }))} placeholder={t("cashCommon.selectAccount")} grouped={false} />
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={suggestAccount} disabled={aiBusy} className="gap-1.5 shrink-0 text-purple-700 border-purple-300 hover:bg-purple-50">
                      {aiBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                      {t(`${NS}.aiSuggest`)}
                    </Button>
                  </div>
                  {aiReason && (
                    <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed bg-purple-50/50 border border-purple-100 rounded p-2">{aiReason}</p>
                  )}
                </div>

                {/* Amount — large prominent input */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">
                    {t(`${NS}.amount`)} <span className="text-destructive">*</span>
                  </Label>
                  <div className="relative">
                    <Banknote className={cn("h-5 w-5 absolute top-1/2 -translate-y-1/2 text-green-600 pointer-events-none", isRtl ? "right-3" : "left-3")} />
                    <Input
                      type="number" step="0.01" placeholder="0.00"
                      value={form.amount}
                      onChange={e => setForm(p => ({ ...p, amount: e.target.value }))}
                      dir="ltr"
                      className={cn("h-12 text-xl font-mono font-bold text-left", isRtl ? "pr-11" : "pl-11")}
                    />
                  </div>
                </div>

                {/* Reference fields (collapsible-feeling: small grid) */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">{t(`${NS}.refType`)}</Label>
                    <Input value={form.refType} onChange={e => setForm(p => ({ ...p, refType: e.target.value }))} placeholder={t(`${NS}.refTypePh`)} className="h-9 text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">{t(`${NS}.refNumber`)}</Label>
                    <Input value={form.refNumber} onChange={e => setForm(p => ({ ...p, refNumber: e.target.value }))} placeholder="INV-0001" dir="ltr" className="h-9 text-sm text-left font-mono" />
                  </div>
                </div>

                {/* Description + notes */}
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
                <div className="flex justify-start pt-1">
                  <Button type="button" variant="ghost" onClick={() => setTab("voucher")} className="gap-1.5">
                    {isRtl ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
                    {t(`${NS}.prevStep`, "السابق: بيانات السند")}
                  </Button>
                </div>
              </TabsContent>
            </Tabs>
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
                        <td className={cn("text-green-700 font-semibold", isRtl ? "text-left" : "text-right")}>{fmt(preview.amount)}</td>
                        <td className={cn("text-muted-foreground", isRtl ? "text-left" : "text-right")}>—</td>
                      </tr>
                      <tr>
                        <td className="py-1.5 text-start text-[11px]">{preview.crLabel}</td>
                        <td className={cn("text-muted-foreground", isRtl ? "text-left" : "text-right")}>—</td>
                        <td className={cn("text-red-700 font-semibold", isRtl ? "text-left" : "text-right")}>{fmt(preview.amount)}</td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>

            <div className="text-[11px] text-muted-foreground leading-relaxed bg-muted/20 border rounded-lg p-3">
              <p className="font-semibold mb-1">{t(`${NS}.tipsTitle`, "اختصارات سريعة")}</p>
              <ul className="space-y-0.5 list-disc list-inside">
                <li>{t(`${NS}.tip_enter`, "Enter للانتقال للحقل التالي")}</li>
                <li>{t(`${NS}.tip_search`, "اكتب في القوائم للبحث الفوري")}</li>
                <li>{t(`${NS}.tip_ai`, "زر AI يقترح الحساب المقابل")}</li>
              </ul>
            </div>
          </aside>
        </div>
      </fieldset>

      {/* ─── Sticky bottom action bar ──────────────────────────── */}
      {!isLockedSourceEntry && (
        <div className="fixed bottom-0 inset-x-0 bg-background/95 backdrop-blur border-t z-40 print:hidden">
          <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between gap-3">
            <Button variant="ghost" onClick={() => navigate("/cash/receipt-vouchers")} disabled={saveMut.isPending}>
              {t("cashCommon.cancel")}
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => save("draft")} disabled={saveMut.isPending} className="gap-1.5">
                {pendingMode === "draft" && saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {t(`${NS}.saveDraft`, "حفظ كمسودة")}
              </Button>
              {autoPostingEnabled && (
                <Button onClick={() => save("post")} disabled={saveMut.isPending} className="gap-1.5 bg-green-600 hover:bg-green-700">
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
