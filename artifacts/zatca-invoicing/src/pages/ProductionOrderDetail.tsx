import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, Link } from "wouter";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft, Plus, Trash2, Activity, ListChecks, Sparkles,
  CheckCircle2, PlayCircle, ClipboardCheck, Flag, Ban, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import ProductionAIAssistant from "@/components/ProductionAIAssistant";
import UnitCodeSelect from "@/components/UnitCodeSelect";

const API = import.meta.env.VITE_API_URL || "";

type Item = {
  id: number;
  kind: "raw" | "product" | "byproduct";
  description: string;
  quantity: string;
  unitCode: string;
  unitCost: string;
  totalCost: string;
};
type Event = {
  id: number;
  eventType: string;
  payload: Record<string, unknown>;
  byAi: boolean;
  createdAt: string;
};
type Order = {
  id: number;
  orderNumber: string;
  title: string;
  status: string;
  plannedQty: string;
  producedQty: string;
  wasteQty: string;
  unitCode: string;
  estimatedCost: string;
  actualCost: string;
  notes: string | null;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  actualStartAt: string | null;
  actualEndAt: string | null;
  // ─── SAP-style WIP fields (added in this iteration) ───
  rawWarehouseId: number | null;
  finishedWarehouseId: number | null;
  productItemId: number | null;
  laborCost: string;
  overheadCost: string;
  rawMaterialsCost: string;
  costCenter: string | null;
  wipAccountId: number | null;
  rawInventoryAccountId: number | null;
  finishedGoodsAccountId: number | null;
  laborAccountId: number | null;
  overheadAccountId: number | null;
  varianceAccountId: number | null;
  wasteAccountId: number | null;
  issueJournalEntryId: number | null;
  receiptJournalEntryId: number | null;
  // ─── Phase B — work center link ───
  workCenterId: number | null;
  plannedHours: string;
  actualHours: string;
};
type Warehouse = { id: number; name: string };
type Account = { id: number; code: string; nameAr: string; accountType: string };
type ItemRef = { id: number; nameAr: string; code: string };
type WorkCenterRef = {
  id: number;
  code: string;
  nameAr: string;
  laborRatePerHour: string;
  overheadRatePerHour: string;
  costCenterCode: string | null;
  defaultLaborAccountId: number | null;
  defaultOverheadAccountId: number | null;
  isActive: boolean;
};

// Status → list of allowed transitions, each rendered as a coloured action
// button. Mirrors the server-side PRODUCTION_STATUS_TRANSITIONS map. Keep the
// two in sync: if you add a transition here, add it on the backend too.
const TRANSITIONS: Record<string, { to: string; labelKey: string; icon: any; tone: string }[]> = {
  draft: [
    { to: "approved", labelKey: "production.approve", icon: CheckCircle2, tone: "bg-blue-600 hover:bg-blue-700" },
    { to: "cancelled", labelKey: "production.cancel", icon: Ban, tone: "bg-red-600 hover:bg-red-700" },
  ],
  approved: [
    { to: "in_production", labelKey: "production.start", icon: PlayCircle, tone: "bg-amber-600 hover:bg-amber-700" },
    { to: "cancelled", labelKey: "production.cancel", icon: Ban, tone: "bg-red-600 hover:bg-red-700" },
  ],
  in_production: [
    { to: "quality_check", labelKey: "production.sendToQa", icon: ClipboardCheck, tone: "bg-violet-600 hover:bg-violet-700" },
    { to: "cancelled", labelKey: "production.cancel", icon: Ban, tone: "bg-red-600 hover:bg-red-700" },
  ],
  quality_check: [
    { to: "completed", labelKey: "production.complete", icon: Flag, tone: "bg-emerald-600 hover:bg-emerald-700" },
    { to: "in_production", labelKey: "production.rework", icon: PlayCircle, tone: "bg-amber-600 hover:bg-amber-700" },
    { to: "cancelled", labelKey: "production.cancel", icon: Ban, tone: "bg-red-600 hover:bg-red-700" },
  ],
  completed: [],
  cancelled: [],
};

const STATUS_TONES: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  approved: "bg-blue-100 text-blue-700",
  in_production: "bg-amber-100 text-amber-800",
  quality_check: "bg-violet-100 text-violet-700",
  completed: "bg-emerald-100 text-emerald-700",
  cancelled: "bg-red-100 text-red-700",
};

export default function ProductionOrderDetail() {
  const { id } = useParams();
  const orderId = Number(id);
  const { t } = useTranslation();
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [order, setOrder] = useState<Order | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [openItem, setOpenItem] = useState(false);
  const [savingItem, setSavingItem] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  // ─── WIP setup state (warehouses, accounts, labor/overhead, completion) ──
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [itemRefs, setItemRefs] = useState<ItemRef[]>([]);
  const [workCenters, setWorkCenters] = useState<WorkCenterRef[]>([]);
  const [savingWip, setSavingWip] = useState(false);
  const [completion, setCompletion] = useState({ producedQty: "", wasteQty: "" });
  const [itemForm, setItemForm] = useState({
    kind: "raw" as Item["kind"],
    description: "",
    quantity: "",
    unitCode: "PCE",
    unitCost: "",
  });
  const itemTriggerRef = useRef<HTMLButtonElement>(null);
  const itemPanelRef = useRef<HTMLDivElement>(null);
  const firstItemFieldRef = useRef<HTMLInputElement>(null);

  function closeItemPanel() {
    setOpenItem(false);
    setItemForm({ kind: "raw", description: "", quantity: "", unitCode: "PCE", unitCost: "" });
    requestAnimationFrame(() => itemTriggerRef.current?.focus());
  }

  useEffect(() => {
    if (!openItem) return;
    requestAnimationFrame(() => {
      itemPanelRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      firstItemFieldRef.current?.focus();
    });
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeItemPanel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openItem]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/production/orders/${orderId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setOrder(j.order);
      setItems(j.items ?? []);
      setEvents(j.events ?? []);
    } catch (e: any) {
      toast({ title: t("production.errorOccurred"), description: e?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [orderId, token, t, toast]);

  useEffect(() => { void load(); }, [load]);

  // Pull warehouses/accounts/items lookup once for the WIP setup panel.
  useEffect(() => {
    if (!token) return;
    const h = { Authorization: `Bearer ${token}` };
    void Promise.all([
      fetch(`${API}/api/inventory/warehouses`, { headers: h }).then((r) => r.ok ? r.json() : []),
      fetch(`${API}/api/accounts?limit=2000`, { headers: h }).then((r) => r.ok ? r.json() : []),
      fetch(`${API}/api/inventory/items?limit=2000`, { headers: h }).then((r) => r.ok ? r.json() : []),
      fetch(`${API}/api/production/work-centers`, { headers: h }).then((r) => r.ok ? r.json() : []),
    ]).then(([whs, accs, its, wcs]) => {
      setWarehouses(Array.isArray(whs) ? whs : (whs?.rows ?? whs?.data ?? []));
      setAccounts(Array.isArray(accs) ? accs : (accs?.rows ?? accs?.data ?? []));
      setItemRefs(Array.isArray(its) ? its : (its?.rows ?? its?.data ?? []));
      setWorkCenters(Array.isArray(wcs) ? wcs : (wcs?.rows ?? []));
    }).catch(() => {});
  }, [token]);

  // Initialize completion form when status reaches quality_check.
  useEffect(() => {
    if (order && order.status === "quality_check" && !completion.producedQty) {
      setCompletion({
        producedQty: order.producedQty && Number(order.producedQty) > 0 ? order.producedQty : order.plannedQty,
        wasteQty: order.wasteQty || "0",
      });
    }
  }, [order?.status]);  // eslint-disable-line react-hooks/exhaustive-deps

  async function transitionTo(target: string, extra: Record<string, unknown> = {}) {
    setTransitioning(true);
    try {
      const r = await fetch(`${API}/api/production/orders/${orderId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: target, ...extra }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      toast({ title: `✓ ${t("production.saved")}` });
      void load();
    } catch (e: any) {
      toast({ title: t("production.errorOccurred"), description: e?.message, variant: "destructive" });
    } finally {
      setTransitioning(false);
    }
  }

  // Save WIP setup (warehouses, accounts, labor/overhead, costCenter).
  async function saveWipSetup(patch: Record<string, unknown>) {
    setSavingWip(true);
    try {
      const r = await fetch(`${API}/api/production/orders/${orderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(patch),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      toast({ title: `✓ ${t("production.saved")}` });
      void load();
    } catch (e: any) {
      toast({ title: t("production.errorOccurred"), description: e?.message, variant: "destructive" });
    } finally {
      setSavingWip(false);
    }
  }

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    setSavingItem(true);
    try {
      const r = await fetch(`${API}/api/production/orders/${orderId}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          kind: itemForm.kind,
          description: itemForm.description.trim(),
          quantity: Number(itemForm.quantity) || 0,
          unitCode: itemForm.unitCode || "PCE",
          unitCost: Number(itemForm.unitCost) || 0,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      toast({ title: `✓ ${t("production.saved")}` });
      setOpenItem(false);
      setItemForm({ kind: "raw", description: "", quantity: "", unitCode: "PCE", unitCost: "" });
      void load();
    } catch (e: any) {
      toast({ title: t("production.errorOccurred"), description: e?.message, variant: "destructive" });
    } finally {
      setSavingItem(false);
    }
  }

  async function deleteItem(lineId: number) {
    if (!confirm(t("production.confirmDelete"))) return;
    try {
      const r = await fetch(`${API}/api/production/orders/${orderId}/items/${lineId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${r.status}`);
      }
      toast({ title: `✓ ${t("production.deleted")}` });
      void load();
    } catch (e: any) {
      toast({ title: t("production.errorOccurred"), description: e?.message, variant: "destructive" });
    }
  }

  if (loading && !order) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (!order) {
    return <div className="p-8 text-center text-slate-500">{t("production.errorOccurred")}</div>;
  }

  const transitions = TRANSITIONS[order.status] ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Link href="/production/orders">
            <Button variant="outline" size="icon" data-testid="btn-back">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold">{order.title}</h1>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONES[order.status]}`}>
                {t(`production.status_${order.status}`)}
              </span>
            </div>
            <div className="text-xs text-slate-500 font-mono">{order.orderNumber}</div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {transitions.map((tr) => (
            <Button
              key={tr.to}
              onClick={() => {
                if (tr.to === "completed") {
                  const pq = Number(completion.producedQty) || 0;
                  const wq = Number(completion.wasteQty) || 0;
                  if (!(pq > 0)) {
                    toast({
                      title: t("production.errorOccurred"),
                      description: "أدخل كمية المنتج المنتَج قبل الإقفال",
                      variant: "destructive",
                    });
                    return;
                  }
                  void transitionTo("completed", { producedQty: pq, wasteQty: wq });
                } else {
                  void transitionTo(tr.to);
                }
              }}
              disabled={transitioning}
              className={`${tr.tone} text-white`}
              data-testid={`btn-status-${tr.to}`}
            >
              <tr.icon className="h-4 w-4 me-1" />
              {t(tr.labelKey)}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <div className="rounded-lg border bg-white dark:bg-slate-900 p-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <Stat label={t("production.plannedQty")} value={`${Number(order.plannedQty).toLocaleString()} ${order.unitCode}`} />
            <Stat label={t("production.producedQty")} value={Number(order.producedQty).toLocaleString()} />
            <Stat label={t("production.wasteQty")} value={Number(order.wasteQty).toLocaleString()} />
            <Stat label={t("production.actualCost")} value={Number(order.actualCost).toLocaleString()} />
            <Stat label="تكلفة الخامات" value={Number(order.rawMaterialsCost).toLocaleString()} />
            <Stat label="أجور الإنتاج" value={Number(order.laborCost).toLocaleString()} />
            <Stat label="تكاليف غير مباشرة" value={Number(order.overheadCost).toLocaleString()} />
            <Stat
              label="القيود المحاسبية"
              value={
                <div className="text-xs flex flex-col gap-0.5">
                  {order.issueJournalEntryId ? (
                    <Link href={`/accounting/journal-entries/${order.issueJournalEntryId}`}>
                      <a className="text-violet-600 hover:underline" data-testid="link-issue-je">
                        صرف #{order.issueJournalEntryId}
                      </a>
                    </Link>
                  ) : (<span className="text-slate-400">لم يُرحّل</span>)}
                  {order.receiptJournalEntryId ? (
                    <Link href={`/accounting/journal-entries/${order.receiptJournalEntryId}`}>
                      <a className="text-emerald-600 hover:underline" data-testid="link-receipt-je">
                        إضافة #{order.receiptJournalEntryId}
                      </a>
                    </Link>
                  ) : (<span className="text-slate-400">لم يُرحّل</span>)}
                </div>
              }
            />
          </div>

          {/* ─── SAP-style WIP setup panel — editable while pre-issue, locked after ─── */}
          <WipSetupPanel
            order={order}
            warehouses={warehouses}
            accounts={accounts}
            itemRefs={itemRefs}
            workCenters={workCenters}
            saving={savingWip}
            onSave={saveWipSetup}
          />

          {/* ─── Completion qty form (visible when ready to close the order) ─── */}
          {(order.status === "in_production" || order.status === "quality_check") && !order.receiptJournalEntryId && (
            <div className="rounded-lg border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/50 dark:bg-emerald-950/10 p-4">
              <div className="text-sm font-semibold text-emerald-700 dark:text-emerald-300 mb-2">
                <Flag className="h-4 w-4 inline me-1" /> كميات الإقفال
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">الكمية المنتَجة (تدخل لمخزن البضاعة التامة)</Label>
                  <Input
                    type="number" step="0.01"
                    value={completion.producedQty}
                    onChange={(e) => setCompletion({ ...completion, producedQty: e.target.value })}
                    data-testid="input-produced-qty" className="mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs">الهالك (تكلفته تذهب لحساب الهالك/الفروق)</Label>
                  <Input
                    type="number" step="0.01"
                    value={completion.wasteQty}
                    onChange={(e) => setCompletion({ ...completion, wasteQty: e.target.value })}
                    data-testid="input-waste-qty" className="mt-1"
                  />
                </div>
              </div>
              <p className="text-xs text-slate-500 mt-2">
                عند الضغط على «إكمال»، توزَّع تكلفة WIP الإجمالية ({Number(order.actualCost).toLocaleString()})
                على الكمية المنتَجة والهالك تناسبيًا.
              </p>
            </div>
          )}

          <Tabs defaultValue="items">
            <TabsList>
              <TabsTrigger value="items" data-testid="tab-items">
                <ListChecks className="h-4 w-4 me-1" /> {t("production.itemsTab")}
              </TabsTrigger>
              <TabsTrigger value="events" data-testid="tab-events">
                <Activity className="h-4 w-4 me-1" /> {t("production.eventsTab")}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="items" className="space-y-3">
              <div className="flex justify-end">
                <Button
                  ref={itemTriggerRef}
                  size="sm"
                  data-testid="btn-add-item"
                  onClick={() => (openItem ? closeItemPanel() : setOpenItem(true))}
                  variant={openItem ? "outline" : "default"}
                  aria-expanded={openItem}
                  aria-controls="panel-add-item"
                >
                  {openItem ? <X className="h-4 w-4 me-1" /> : <Plus className="h-4 w-4 me-1" />}
                  {openItem ? t("common.cancel") : t("production.addItem")}
                </Button>
              </div>
              {openItem && (
                <div
                  ref={itemPanelRef}
                  id="panel-add-item"
                  role="region"
                  aria-label={t("production.addItem")}
                  className="rounded-lg border border-violet-200 dark:border-violet-900/50 bg-gradient-to-br from-violet-50/60 to-fuchsia-50/40 dark:from-violet-950/20 dark:to-fuchsia-950/10 shadow-sm"
                  data-testid="panel-add-item"
                >
                  <div className="flex items-center justify-between px-4 py-2.5 border-b border-violet-200/70 dark:border-violet-900/40">
                    <div className="flex items-center gap-2 text-sm font-semibold text-violet-700 dark:text-violet-300">
                      <Plus className="h-4 w-4" />
                      {t("production.addItem")}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={closeItemPanel}
                      aria-label={t("common.cancel")}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                  <form onSubmit={addItem} className="p-4 space-y-3">
                    <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                      <div className="md:col-span-3">
                        <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("production.itemKind")}</Label>
                        <Select value={itemForm.kind} onValueChange={(v: any) => setItemForm({ ...itemForm, kind: v })}>
                          <SelectTrigger data-testid="select-item-kind" className="mt-1"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="raw">{t("production.kind_raw")}</SelectItem>
                            <SelectItem value="product">{t("production.kind_product")}</SelectItem>
                            <SelectItem value="byproduct">{t("production.kind_byproduct")}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="md:col-span-9">
                        <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("production.description")}</Label>
                        <Input
                          ref={firstItemFieldRef}
                          value={itemForm.description}
                          onChange={(e) => setItemForm({ ...itemForm, description: e.target.value })}
                          required
                          data-testid="input-item-description"
                          className="mt-1"
                        />
                      </div>
                      <div className="md:col-span-4">
                        <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("production.quantity")}</Label>
                        <Input
                          type="number" step="0.01"
                          value={itemForm.quantity}
                          onChange={(e) => setItemForm({ ...itemForm, quantity: e.target.value })}
                          data-testid="input-item-qty"
                          className="mt-1"
                        />
                      </div>
                      <div className="md:col-span-4">
                        <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("production.unitCode")}</Label>
                        <UnitCodeSelect
                          value={itemForm.unitCode}
                          onChange={(v) => setItemForm({ ...itemForm, unitCode: v })}
                          className="mt-1"
                        />
                      </div>
                      <div className="md:col-span-4">
                        <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("production.unitCost")}</Label>
                        <Input
                          type="number" step="0.01"
                          value={itemForm.unitCost}
                          onChange={(e) => setItemForm({ ...itemForm, unitCost: e.target.value })}
                          data-testid="input-item-cost"
                          className="mt-1"
                        />
                      </div>
                    </div>
                    <div className="flex items-center justify-end gap-2 pt-1">
                      <Button type="button" variant="outline" onClick={closeItemPanel}>
                        {t("common.cancel")}
                      </Button>
                      <Button type="submit" disabled={savingItem} data-testid="btn-save-item">
                        {savingItem ? t("common.loading") : t("common.save")}
                      </Button>
                    </div>
                  </form>
                </div>
              )}
              <div className="rounded-lg border bg-white dark:bg-slate-900">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-800">
                    <tr>
                      <th className="text-start p-2">{t("production.itemKind")}</th>
                      <th className="text-start p-2">{t("production.description")}</th>
                      <th className="text-end p-2">{t("production.quantity")}</th>
                      <th className="text-end p-2">{t("production.unitCost")}</th>
                      <th className="text-end p-2">{t("production.actualCost")}</th>
                      <th className="p-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.length === 0 && (
                      <tr><td colSpan={6} className="p-6 text-center text-slate-500">{t("production.noItems")}</td></tr>
                    )}
                    {items.map((it) => (
                      <tr key={it.id} className="border-t" data-testid={`row-item-${it.id}`}>
                        <td className="p-2 text-xs">
                          <span className="rounded bg-slate-100 px-2 py-0.5 dark:bg-slate-800">
                            {t(`production.kind_${it.kind}`)}
                          </span>
                        </td>
                        <td className="p-2">{it.description}</td>
                        <td className="p-2 text-end">{Number(it.quantity).toLocaleString()} {it.unitCode}</td>
                        <td className="p-2 text-end">{Number(it.unitCost).toLocaleString()}</td>
                        <td className="p-2 text-end">{Number(it.totalCost).toLocaleString()}</td>
                        <td className="p-2 text-end">
                          <Button
                            size="sm" variant="ghost"
                            onClick={() => deleteItem(it.id)}
                            data-testid={`btn-del-item-${it.id}`}
                          >
                            <Trash2 className="h-4 w-4 text-red-600" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </TabsContent>
            <TabsContent value="events">
              <div className="rounded-lg border bg-white dark:bg-slate-900 divide-y">
                {events.length === 0 && (
                  <div className="p-6 text-center text-slate-500">{t("production.noEvents")}</div>
                )}
                {events.map((ev) => (
                  <div key={ev.id} className="flex items-center gap-3 p-3" data-testid={`event-${ev.id}`}>
                    <div className={`rounded-full p-1.5 ${ev.byAi ? "bg-violet-100 text-violet-600" : "bg-slate-100 text-slate-600"}`}>
                      {ev.byAi ? <Sparkles className="h-3.5 w-3.5" /> : <Activity className="h-3.5 w-3.5" />}
                    </div>
                    <div className="flex-1">
                      <div className="text-sm font-medium">{ev.eventType}</div>
                      <div className="text-xs text-slate-500">
                        {new Date(ev.createdAt).toLocaleString()} {ev.byAi && <span>· {t("production.byAi")}</span>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </TabsContent>
          </Tabs>
        </div>

        <div className="space-y-4">
          <ProductionAIAssistant
            screenContext="production.orders.detail"
            orderId={orderId}
            currentAction={`viewing order ${order.orderNumber} (${order.status})`}
          />
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-base font-semibold mt-0.5">{value}</div>
    </div>
  );
}

// ─── WIP setup panel ────────────────────────────────────────────────────────
// Lets the user pick the raw + finished warehouses, the 7 GL accounts that
// drive the issue/receipt JEs, and the labor/overhead amounts. Everything
// is locked once the order moves past "approved" because the issue JE has
// already posted against these accounts. Saved via a single PATCH per change.
function WipSetupPanel({
  order, warehouses, accounts, itemRefs, workCenters, saving, onSave,
}: {
  order: Order;
  warehouses: Warehouse[];
  accounts: Account[];
  itemRefs: ItemRef[];
  workCenters: WorkCenterRef[];
  saving: boolean;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const locked = ["in_production", "quality_check", "completed"].includes(order.status);
  const initial = () => ({
    rawWarehouseId: order.rawWarehouseId ?? "",
    finishedWarehouseId: order.finishedWarehouseId ?? "",
    productItemId: order.productItemId ?? "",
    workCenterId: order.workCenterId ?? "",
    plannedHours: order.plannedHours ?? "0",
    actualHours: order.actualHours ?? "0",
    laborCost: order.laborCost ?? "0",
    overheadCost: order.overheadCost ?? "0",
    costCenter: order.costCenter ?? "",
    wipAccountId: order.wipAccountId ?? "",
    rawInventoryAccountId: order.rawInventoryAccountId ?? "",
    finishedGoodsAccountId: order.finishedGoodsAccountId ?? "",
    laborAccountId: order.laborAccountId ?? "",
    overheadAccountId: order.overheadAccountId ?? "",
    varianceAccountId: order.varianceAccountId ?? "",
    wasteAccountId: order.wasteAccountId ?? "",
  });
  const [draft, setDraft] = useState(initial);
  // Re-sync local form whenever the underlying order changes (e.g. after save).
  useEffect(() => {
    setDraft(initial());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.id, order.status, order.issueJournalEntryId, order.receiptJournalEntryId]);

  const set = (k: string, v: unknown) => setDraft((d) => ({ ...d, [k]: v as any }));

  // ─── Phase B — auto-recompute labor/overhead when wc or hours change ──
  // The user can still type-override afterwards (the inputs remain editable).
  // Mirrors the server-side behaviour in PATCH /orders/:id.
  function applyWorkCenter(wcId: number | "", hours: string) {
    const wc = wcId === "" ? null : workCenters.find((w) => w.id === Number(wcId));
    const h = Number(hours) || 0;
    setDraft((d) => {
      const next: any = { ...d, workCenterId: wcId, plannedHours: hours };
      if (wc && h > 0) {
        next.laborCost = String((h * Number(wc.laborRatePerHour)).toFixed(2));
        next.overheadCost = String((h * Number(wc.overheadRatePerHour)).toFixed(2));
      }
      // Auto-fill defaults from the work center when current value is empty.
      if (wc) {
        if (!d.costCenter && wc.costCenterCode) next.costCenter = wc.costCenterCode;
        if (!d.laborAccountId && wc.defaultLaborAccountId)
          next.laborAccountId = wc.defaultLaborAccountId;
        if (!d.overheadAccountId && wc.defaultOverheadAccountId)
          next.overheadAccountId = wc.defaultOverheadAccountId;
      }
      return next;
    });
  }
  const selectedWc = draft.workCenterId === "" ? null : workCenters.find((w) => w.id === Number(draft.workCenterId)) ?? null;
  const isExpense = (a: Account) => a.accountType === "expense" || a.accountType === "cost_of_sales";
  const isAsset = (a: Account) => a.accountType === "asset";
  const isLiab = (a: Account) => a.accountType === "liability";
  const assetAccounts = accounts.filter(isAsset);
  const expenseAccounts = accounts.filter(isExpense);
  const liabAccounts = accounts.filter(isLiab);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = {};
    Object.entries(draft).forEach(([k, v]) => {
      if (v === "" || v === null) payload[k] = null;
      else if (k.endsWith("Cost") || k.endsWith("Hours")) payload[k] = Number(v);
      else if (k.endsWith("Id")) payload[k] = Number(v);
      else payload[k] = v;
    });
    onSave(payload);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg border border-violet-200 dark:border-violet-900/50 bg-gradient-to-br from-violet-50/50 to-fuchsia-50/30 dark:from-violet-950/15 dark:to-fuchsia-950/10 p-4 space-y-3"
      data-testid="panel-wip-setup"
    >
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-violet-700 dark:text-violet-300">
          إعداد دورة الإنتاج (WIP)
        </div>
        {locked && (
          <span className="text-xs rounded bg-amber-100 text-amber-800 px-2 py-0.5">
            مقفلة بعد بدء الإنتاج (ألغِ الأمر للتعديل)
          </span>
        )}
      </div>

      {/* Phase A — context banner: explains where these defaults come from
          and lets the user jump to the company-level settings page. */}
      {locked ? (
        <div className="flex items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-200">
          <span>🔒 هذه القيم محفوظة في قيد الإنتاج المرحَّل ولا يمكن تعديلها بعد بدء الإنتاج.</span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-violet-200 bg-violet-50/60 px-3 py-2 text-xs text-violet-900 dark:border-violet-900/50 dark:bg-violet-950/20 dark:text-violet-200">
          <span className="flex items-center gap-1">
            <Sparkles className="h-3.5 w-3.5" />
            تم التعبئة تلقائياً من <strong>إعدادات التصنيع</strong> — يمكنك تعديل أي قيمة لهذا الأمر فقط دون التأثير على الافتراضيات.
          </span>
          <Link
            href="/production/settings"
            className="font-medium text-violet-700 underline-offset-2 hover:underline dark:text-violet-300"
            data-testid="link-mfg-settings"
          >
            تعديل الإعدادات الافتراضية ←
          </Link>
        </div>
      )}

      {/* المخازن + المنتج النهائي */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Field label="مخزن صرف الخامات">
          <SelectId disabled={locked} value={draft.rawWarehouseId} onChange={(v) => set("rawWarehouseId", v)}
            options={warehouses.map((w) => ({ value: w.id, label: w.name }))} testid="select-raw-warehouse" />
        </Field>
        <Field label="مخزن استلام البضاعة التامة">
          <SelectId value={draft.finishedWarehouseId} onChange={(v) => set("finishedWarehouseId", v)}
            options={warehouses.map((w) => ({ value: w.id, label: w.name }))} testid="select-fg-warehouse" />
        </Field>
        <Field label="صنف المنتج النهائي">
          <SelectId value={draft.productItemId} onChange={(v) => set("productItemId", v)}
            options={itemRefs.map((i) => ({ value: i.id, label: `${i.code} — ${i.nameAr}` }))} testid="select-fg-item" />
        </Field>
      </div>

      {/* Phase B — مركز العمل + الساعات (يحسب الأجور والـOH تلقائياً) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2 border-t border-violet-200/50">
        <Field label="مركز العمل (اختياري)">
          <SelectId
            disabled={locked}
            value={draft.workCenterId}
            onChange={(v) => applyWorkCenter(v as number | "", draft.plannedHours)}
            options={workCenters
              .filter((w) => w.isActive || Number(draft.workCenterId) === w.id)
              .map((w) => ({ value: w.id, label: `${w.code} — ${w.nameAr}` }))}
            testid="select-work-center"
          />
          {selectedWc && (
            <p className="mt-1 text-xs text-violet-700 dark:text-violet-300">
              معدل الأجور: {Number(selectedWc.laborRatePerHour).toLocaleString()} / ساعة
              {" · "}
              OH: {Number(selectedWc.overheadRatePerHour).toLocaleString()} / ساعة
            </p>
          )}
        </Field>
        <Field label="الساعات المخططة">
          <Input
            type="number" step="0.25" min={0} disabled={locked}
            value={draft.plannedHours}
            onChange={(e) => applyWorkCenter(draft.workCenterId as number | "", e.target.value)}
            data-testid="input-planned-hours"
          />
        </Field>
        <Field label="الساعات الفعلية (للمراجعة)">
          <Input
            type="number" step="0.25" min={0}
            value={draft.actualHours}
            onChange={(e) => set("actualHours", e.target.value)}
            data-testid="input-actual-hours"
          />
        </Field>
      </div>

      {/* تكاليف رأسية + مركز التكلفة */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Field label="إجمالي أجور الإنتاج"><Input type="number" step="0.01" disabled={locked}
          value={draft.laborCost} onChange={(e) => set("laborCost", e.target.value)} data-testid="input-labor-cost" /></Field>
        <Field label="إجمالي التكاليف غير المباشرة"><Input type="number" step="0.01" disabled={locked}
          value={draft.overheadCost} onChange={(e) => set("overheadCost", e.target.value)} data-testid="input-overhead-cost" /></Field>
        <Field label="مركز التكلفة (يُطبَّق على القيود)"><Input
          value={draft.costCenter} onChange={(e) => set("costCenter", e.target.value)}
          placeholder="مثال: PROD-A" data-testid="input-cost-center" /></Field>
      </div>

      {/* الحسابات السبعة */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 pt-2 border-t border-violet-200/50">
        <Field label="WIP — إنتاج تحت التشغيل (أصول)">
          <SelectId disabled={locked} value={draft.wipAccountId} onChange={(v) => set("wipAccountId", v)}
            options={assetAccounts.map((a) => ({ value: a.id, label: `${a.code} — ${a.nameAr}` }))} testid="select-wip-acct" />
        </Field>
        <Field label="مخزون الخامات (أصول)">
          <SelectId disabled={locked} value={draft.rawInventoryAccountId} onChange={(v) => set("rawInventoryAccountId", v)}
            options={assetAccounts.map((a) => ({ value: a.id, label: `${a.code} — ${a.nameAr}` }))} testid="select-raw-acct" />
        </Field>
        <Field label="بضاعة تامة الصنع (أصول)">
          <SelectId value={draft.finishedGoodsAccountId} onChange={(v) => set("finishedGoodsAccountId", v)}
            options={assetAccounts.map((a) => ({ value: a.id, label: `${a.code} — ${a.nameAr}` }))} testid="select-fg-acct" />
        </Field>
        <Field label="أجور إنتاج مستحقة (التزامات)">
          <SelectId disabled={locked} value={draft.laborAccountId} onChange={(v) => set("laborAccountId", v)}
            options={liabAccounts.map((a) => ({ value: a.id, label: `${a.code} — ${a.nameAr}` }))} testid="select-labor-acct" />
        </Field>
        <Field label="تكاليف صناعية غير مباشرة (التزامات)">
          <SelectId disabled={locked} value={draft.overheadAccountId} onChange={(v) => set("overheadAccountId", v)}
            options={liabAccounts.map((a) => ({ value: a.id, label: `${a.code} — ${a.nameAr}` }))} testid="select-overhead-acct" />
        </Field>
        <Field label="فروق إنتاج / Variance (مصروفات)">
          <SelectId value={draft.varianceAccountId} onChange={(v) => set("varianceAccountId", v)}
            options={expenseAccounts.map((a) => ({ value: a.id, label: `${a.code} — ${a.nameAr}` }))} testid="select-variance-acct" />
        </Field>
        <Field label="هالك / Waste (مصروفات)">
          <SelectId value={draft.wasteAccountId} onChange={(v) => set("wasteAccountId", v)}
            options={expenseAccounts.map((a) => ({ value: a.id, label: `${a.code} — ${a.nameAr}` }))} testid="select-waste-acct" />
        </Field>
      </div>

      <div className="flex justify-end pt-1">
        <Button type="submit" disabled={saving} data-testid="btn-save-wip">
          {saving ? "جارٍ الحفظ..." : "حفظ إعدادات WIP"}
        </Button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">{label}</Label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function SelectId({
  value, onChange, options, disabled, testid,
}: {
  value: number | string;
  onChange: (v: number | "") => void;
  options: { value: number; label: string }[];
  disabled?: boolean;
  testid?: string;
}) {
  const v = value === "" || value == null ? "__none__" : String(value);
  return (
    <Select value={v} onValueChange={(s) => onChange(s === "__none__" ? "" : Number(s))} disabled={disabled}>
      <SelectTrigger data-testid={testid}><SelectValue placeholder="—" /></SelectTrigger>
      <SelectContent>
        <SelectItem value="__none__">—</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={String(o.value)}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
