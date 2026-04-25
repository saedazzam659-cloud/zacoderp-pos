// Offer create/edit screen — ERP-grade.
//
// Big idea — a tabbed form (إلهام Odoo / Zoho Inventory / SAP B1) that keeps
// related fields together so the form never feels overwhelming on first
// glance:
//
//   1. "الأساسي"            — name, priority, status, validity range, channel.
//   2. "نوع الخصم"          — radio for the discount mechanic + conditional
//                             fields (percentage / fixed / Buy-X-Get-Y).
//   3. "الاستخدام والكوبون" — coupon code, min purchase, usage limits,
//                             stackable flag, notes.
//   4. "النطاقات"           — the three scope cards (customers / items /
//                             sales-reps) — unchanged from the previous
//                             version of this screen.
//
// Editing rules: if the offer is `active` the API blocks the PUT, so we
// fetch and route the user back with a toast.  Drafts are fully editable.

import { useEffect, useMemo, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Tag, Save, ArrowRight, Search, Users, Package, UserCheck, Trash2, Plus,
  Calendar, Percent, Ticket, Settings2, FileText, Hash, Layers,
} from "lucide-react";
import { offersApi, type OfferPayload, type OfferDiscountType, type OfferApplyTo } from "@/lib/offersApi";
import { parseError } from "@/lib/parseError";

type Scope = "all" | "specific";

interface CustomerLite { id: number; nameAr?: string; nameEn?: string; code?: string }
interface ItemLite     { id: number; nameAr?: string; nameEn?: string; code?: string; salePrice?: string }
interface SalesRepLite { id: number; nameAr?: string; nameEn?: string; code?: string }

interface SelectedItem { itemId: number; price: string; discount: string; qty: string }

const API = import.meta.env.VITE_API_URL ?? "";
function authHeaders(): Record<string, string> {
  const t = localStorage.getItem("zatca_token");
  return t ? { Authorization: `Bearer ${t}` } : {};
}
async function fetchJson<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { headers: authHeaders() });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export default function OfferForm() {
  const { t } = useTranslation();
  const [, navigate] = useLocation();
  const params = useParams() as { id?: string };
  const editingId = params.id ? Number(params.id) : null;
  const { user } = useAuth();
  const cid = user?.companyId ?? undefined;
  const { toast } = useToast();
  const qc = useQueryClient();

  // ── basic state ──────────────────────────────────────────────────────────
  const [nameAr, setNameAr] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState(5);
  const [startDate, setStartDate] = useState<string>("");
  const [expiryDate, setExpiryDate] = useState<string>("");
  const [status, setStatus] = useState<"draft" | "active">("draft");
  const [applyTo, setApplyTo] = useState<OfferApplyTo>("all");
  const [stackable, setStackable] = useState(false);

  // ── discount mechanics ───────────────────────────────────────────────────
  const [discountType, setDiscountType] = useState<OfferDiscountType>("line_pricing");
  const [discountValue, setDiscountValue] = useState<string>("");
  const [buyQty, setBuyQty] = useState<string>("");
  const [getQty, setGetQty] = useState<string>("");
  const [getDiscountPercent, setGetDiscountPercent] = useState<string>("100");

  // ── usage / coupon ───────────────────────────────────────────────────────
  const [couponCode, setCouponCode] = useState<string>("");
  const [minPurchaseAmount, setMinPurchaseAmount] = useState<string>("");
  const [maxUses, setMaxUses] = useState<string>("");
  const [maxUsesPerCustomer, setMaxUsesPerCustomer] = useState<string>("");
  const [timesUsed, setTimesUsed] = useState<number>(0);
  const [notes, setNotes] = useState<string>("");

  // ── scopes ───────────────────────────────────────────────────────────────
  const [customerScope, setCustomerScope] = useState<Scope>("all");
  const [itemsScope,    setItemsScope]    = useState<Scope>("all");
  const [salesRepScope, setSalesRepScope] = useState<Scope>("all");

  const [pickedCustomers,  setPickedCustomers]  = useState<Set<number>>(new Set());
  const [pickedSalesReps,  setPickedSalesReps]  = useState<Set<number>>(new Set());
  const [pickedItems,      setPickedItems]      = useState<SelectedItem[]>([]);

  // ── reference data ───────────────────────────────────────────────────────
  const customersQ = useQuery<CustomerLite[]>({
    queryKey: ["customers-lite", cid],
    queryFn:  () => fetchJson(`/api/customers${cid ? `?companyId=${cid}` : ""}`),
    enabled:  !!cid,
  });
  const itemsQ = useQuery<ItemLite[]>({
    queryKey: ["items-lite", cid],
    queryFn:  () => fetchJson(`/api/inventory/items${cid ? `?companyId=${cid}` : ""}`),
    enabled:  !!cid,
  });
  const salesRepsQ = useQuery<SalesRepLite[]>({
    queryKey: ["salesreps-lite", cid],
    queryFn:  () => fetchJson(`/api/sales-reps${cid ? `?companyId=${cid}` : ""}`),
    enabled:  !!cid,
  });

  // ── existing offer (edit mode) ───────────────────────────────────────────
  const offerQ = useQuery({
    queryKey: ["offer", editingId, cid],
    queryFn:  () => offersApi.get(editingId!, cid),
    enabled:  !!editingId && !!cid,
  });

  // Hydrate the form from the loaded offer exactly once.
  useEffect(() => {
    const o = offerQ.data;
    if (!o) return;
    if (o.status === "active") {
      toast({ title: t("offers.lockedTitle", "العرض مفعّل"), description: t("offers.lockedDesc", "أوقفه أولاً ثم عدّله"), variant: "destructive" });
      navigate("/inventory/offers");
      return;
    }
    setNameAr(o.nameAr ?? "");
    setDescription(o.description ?? "");
    setPriority(o.priority);
    setStartDate(o.startDate ?? "");
    setExpiryDate(o.expiryDate ?? "");
    // The early-return above already kicks the user out for active offers,
    // so by this point status is always draft or expired.  We coerce expired
    // to draft so the user can re-publish after editing.
    setStatus("draft");
    setApplyTo(o.applyTo);
    setStackable(o.stackable);

    setDiscountType(o.discountType);
    setDiscountValue(o.discountValue ?? "");
    setBuyQty(o.buyQty != null ? String(o.buyQty) : "");
    setGetQty(o.getQty != null ? String(o.getQty) : "");
    setGetDiscountPercent(o.getDiscountPercent ?? "100");

    setCouponCode(o.couponCode ?? "");
    setMinPurchaseAmount(o.minPurchaseAmount && o.minPurchaseAmount !== "0" ? o.minPurchaseAmount : "");
    setMaxUses(o.maxUses != null ? String(o.maxUses) : "");
    setMaxUsesPerCustomer(o.maxUsesPerCustomer != null ? String(o.maxUsesPerCustomer) : "");
    setTimesUsed(o.timesUsed ?? 0);
    setNotes(o.notes ?? "");

    setCustomerScope(o.customerScope);
    setItemsScope(o.itemsScope);
    setSalesRepScope(o.salesRepScope);
    setPickedCustomers(new Set(o.customers.map(c => c.customerId)));
    setPickedSalesReps(new Set(o.salesReps.map(r => r.salesRepId)));
    setPickedItems(o.items.map(i => ({
      itemId: i.itemId,
      price:    i.price    ?? "",
      discount: i.discount ?? "",
      qty:      i.qty      ?? "",
    })));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offerQ.data]);

  // ── mutations ────────────────────────────────────────────────────────────
  const save = useMutation({
    // Wrap in an async fn so both branches resolve to the same shape — we
    // discard the response anyway and just invalidate on success.
    mutationFn: async (payload: OfferPayload) => {
      if (editingId) { await offersApi.update(editingId, payload); }
      else           { await offersApi.create(payload); }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["offers", cid] });
      toast({ title: editingId ? t("offers.updated", "تم تحديث العرض") : t("offers.created", "تم إنشاء العرض") });
      navigate("/inventory/offers");
    },
    onError: (e) => toast({ title: t("offers.saveError", "تعذّر الحفظ"), description: parseError(e), variant: "destructive" }),
  });

  function submit() {
    // Lightweight client validation that mirrors the server rules so the user
    // gets immediate feedback without round-tripping.
    if (priority < 1 || priority > 10) {
      toast({ title: t("offers.errPriority", "الأولوية يجب أن تكون من 1 إلى 10"), variant: "destructive" }); return;
    }
    if (startDate && expiryDate && startDate > expiryDate) {
      toast({ title: t("offers.errDates", "تاريخ البداية يجب أن يكون قبل تاريخ الانتهاء"), variant: "destructive" }); return;
    }
    if (discountType === "percentage_total") {
      const v = Number(discountValue);
      if (!Number.isFinite(v) || v <= 0 || v > 100) {
        toast({ title: t("offers.errPct", "نسبة الخصم يجب أن تكون من 0 إلى 100"), variant: "destructive" }); return;
      }
    }
    if (discountType === "fixed_total") {
      const v = Number(discountValue);
      if (!Number.isFinite(v) || v <= 0) {
        toast({ title: t("offers.errFixed", "قيمة الخصم يجب أن تكون أكبر من صفر"), variant: "destructive" }); return;
      }
    }
    if (discountType === "buy_x_get_y") {
      if (!Number.isFinite(Number(buyQty)) || Number(buyQty) < 1) {
        toast({ title: t("offers.errBuyQty", "كمية الشراء (Buy X) يجب أن تكون 1 على الأقل"), variant: "destructive" }); return;
      }
      if (!Number.isFinite(Number(getQty)) || Number(getQty) < 1) {
        toast({ title: t("offers.errGetQty", "كمية المجانية (Get Y) يجب أن تكون 1 على الأقل"), variant: "destructive" }); return;
      }
      const gp = Number(getDiscountPercent);
      if (!Number.isFinite(gp) || gp <= 0 || gp > 100) {
        toast({ title: t("offers.errGetPct", "نسبة الخصم على المجاني من 0 إلى 100"), variant: "destructive" }); return;
      }
    }
    // Mirror the server's numeric guards so the user gets immediate feedback
    // without round-tripping.  Empty string = "leave it" (server default 0 /
    // null), so we only complain when the field has a value that's invalid.
    if (minPurchaseAmount !== "" && (!Number.isFinite(Number(minPurchaseAmount)) || Number(minPurchaseAmount) < 0)) {
      toast({ title: t("offers.errMinPurchase", "الحد الأدنى لإجمالي الفاتورة يجب أن يكون 0 أو أكثر"), variant: "destructive" }); return;
    }
    if (maxUses !== "" && (!Number.isFinite(Number(maxUses)) || Number(maxUses) < 1)) {
      toast({ title: t("offers.errMaxUses", "الحد الأقصى للاستخدام يجب أن يكون رقمًا أكبر من صفر"), variant: "destructive" }); return;
    }
    if (maxUsesPerCustomer !== "" && (!Number.isFinite(Number(maxUsesPerCustomer)) || Number(maxUsesPerCustomer) < 1)) {
      toast({ title: t("offers.errMaxUsesPerCustomer", "الحد الأقصى لكل عميل يجب أن يكون رقمًا أكبر من صفر"), variant: "destructive" }); return;
    }
    if (customerScope === "specific" && pickedCustomers.size === 0) {
      toast({ title: t("offers.errPickCustomers", "اختر عميلًا واحدًا على الأقل"), variant: "destructive" }); return;
    }
    if (itemsScope === "specific" && pickedItems.length === 0) {
      toast({ title: t("offers.errPickItems", "اختر صنفًا واحدًا على الأقل"), variant: "destructive" }); return;
    }
    if (salesRepScope === "specific" && pickedSalesReps.size === 0) {
      toast({ title: t("offers.errPickReps", "اختر مندوبًا واحدًا على الأقل"), variant: "destructive" }); return;
    }
    const payload: OfferPayload = {
      companyId: cid,
      nameAr: nameAr || null,
      description: description || null,
      priority,
      startDate:  startDate  || null,
      expiryDate: expiryDate || null,
      status,
      applyTo,
      stackable,

      discountType,
      discountValue:      discountType === "percentage_total" || discountType === "fixed_total" ? discountValue : null,
      buyQty:             discountType === "buy_x_get_y" ? Number(buyQty) : null,
      getQty:             discountType === "buy_x_get_y" ? Number(getQty) : null,
      getDiscountPercent: discountType === "buy_x_get_y" ? getDiscountPercent : null,

      couponCode:         couponCode.trim() || null,
      minPurchaseAmount:  minPurchaseAmount === "" ? "0" : minPurchaseAmount,
      maxUses:            maxUses === "" ? null : Number(maxUses),
      maxUsesPerCustomer: maxUsesPerCustomer === "" ? null : Number(maxUsesPerCustomer),
      notes:              notes.trim() || null,

      customerScope, itemsScope, salesRepScope,
      customers: customerScope === "specific" ? Array.from(pickedCustomers) : [],
      salesReps: salesRepScope === "specific" ? Array.from(pickedSalesReps) : [],
      items:     itemsScope === "specific" ? pickedItems.map(it => ({
        itemId: it.itemId,
        price: it.price === "" ? null : it.price,
        discount: it.discount === "" ? null : it.discount,
        qty: it.qty === "" ? null : it.qty,
      })) : [],
    };
    save.mutate(payload);
  }

  if (editingId && offerQ.isLoading) {
    return <div className="space-y-3"><Skeleton className="h-12 w-full" /><Skeleton className="h-64 w-full" /></div>;
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="bg-card border border-border rounded-2xl p-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-primary/10 grid place-items-center text-primary">
            <Tag className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold">
              {editingId ? t("offers.editTitle", "تعديل العرض") : t("offers.newTitle", "عرض جديد")}
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("offers.formSubtitle", "حدد النطاقات واحفظ كمسوّدة أو فعّل العرض مباشرة")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => navigate("/inventory/offers")}>
            <ArrowRight className="h-4 w-4 ml-1" /> {t("common.back", "رجوع")}
          </Button>
          <Button onClick={submit} disabled={save.isPending} className="gap-1">
            <Save className="h-4 w-4" /> {save.isPending ? t("common.saving", "جارٍ الحفظ...") : t("common.save", "حفظ")}
          </Button>
        </div>
      </div>

      {/* Tabbed form body */}
      <Tabs defaultValue="basic" className="w-full">
        <TabsList className="grid grid-cols-4 w-full">
          <TabsTrigger value="basic"   className="gap-1.5"><Settings2 className="h-3.5 w-3.5" /> {t("offers.tab.basic", "الأساسي")}</TabsTrigger>
          <TabsTrigger value="discount" className="gap-1.5"><Percent className="h-3.5 w-3.5" /> {t("offers.tab.discount", "نوع الخصم")}</TabsTrigger>
          <TabsTrigger value="usage"   className="gap-1.5"><Ticket className="h-3.5 w-3.5" /> {t("offers.tab.usage", "الاستخدام والكوبون")}</TabsTrigger>
          <TabsTrigger value="scopes"  className="gap-1.5"><Layers className="h-3.5 w-3.5" /> {t("offers.tab.scopes", "النطاقات")}</TabsTrigger>
        </TabsList>

        {/* ────────────────────────────────  BASIC  ──────────────────────── */}
        <TabsContent value="basic" className="mt-4">
          <div className="bg-card border border-border rounded-2xl p-5 space-y-5">
            {/* Top: same column-count + cell sizing as the Purchase Invoice
                header tab so the two forms feel identical. */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs">{t("offers.f.name", "اسم العرض (اختياري)")}</Label>
                <Input className="h-9 text-sm" value={nameAr} onChange={(e) => setNameAr(e.target.value)} placeholder={t("offers.f.namePh", "مثال: عرض رمضان") as string} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("offers.f.priority", "الأولوية (1-10)")}</Label>
                <Input className="h-9 text-sm" type="number" min={1} max={10} value={priority}
                  onChange={(e) => setPriority(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("offers.f.status", "الحالة")}</Label>
                <select
                  className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as any)}
                >
                  <option value="draft">{t("offers.statusVal.draft", "مسوّدة")}</option>
                  <option value="active">{t("offers.statusVal.active", "مفعّل")}</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("offers.f.applyTo", "قناة التطبيق")}</Label>
                <select
                  className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm"
                  value={applyTo}
                  onChange={(e) => setApplyTo(e.target.value as OfferApplyTo)}
                >
                  <option value="all">{t("offers.applyToVal.all", "كل القنوات")}</option>
                  <option value="invoice">{t("offers.applyToVal.invoice", "فواتير المبيعات فقط")}</option>
                  <option value="pos">{t("offers.applyToVal.pos", "نقاط البيع فقط")}</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs flex items-center gap-1">
                  <Calendar className="h-3 w-3 text-muted-foreground" />
                  {t("offers.f.startDate", "تاريخ البداية")}
                </Label>
                <Input className="h-9 text-sm" type="date" value={startDate}
                  onChange={(e) => setStartDate(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs flex items-center gap-1">
                  <Calendar className="h-3 w-3 text-muted-foreground" />
                  {t("offers.f.expiry", "تاريخ الانتهاء")}
                </Label>
                <Input className="h-9 text-sm" type="date" value={expiryDate}
                  onChange={(e) => setExpiryDate(e.target.value)} />
              </div>
              <div className="space-y-1.5 col-span-2 lg:col-span-2">
                <Label className="text-xs">{t("offers.f.stackable", "السماح بدمج هذا العرض مع عروض أخرى")}</Label>
                <div className="h-9 px-3 rounded-md border border-input bg-background flex items-center gap-2">
                  <Switch checked={stackable} onCheckedChange={setStackable} />
                  <span className="text-xs text-muted-foreground">
                    {stackable
                      ? t("offers.stackable.on", "يمكن دمجه مع عروض أخرى على نفس السطر")
                      : t("offers.stackable.off", "لا يُدمج — يُختار عرض واحد لكل سطر")}
                  </span>
                </div>
              </div>
              <div className="space-y-1.5 col-span-2 lg:col-span-4">
                <Label className="text-xs">{t("offers.f.description", "الوصف")}</Label>
                <Input className="h-9 text-sm" value={description} onChange={(e) => setDescription(e.target.value)} />
              </div>
            </div>
          </div>
        </TabsContent>

        {/* ──────────────────────────────  DISCOUNT  ─────────────────────── */}
        <TabsContent value="discount" className="mt-4">
          <div className="bg-card border border-border rounded-2xl p-5 space-y-5">
            {/* Type picker — radios as cards, same idiom as the scope toggles
                in the existing scopes tab. */}
            <div>
              <Label className="text-xs mb-2 block">{t("offers.f.discountType", "نوع الخصم")}</Label>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2">
                {(["line_pricing", "percentage_total", "fixed_total", "buy_x_get_y"] as OfferDiscountType[]).map((typ) => (
                  <button
                    key={typ}
                    type="button"
                    onClick={() => setDiscountType(typ)}
                    className={`text-start px-3 py-2.5 rounded-lg border transition ${
                      discountType === typ
                        ? "border-primary bg-primary/5 ring-2 ring-primary/20"
                        : "border-border bg-card hover:border-primary/40"
                    }`}
                  >
                    <div className="text-sm font-medium">{t(`offers.discountTypeVal.${typ}.label`, typ)}</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5 leading-tight">
                      {t(`offers.discountTypeVal.${typ}.hint`, "")}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Conditional fields per type */}
            {discountType === "line_pricing" && (
              <div className="text-xs text-muted-foreground bg-muted/30 rounded-lg p-3">
                {t("offers.lineHint", "لا توجد إعدادات إضافية هنا — السعر/الخصم/الكمية يُحدَّد لكل صنف داخل تبويب «النطاقات» → «الأصناف».")}
              </div>
            )}

            {discountType === "percentage_total" && (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("offers.f.discountValuePct", "نسبة الخصم على إجمالي الفاتورة %")}</Label>
                  <Input className="h-9 text-sm" type="number" step="0.01" min={0} max={100}
                    value={discountValue} onChange={(e) => setDiscountValue(e.target.value)} placeholder="مثال: 10" />
                </div>
              </div>
            )}

            {discountType === "fixed_total" && (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("offers.f.discountValueFixed", "قيمة الخصم على إجمالي الفاتورة")}</Label>
                  <Input className="h-9 text-sm" type="number" step="0.01" min={0}
                    value={discountValue} onChange={(e) => setDiscountValue(e.target.value)} placeholder="مثال: 50" />
                </div>
              </div>
            )}

            {discountType === "buy_x_get_y" && (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("offers.f.buyQty", "اشترِ كمية (X)")}</Label>
                  <Input className="h-9 text-sm" type="number" min={1} step={1}
                    value={buyQty} onChange={(e) => setBuyQty(e.target.value)} placeholder="مثال: 2" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("offers.f.getQty", "احصل على كمية (Y)")}</Label>
                  <Input className="h-9 text-sm" type="number" min={1} step={1}
                    value={getQty} onChange={(e) => setGetQty(e.target.value)} placeholder="مثال: 1" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("offers.f.getPct", "نسبة الخصم على Y % (100 = مجاني)")}</Label>
                  <Input className="h-9 text-sm" type="number" min={0} max={100} step="0.01"
                    value={getDiscountPercent} onChange={(e) => setGetDiscountPercent(e.target.value)} />
                </div>
                <div className="space-y-1.5 col-span-2 lg:col-span-1 flex items-end">
                  <div className="text-[11px] text-muted-foreground bg-muted/30 rounded-lg p-2 w-full">
                    {t("offers.buyHint", "ينطبق على الأصناف المحددة في تبويب «النطاقات»")}
                  </div>
                </div>
              </div>
            )}
          </div>
        </TabsContent>

        {/* ────────────────────────────  USAGE & COUPON  ────────────────── */}
        <TabsContent value="usage" className="mt-4">
          <div className="bg-card border border-border rounded-2xl p-5 space-y-5">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs flex items-center gap-1">
                  <Ticket className="h-3 w-3 text-muted-foreground" />
                  {t("offers.f.couponCode", "رمز الكوبون (اختياري)")}
                </Label>
                <Input className="h-9 text-sm font-mono uppercase" value={couponCode}
                  onChange={(e) => setCouponCode(e.target.value)} placeholder="EID2026" maxLength={50} />
                <p className="text-[10px] text-muted-foreground">
                  {t("offers.couponHint", "اتركه فارغًا ليُطبَّق العرض تلقائيًا")}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("offers.f.minPurchase", "الحد الأدنى لإجمالي الفاتورة")}</Label>
                <Input className="h-9 text-sm" type="number" step="0.01" min={0}
                  value={minPurchaseAmount} onChange={(e) => setMinPurchaseAmount(e.target.value)} placeholder="0" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs flex items-center gap-1">
                  <Hash className="h-3 w-3 text-muted-foreground" />
                  {t("offers.f.maxUses", "الحد الأقصى للاستخدام (إجمالي)")}
                </Label>
                <Input className="h-9 text-sm" type="number" min={1} step={1}
                  value={maxUses} onChange={(e) => setMaxUses(e.target.value)} placeholder={t("offers.unlimited", "غير محدود") as string} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs flex items-center gap-1">
                  <Hash className="h-3 w-3 text-muted-foreground" />
                  {t("offers.f.maxUsesPerCustomer", "الحد الأقصى لكل عميل")}
                </Label>
                <Input className="h-9 text-sm" type="number" min={1} step={1}
                  value={maxUsesPerCustomer} onChange={(e) => setMaxUsesPerCustomer(e.target.value)} placeholder={t("offers.unlimited", "غير محدود") as string} />
              </div>
              {/* Read-only counter — only meaningful in edit mode. */}
              {editingId && (
                <div className="space-y-1.5 col-span-2 lg:col-span-2">
                  <Label className="text-xs">{t("offers.f.timesUsed", "عدد مرات الاستخدام")}</Label>
                  <div className="h-9 px-3 rounded-md border border-input bg-muted/30 flex items-center text-sm">
                    <span className="font-semibold">{timesUsed}</span>
                    {maxUses && <span className="text-muted-foreground"> &nbsp;/ {maxUses}</span>}
                  </div>
                </div>
              )}
              <div className="space-y-1.5 col-span-2 lg:col-span-4">
                <Label className="text-xs flex items-center gap-1">
                  <FileText className="h-3 w-3 text-muted-foreground" />
                  {t("offers.f.notes", "ملاحظات داخلية")}
                </Label>
                <Textarea rows={3} className="text-sm" value={notes} onChange={(e) => setNotes(e.target.value)}
                  placeholder={t("offers.notesPh", "ملاحظات للمحاسب أو المدير المالي — لا تظهر للعميل") as string} />
              </div>
            </div>
          </div>
        </TabsContent>

        {/* ────────────────────────────────  SCOPES  ────────────────────── */}
        <TabsContent value="scopes" className="mt-4 space-y-5">
          <ScopeCard
            icon={<Users className="h-4 w-4" />}
            title={t("offers.scopeCard.customers", "العملاء")}
            scope={customerScope}
            onScope={setCustomerScope}
            emptyHint={t("offers.scopeCard.allCustomersHint", "العرض ينطبق على جميع العملاء")}
          >
            <SimpleMultiPicker
              rows={customersQ.data ?? []}
              loading={customersQ.isLoading}
              picked={pickedCustomers}
              onTogglePick={(idVal) => {
                setPickedCustomers((prev) => {
                  const n = new Set(prev);
                  n.has(idVal) ? n.delete(idVal) : n.add(idVal);
                  return n;
                });
              }}
            />
          </ScopeCard>

          <ScopeCard
            icon={<Package className="h-4 w-4" />}
            title={t("offers.scopeCard.items", "الأصناف")}
            scope={itemsScope}
            onScope={setItemsScope}
            emptyHint={t("offers.scopeCard.allItemsHint", "العرض ينطبق على جميع الأصناف")}
          >
            <ItemsPicker
              rows={itemsQ.data ?? []}
              loading={itemsQ.isLoading}
              picked={pickedItems}
              onChange={setPickedItems}
            />
          </ScopeCard>

          <ScopeCard
            icon={<UserCheck className="h-4 w-4" />}
            title={t("offers.scopeCard.salesReps", "المناديب")}
            scope={salesRepScope}
            onScope={setSalesRepScope}
            emptyHint={t("offers.scopeCard.allRepsHint", "العرض ينطبق على جميع المناديب")}
          >
            <SimpleMultiPicker
              rows={salesRepsQ.data ?? []}
              loading={salesRepsQ.isLoading}
              picked={pickedSalesReps}
              onTogglePick={(idVal) => {
                setPickedSalesReps((prev) => {
                  const n = new Set(prev);
                  n.has(idVal) ? n.delete(idVal) : n.add(idVal);
                  return n;
                });
              }}
            />
          </ScopeCard>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Reusable scope card with the ALL / SPECIFIC toggle ──────────────────────
function ScopeCard({ icon, title, scope, onScope, emptyHint, children }: {
  icon: React.ReactNode; title: string; scope: Scope; onScope: (s: Scope) => void;
  emptyHint: string; children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="bg-card border border-border rounded-2xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-semibold text-sm">
          <span className="h-7 w-7 rounded-lg bg-primary/10 text-primary grid place-items-center">{icon}</span>
          {title}
        </div>
        <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5">
          <button
            type="button"
            onClick={() => onScope("all")}
            className={`text-xs px-3 py-1.5 rounded-md transition ${scope === "all" ? "bg-card shadow text-foreground" : "text-muted-foreground"}`}
          >{t("offers.scope.all", "الكل")}</button>
          <button
            type="button"
            onClick={() => onScope("specific")}
            className={`text-xs px-3 py-1.5 rounded-md transition ${scope === "specific" ? "bg-card shadow text-foreground" : "text-muted-foreground"}`}
          >{t("offers.scope.specific", "محدد")}</button>
        </div>
      </div>
      {scope === "all"
        ? <div className="text-xs text-muted-foreground bg-muted/30 rounded-lg p-3 text-center">{emptyHint}</div>
        : children}
    </div>
  );
}

// ── Simple multi-picker for customers and sales-reps ────────────────────────
function SimpleMultiPicker<T extends { id: number; code?: string; nameAr?: string; nameEn?: string }>({
  rows, loading, picked, onTogglePick,
}: {
  rows: T[]; loading: boolean; picked: Set<number>; onTogglePick: (id: number) => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");

  // Cheap client-side filter — these lists rarely exceed a few hundred rows
  // for a single tenant, so re-running on every keystroke is fine.
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(r => `${r.code ?? ""} ${r.nameAr ?? ""} ${r.nameEn ?? ""}`.toLowerCase().includes(needle));
  }, [rows, q]);

  if (loading) return <Skeleton className="h-32 w-full" />;
  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="h-4 w-4 absolute top-3 start-3 text-muted-foreground pointer-events-none" />
        <Input className="ps-9" placeholder={t("offers.searchPh", "بحث...") as string} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="text-xs text-muted-foreground">
        {t("offers.pickedCount", "محدد")}: <span className="font-semibold">{picked.size}</span>
      </div>
      <div className="border border-border rounded-lg max-h-72 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">{t("offers.noResults", "لا توجد نتائج")}</div>
        ) : filtered.map((r) => {
          const isOn = picked.has(r.id);
          return (
            <label key={r.id} className="flex items-center gap-3 p-2.5 border-b border-border last:border-b-0 hover:bg-muted/40 cursor-pointer">
              <input type="checkbox" checked={isOn} onChange={() => onTogglePick(r.id)} className="h-4 w-4" />
              <span className="text-xs font-mono text-muted-foreground w-16">{r.code ?? r.id}</span>
              <span className="text-sm flex-1">{r.nameAr ?? r.nameEn ?? `#${r.id}`}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

// ── Items picker — adds per-item price / discount / qty fields ──────────────
function ItemsPicker({ rows, loading, picked, onChange }: {
  rows: ItemLite[]; loading: boolean; picked: SelectedItem[]; onChange: (next: SelectedItem[]) => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const pickedIds = useMemo(() => new Set(picked.map(p => p.itemId)), [picked]);

  const candidates = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const base = rows.filter(r => !pickedIds.has(r.id));
    if (!needle) return base.slice(0, 50);
    return base.filter(r => `${r.code ?? ""} ${r.nameAr ?? ""} ${r.nameEn ?? ""}`.toLowerCase().includes(needle)).slice(0, 50);
  }, [rows, q, pickedIds]);

  function add(it: ItemLite) {
    onChange([...picked, { itemId: it.id, price: it.salePrice ?? "", discount: "", qty: "" }]);
    setQ("");
  }
  function remove(itemId: number) {
    onChange(picked.filter(p => p.itemId !== itemId));
  }
  function patch(itemId: number, field: "price" | "discount" | "qty", value: string) {
    onChange(picked.map(p => p.itemId === itemId ? { ...p, [field]: value } : p));
  }
  function nameOf(itemId: number) {
    const r = rows.find(x => x.id === itemId);
    return r ? (r.nameAr ?? r.nameEn ?? `#${itemId}`) : `#${itemId}`;
  }

  if (loading) return <Skeleton className="h-32 w-full" />;
  return (
    <div className="space-y-3">
      {/* Search-and-add */}
      <div className="relative">
        <Search className="h-4 w-4 absolute top-3 start-3 text-muted-foreground pointer-events-none" />
        <Input className="ps-9" placeholder={t("offers.itemsSearchPh", "ابحث عن صنف لإضافته...") as string} value={q} onChange={(e) => setQ(e.target.value)} />
        {q.trim() !== "" && candidates.length > 0 && (
          <div className="absolute z-10 mt-1 left-0 right-0 bg-popover border border-border rounded-lg max-h-60 overflow-y-auto shadow-lg">
            {candidates.map(c => (
              <button
                key={c.id}
                type="button"
                onClick={() => add(c)}
                className="w-full text-start flex items-center gap-3 p-2 hover:bg-muted/60 border-b border-border last:border-b-0 text-sm"
              >
                <Plus className="h-3.5 w-3.5 text-primary" />
                <span className="font-mono text-xs text-muted-foreground w-16">{c.code ?? c.id}</span>
                <span className="flex-1">{c.nameAr ?? c.nameEn ?? `#${c.id}`}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Selected items table */}
      {picked.length === 0 ? (
        <div className="text-xs text-muted-foreground bg-muted/30 rounded-lg p-3 text-center">
          {t("offers.itemsEmpty", "لم يُضف أي صنف بعد")}
        </div>
      ) : (
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="text-start px-3 py-2 font-medium">{t("offers.itemCol.name", "الصنف")}</th>
                <th className="text-start px-3 py-2 font-medium w-32">{t("offers.itemCol.price", "السعر")}</th>
                <th className="text-start px-3 py-2 font-medium w-32">{t("offers.itemCol.discount", "الخصم %")}</th>
                <th className="text-start px-3 py-2 font-medium w-32">{t("offers.itemCol.qty", "الحد الأدنى للكمية")}</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {picked.map(p => (
                <tr key={p.itemId} className="border-t border-border">
                  <td className="px-3 py-2">{nameOf(p.itemId)}</td>
                  <td className="px-2 py-1.5"><Input className="h-8" type="number" step="0.01" value={p.price} onChange={(e) => patch(p.itemId, "price", e.target.value)} /></td>
                  <td className="px-2 py-1.5"><Input className="h-8" type="number" step="0.01" value={p.discount} onChange={(e) => patch(p.itemId, "discount", e.target.value)} /></td>
                  <td className="px-2 py-1.5"><Input className="h-8" type="number" step="0.01" value={p.qty} onChange={(e) => patch(p.itemId, "qty", e.target.value)} /></td>
                  <td className="px-2 py-1.5 text-end">
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-destructive" onClick={() => remove(p.itemId)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
