import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useRefetchOnFocus } from "@/hooks/useRefetchOnFocus";
import { Link, useLocation } from "wouter";
import { Plus, Search, Factory, ArrowRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  rowToneFor, DocColorLegend, buildToneTooltip, type LegendItem,
} from "@/lib/docRowTone";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Label } from "@/components/ui/label";
import ProductionAIAssistant from "@/components/ProductionAIAssistant";
import UnitCodeSelect from "@/components/UnitCodeSelect";
import { useNextSequenceNumber } from "@/hooks/useNextSequenceNumber";

const API = import.meta.env.VITE_API_URL || "";

const STATUSES = [
  "draft",
  "approved",
  "in_production",
  "quality_check",
  "completed",
  "cancelled",
] as const;

type Order = {
  id: number;
  orderNumber: string;
  title: string;
  status: string;
  plannedQty: string;
  producedQty: string;
  unitCode: string;
  createdAt: string;
};

const STATUS_TONES: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  approved: "bg-blue-100 text-blue-700",
  in_production: "bg-amber-100 text-amber-800",
  quality_check: "bg-violet-100 text-violet-700",
  completed: "bg-emerald-100 text-emerald-700",
  cancelled: "bg-red-100 text-red-700",
};

export default function ProductionOrders() {
  const { t } = useTranslation();
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [rows, setRows] = useState<Order[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [openCreate, setOpenCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  // Peek the next production-order number from the central sequence engine
  // so the user sees the upcoming auto-assigned number before saving.
  const nextCode = useNextSequenceNumber("production_order", openCreate);
  const [form, setForm] = useState({
    title: "",
    productItemId: "" as number | "",
    plannedQty: "",
    unitCode: "PCE",
    notes: "",
  });
  // Manufactured items (finished + semi) used as the FG product picker.
  // BOM templates auto-copy raw lines to the order based on this id.
  const [items, setItems] = useState<{ id: number; code: string; nameAr: string; itemNature?: string | null; unitCode?: string | null }[]>([]);
  const loadItems = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch(`${API}/api/inventory/items?includeHidden=1&limit=5000`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return;
      const j = await r.json();
      setItems(Array.isArray(j) ? j : (j.rows ?? []));
    } catch { /* silent */ }
  }, [token]);
  useEffect(() => { void loadItems(); }, [loadItems]);
  useRefetchOnFocus(loadItems);
  const fgItems = useMemo(
    () => items.filter((i) => !i.itemNature || i.itemNature === "finished" || i.itemNature === "semi"),
    [items],
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  function closePanel() {
    setOpenCreate(false);
    setForm({ title: "", productItemId: "", plannedQty: "", unitCode: "PCE", notes: "" });
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  useEffect(() => {
    if (!openCreate) return;
    requestAnimationFrame(() => {
      panelRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      firstFieldRef.current?.focus();
    });
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closePanel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCreate]);

  async function load() {
    if (!token) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (search.trim()) params.set("search", search.trim());
      const r = await fetch(`${API}/api/production/orders?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setRows(await r.json());
    } catch (e: any) {
      toast({ title: t("production.errorOccurred"), description: e?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, statusFilter]);

  // Debounce search
  useEffect(() => {
    const id = setTimeout(() => { void load(); }, 350);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim()) {
      toast({ title: t("production.errorOccurred"), description: t("production.title_field"), variant: "destructive" });
      return;
    }
    setCreating(true);
    try {
      const r = await fetch(`${API}/api/production/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          title: form.title.trim(),
          productItemId: form.productItemId === "" ? null : Number(form.productItemId),
          plannedQty: Number(form.plannedQty) || 0,
          unitCode: form.unitCode || "PCE",
          notes: form.notes || null,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      toast({ title: `✓ ${t("production.saved")}` });
      setOpenCreate(false);
      setForm({ title: "", productItemId: "", plannedQty: "", unitCode: "PCE", notes: "" });
      navigate(`/production/orders/${j.id}`);
    } catch (e: any) {
      toast({ title: t("production.errorOccurred"), description: e?.message, variant: "destructive" });
    } finally {
      setCreating(false);
    }
  }

  const list = useMemo(() => rows ?? [], [rows]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 p-2 text-white shadow">
            <Factory className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">{t("production.orders")}</h1>
            <p className="text-sm text-slate-500">{t("production.subtitle")}</p>
          </div>
        </div>
        <Button
          ref={triggerRef}
          data-testid="btn-new-order"
          onClick={() => (openCreate ? closePanel() : setOpenCreate(true))}
          variant={openCreate ? "outline" : "default"}
          aria-expanded={openCreate}
          aria-controls="panel-new-order"
        >
          {openCreate ? <X className="h-4 w-4 me-1" /> : <Plus className="h-4 w-4 me-1" />}
          {openCreate ? t("common.cancel") : t("production.newOrder")}
        </Button>
      </div>

      {openCreate && (
        <div
          ref={panelRef}
          id="panel-new-order"
          role="region"
          aria-label={t("production.newOrder")}
          className="rounded-lg border border-violet-200 dark:border-violet-900/50 bg-gradient-to-br from-violet-50/60 to-fuchsia-50/40 dark:from-violet-950/20 dark:to-fuchsia-950/10 shadow-sm"
          data-testid="panel-new-order"
        >
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-violet-200/70 dark:border-violet-900/40">
            <div className="flex items-center gap-2 text-sm font-semibold text-violet-700 dark:text-violet-300">
              <Plus className="h-4 w-4" />
              {t("production.newOrder")}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={closePanel}
              aria-label={t("common.cancel")}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <form onSubmit={handleCreate} className="p-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("production.orderNumber")}</Label>
                <Input
                  value={nextCode.number ?? (nextCode.loading ? "..." : t("production.autoCode"))}
                  readOnly
                  disabled
                  className="mt-1 font-mono text-sm bg-muted/30"
                  data-testid="input-order-number"
                />
              </div>
              <div className="md:col-span-3">
                <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("production.title_field")}</Label>
                <Input
                  ref={firstFieldRef}
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  required
                  data-testid="input-title"
                  className="mt-1"
                />
              </div>
              <div className="md:col-span-2">
                <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">
                  صنف المنتج النهائي <span className="text-slate-400">(لتعبئة الخامات تلقائياً من قالب المكونات)</span>
                </Label>
                <SearchCombobox
                  value={form.productItemId === "" ? "" : String(form.productItemId)}
                  onValueChange={(v) => {
                    const idNum = v === "" ? "" : Number(v);
                    const it = idNum === "" ? undefined : fgItems.find((x) => x.id === idNum);
                    setForm((f) => ({
                      ...f,
                      productItemId: idNum,
                      // Auto-fill unit + a default title from the picked item
                      unitCode: it?.unitCode || f.unitCode,
                      title: f.title.trim() ? f.title : (it?.nameAr ?? f.title),
                    }));
                  }}
                  placeholder="—"
                  searchPlaceholder="ابحث بالاسم أو الكود…"
                  items={[
                    { value: "", label: "—" },
                    ...fgItems.map((i) => ({ value: String(i.id), code: i.code ?? undefined, label: i.nameAr ?? `#${i.id}` })),
                  ]}
                />
              </div>
              <div>
                <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("production.plannedQty")}</Label>
                <Input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  value={form.plannedQty}
                  onChange={(e) => setForm({ ...form, plannedQty: e.target.value })}
                  data-testid="input-planned-qty"
                  className="mt-1"
                />
              </div>
              <div>
                <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("production.unitCode")}</Label>
                <UnitCodeSelect
                  value={form.unitCode}
                  onChange={(v) => setForm({ ...form, unitCode: v })}
                  data-testid="input-unit-code"
                  className="mt-1"
                />
              </div>
            </div>
            <div>
              <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("production.notes")}</Label>
              <Input
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                data-testid="input-notes"
                className="mt-1"
              />
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button type="button" variant="outline" onClick={closePanel}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={creating} data-testid="btn-create-order">
                {creating ? t("common.loading") : t("common.save")}
              </Button>
            </div>
          </form>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <div className="flex flex-wrap gap-2 items-center">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="absolute start-2 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("production.searchPlaceholder")}
                className="ps-8"
                data-testid="input-search"
              />
            </div>
            <div className="w-48" data-testid="select-status-filter">
              <SearchCombobox
                value={statusFilter || ""}
                onValueChange={(v) => setStatusFilter(v)}
                placeholder={t("production.filterAll")}
                searchPlaceholder="ابحث…"
                items={[
                  { value: "", label: t("production.filterAll") },
                  ...STATUSES.map((s) => ({ value: s, label: t(`production.status_${s}`) })),
                ]}
              />
            </div>
          </div>

          {(() => {
            const items: LegendItem[] = [
              { kind: "draft",         count: list.filter((x: any) => x.status === "draft").length },
              { kind: "approved",      count: list.filter((x: any) => x.status === "approved").length },
              { kind: "in_production", count: list.filter((x: any) => x.status === "in_production").length },
              { kind: "quality_check", count: list.filter((x: any) => x.status === "quality_check").length },
              { kind: "completed",     count: list.filter((x: any) => x.status === "completed" || x.status === "closed").length },
              { kind: "cancelled",     count: list.filter((x: any) => x.status === "cancelled").length },
            ];
            return <DocColorLegend items={items} />;
          })()}

          <div className="rounded-lg border bg-white dark:bg-slate-900">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                <tr>
                  <th className="text-start p-3">{t("production.orderNumber")}</th>
                  <th className="text-start p-3">{t("production.title_field")}</th>
                  <th className="text-start p-3">{t("production.status")}</th>
                  <th className="text-end p-3">{t("production.plannedQty")}</th>
                  <th className="text-end p-3">{t("production.producedQty")}</th>
                  <th className="text-end p-3"></th>
                </tr>
              </thead>
              <tbody>
                {loading && rows === null && Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i} className="border-t">
                    <td className="p-3" colSpan={6}><Skeleton className="h-6 w-full" /></td>
                  </tr>
                ))}
                {!loading && list.length === 0 && (
                  <tr><td colSpan={6} className="p-8 text-center text-slate-500">{t("production.noOrders")}</td></tr>
                )}
                {list.map((o) => (
                  <tr key={o.id}
                      data-status={o.status}
                      className={cn("border-t transition-colors", rowToneFor({ status: o.status }))}
                      title={buildToneTooltip({ status: o.status })}
                      data-testid={`row-order-${o.id}`}>
                    <td className="p-3 font-mono text-xs">{o.orderNumber}</td>
                    <td className="p-3">{o.title}</td>
                    <td className="p-3">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONES[o.status] ?? "bg-slate-100"}`}>
                        {t(`production.status_${o.status}`)}
                      </span>
                    </td>
                    <td className="p-3 text-end">{Number(o.plannedQty).toLocaleString()} <span className="text-xs text-slate-400">{o.unitCode}</span></td>
                    <td className="p-3 text-end">{Number(o.producedQty).toLocaleString()}</td>
                    <td className="p-3 text-end">
                      <Link href={`/production/orders/${o.id}`}>
                        <Button size="sm" variant="ghost" data-testid={`btn-open-${o.id}`}>
                          <ArrowRight className="h-4 w-4" />
                        </Button>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <ProductionAIAssistant
            screenContext="production.orders.list"
            currentAction="viewing orders list"
          />
        </div>
      </div>
    </div>
  );
}
