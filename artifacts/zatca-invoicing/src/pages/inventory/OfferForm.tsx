// Offer create/edit screen.
//
// Big idea — three independent "scope" cards:
//   • Customers card  → ALL or pick a subset.
//   • Items card      → ALL or pick a subset (with per-item price/discount/qty).
//   • Sales reps card → ALL or pick a subset.
//
// We keep the picker UX deliberately simple: a search box + an unrolled list
// with checkboxes.  No popover combobox so the user can scan many rows at
// once on a desktop screen, which is the primary form-factor for an admin.
//
// Editing rules: if the offer is `active` the API blocks the PUT, so we
// fetch and route the user back with a toast.  Drafts are fully editable.
//

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
import { Tag, Save, ArrowRight, Search, Users, Package, UserCheck, Trash2, Plus } from "lucide-react";
import { offersApi, type OfferPayload } from "@/lib/offersApi";
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

  // ── state ─────────────────────────────────────────────────────────────────
  const [nameAr, setNameAr] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState(5);
  const [expiryDate, setExpiryDate] = useState<string>("");
  const [status, setStatus] = useState<"draft" | "active">("draft");

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
    setExpiryDate(o.expiryDate ?? "");
    // The early-return above already kicks the user out for active offers,
    // so by this point status is always draft or expired.  We coerce expired
    // to draft so the user can re-publish after editing.
    setStatus("draft");
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
      expiryDate: expiryDate || null,
      status,
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

      {/* Top: basic fields */}
      <div className="bg-card border border-border rounded-2xl p-5 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <Label>{t("offers.f.name", "اسم العرض (اختياري)")}</Label>
          <Input value={nameAr} onChange={(e) => setNameAr(e.target.value)} placeholder={t("offers.f.namePh", "مثال: عرض رمضان") as string} />
        </div>
        <div>
          <Label>{t("offers.f.priority", "الأولوية (1-10)")}</Label>
          <Input type="number" min={1} max={10} value={priority} onChange={(e) => setPriority(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} />
        </div>
        <div>
          <Label>{t("offers.f.expiry", "تاريخ الانتهاء")}</Label>
          <Input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
        </div>
        <div className="md:col-span-2">
          <Label>{t("offers.f.description", "الوصف")}</Label>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div>
          <Label>{t("offers.f.status", "الحالة")}</Label>
          <select
            className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
            value={status}
            onChange={(e) => setStatus(e.target.value as any)}
          >
            <option value="draft">{t("offers.statusVal.draft", "مسوّدة")}</option>
            <option value="active">{t("offers.statusVal.active", "مفعّل")}</option>
          </select>
        </div>
      </div>

      {/* Customers scope */}
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

      {/* Items scope */}
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

      {/* Sales reps scope */}
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
