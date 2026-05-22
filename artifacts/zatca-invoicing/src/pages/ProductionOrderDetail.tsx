import { useEffect, useState, useCallback, useRef } from "react";
import { useRefetchOnFocus } from "@/hooks/useRefetchOnFocus";
import { useParams, Link } from "wouter";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft, Plus, Trash2, Activity, ListChecks, Sparkles,
  CheckCircle2, PlayCircle, ClipboardCheck, Flag, Ban, X,
  QrCode, AlertTriangle, Printer,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SearchCombobox } from "@/components/ui/search-combobox";
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
  // ─── Phase D — batch / QR / FG expiry ───
  batchNumber: string | null;
  qrToken: string | null;
  fgExpiryDate: string | null;
};
type WasteRecord = {
  id: number;
  wasteType: string;
  reason: string | null;
  qty: string;
  unitCode: string;
  costImpact: string;
  stageId: number | null;
  resourceId: number | null;
  workCenterId: number | null;
  operatorUserId: number | null;
  notes: string | null;
  createdAt: string;
};
type Warehouse = { id: number; code?: string | null; nameAr: string; nameEn?: string | null };
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
  const [completion, setCompletion] = useState({ producedQty: "", wasteQty: "", fgExpiryDate: "" });
  const [wasteRecords, setWasteRecords] = useState<WasteRecord[]>([]);
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
      setWasteRecords(j.wasteRecords ?? []);
    } catch (e: any) {
      toast({ title: t("production.errorOccurred"), description: e?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [orderId, token, t, toast]);

  useEffect(() => { void load(); }, [load]);

  // Pull warehouses/accounts/items/work-centers lookup for the WIP setup panel.
  // Wrapped in useCallback + useRefetchOnFocus so newly-added items, warehouses
  // or accounts from other screens appear here without a manual refresh.
  const loadLookups = useCallback(async () => {
    if (!token) return;
    const h = { Authorization: `Bearer ${token}` };
    try {
      const [whs, accs, its, wcs] = await Promise.all([
        fetch(`${API}/api/inventory/warehouses`, { headers: h }).then((r) => r.ok ? r.json() : []),
        fetch(`${API}/api/accounts?limit=2000`, { headers: h }).then((r) => r.ok ? r.json() : []),
        fetch(`${API}/api/inventory/items?limit=2000`, { headers: h }).then((r) => r.ok ? r.json() : []),
        fetch(`${API}/api/production/work-centers`, { headers: h }).then((r) => r.ok ? r.json() : []),
      ]);
      setWarehouses(Array.isArray(whs) ? whs : (whs?.rows ?? whs?.data ?? []));
      setAccounts(Array.isArray(accs) ? accs : (accs?.rows ?? accs?.data ?? []));
      setItemRefs(Array.isArray(its) ? its : (its?.rows ?? its?.data ?? []));
      setWorkCenters(Array.isArray(wcs) ? wcs : (wcs?.rows ?? []));
    } catch {
      /* silent */
    }
  }, [token]);
  useEffect(() => { void loadLookups(); }, [loadLookups]);
  useRefetchOnFocus(loadLookups);

  // Initialize completion form when status reaches quality_check.
  useEffect(() => {
    if (order && order.status === "quality_check" && !completion.producedQty) {
      setCompletion({
        producedQty: order.producedQty && Number(order.producedQty) > 0 ? order.producedQty : order.plannedQty,
        wasteQty: order.wasteQty || "0",
        fgExpiryDate: order.fgExpiryDate ?? "",
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
                  void transitionTo("completed", {
                    producedQty: pq,
                    wasteQty: wq,
                    ...(completion.fgExpiryDate ? { fgExpiryDate: completion.fgExpiryDate } : {}),
                  });
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

          {/* ─── Phase D — Batch + QR code banner (visible after issue) ─── */}
          {order.batchNumber && (
            <BatchQrBanner
              batchNumber={order.batchNumber}
              qrToken={order.qrToken}
              fgExpiryDate={order.fgExpiryDate}
              orderNumber={order.orderNumber}
              productTitle={order.title}
            />
          )}

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
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
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
                {/* PHASE D — Optional FG expiry stamped on the receipt batch */}
                <div>
                  <Label className="text-xs">تاريخ انتهاء البضاعة التامة (اختياري)</Label>
                  <Input
                    type="date"
                    value={completion.fgExpiryDate}
                    onChange={(e) => setCompletion({ ...completion, fgExpiryDate: e.target.value })}
                    data-testid="input-fg-expiry" className="mt-1"
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
              <TabsTrigger value="quality" data-testid="tab-quality">
                <ClipboardCheck className="h-4 w-4 me-1" /> مراقبة الجودة
              </TabsTrigger>
              <TabsTrigger value="waste" data-testid="tab-waste">
                <AlertTriangle className="h-4 w-4 me-1" /> التالف المفصّل
                {wasteRecords.length > 0 && (
                  <span className="ms-1 rounded-full bg-rose-100 text-rose-700 px-1.5 py-0.5 text-[10px] font-semibold dark:bg-rose-900/40 dark:text-rose-300">
                    {wasteRecords.length}
                  </span>
                )}
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
                        <div className="mt-1">
                          <SearchCombobox
                            value={itemForm.kind}
                            onValueChange={(v) => setItemForm({ ...itemForm, kind: (v || "raw") as any })}
                            items={[
                              { value: "raw", label: t("production.kind_raw") },
                              { value: "product", label: t("production.kind_product") },
                              { value: "byproduct", label: t("production.kind_byproduct") },
                            ]}
                            searchPlaceholder="ابحث…"
                          />
                        </div>
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
            <TabsContent value="quality">
              <div className="rounded-lg border bg-white dark:bg-slate-900 p-4 text-center space-y-3">
                <ClipboardCheck className="h-10 w-10 mx-auto text-emerald-600 opacity-70" />
                <div className="text-sm text-slate-600 dark:text-slate-300">
                  سجّل وراجع فحوصات الجودة الخاصة بهذا الأمر (بصري، وزن، أبعاد، كاميرا ذكية...)
                </div>
                <a
                  href="/production/quality"
                  className="inline-flex items-center gap-2 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm px-4 py-2"
                  data-testid="link-open-quality"
                >
                  <ClipboardCheck className="h-4 w-4" />
                  افتح مراقبة الجودة
                </a>
              </div>
            </TabsContent>
            <TabsContent value="waste" className="space-y-3">
              <WasteRecordsTab
                orderId={orderId}
                token={token ?? ""}
                records={wasteRecords}
                onReload={load}
                workCenters={workCenters}
                disabled={order.status === "draft" || order.status === "cancelled"}
              />
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
  const [aiBusy, setAiBusy] = useState(false);
  const [aiReasons, setAiReasons] = useState<Record<string, string>>({});
  const { token: aiToken } = useAuth() as any;
  const { toast: aiToast } = useToast();
  // Re-sync local form whenever the underlying order changes (e.g. after save).
  useEffect(() => {
    setDraft(initial());
    setAiReasons({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.id, order.status, order.issueJournalEntryId, order.receiptJournalEntryId]);

  const set = (k: string, v: unknown) => setDraft((d) => ({ ...d, [k]: v as any }));

  // ─── AI auto-fill: pulls suggestions from /manufacturing-settings/ai-suggest
  // and fills only the fields that are still empty (never overrides user input
  // or locked values). Mirrors the patterns used on /production/settings.
  async function aiFill() {
    if (locked || aiBusy) return;
    setAiBusy(true);
    try {
      const r = await fetch(`${API}/api/production/manufacturing-settings/ai-suggest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${aiToken}` },
        body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      const sug = j.suggestions ?? {};
      const reasons: Record<string, string> = {};
      let filled = 0;
      // Map AI keys → draft keys (only fill empty draft slots)
      const accountMap: Array<[string, string]> = [
        ["defaultWipAccountId", "wipAccountId"],
        ["defaultRawInventoryAccountId", "rawInventoryAccountId"],
        ["defaultFinishedGoodsAccountId", "finishedGoodsAccountId"],
        ["defaultLaborAccountId", "laborAccountId"],
        ["defaultOverheadAccountId", "overheadAccountId"],
        ["defaultVarianceAccountId", "varianceAccountId"],
        ["defaultWasteAccountId", "wasteAccountId"],
        ["defaultRawWarehouseId", "rawWarehouseId"],
        ["defaultFinishedWarehouseId", "finishedWarehouseId"],
      ];
      setDraft((d) => {
        const next: any = { ...d };
        for (const [aiKey, draftKey] of accountMap) {
          const v = sug[aiKey];
          if (v?.reason) reasons[draftKey] = v.reason;
          if (v && typeof v.id === "number" && (next[draftKey] === "" || next[draftKey] == null)) {
            next[draftKey] = v.id;
            filled++;
          }
        }
        const cc = sug.defaultCostCenter;
        if (cc?.reason) reasons.costCenter = cc.reason;
        if (cc && typeof cc.code === "string" && cc.code && !next.costCenter) {
          next.costCenter = cc.code;
          filled++;
        }
        return next;
      });
      setAiReasons(reasons);
      aiToast({
        title: filled > 0 ? `✓ تم تعبئة ${filled} حقول بالذكاء الاصطناعي` : "كل الحقول معبّأة مسبقاً",
        description: filled > 0
          ? "راجع القيم المقترحة ثم اضغط (حفظ إعدادات WIP)."
          : "لم يبقَ أي حقل فارغ ليتم تعبئته. عدّل يدوياً ثم احفظ.",
      });
    } catch (e: any) {
      aiToast({ title: "خطأ", description: e?.message ?? "فشل اقتراح الذكاء الاصطناعي", variant: "destructive" });
    } finally {
      setAiBusy(false);
    }
  }

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
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold text-violet-700 dark:text-violet-300">
          إعداد دورة الإنتاج (WIP)
        </div>
        <div className="flex items-center gap-2">
          {!locked && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={aiFill}
              disabled={aiBusy || saving}
              data-testid="btn-ai-fill-wip"
              className="border-violet-300 text-violet-700 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-300"
            >
              <Sparkles className={`h-3.5 w-3.5 me-1 ${aiBusy ? "animate-pulse" : ""}`} />
              {aiBusy ? "جارٍ التحليل…" : "املأ بالذكاء الاصطناعي"}
            </Button>
          )}
          {locked && (
            <span className="text-xs rounded bg-amber-100 text-amber-800 px-2 py-0.5">
              مقفلة بعد بدء الإنتاج (ألغِ الأمر للتعديل)
            </span>
          )}
        </div>
      </div>
      {Object.keys(aiReasons).length > 0 && !locked && (
        <details className="rounded-md border border-violet-200 bg-violet-50/60 px-3 py-2 text-xs text-violet-900 dark:border-violet-900/50 dark:bg-violet-950/20 dark:text-violet-200" open>
          <summary className="cursor-pointer font-medium flex items-center gap-1">
            <Sparkles className="h-3 w-3" /> أسباب اقتراحات الذكاء الاصطناعي
          </summary>
          <ul className="mt-2 space-y-1 list-disc ps-5">
            {Object.entries(aiReasons).map(([k, v]) => (
              <li key={k}><span className="font-semibold">{k}:</span> {v}</li>
            ))}
          </ul>
        </details>
      )}

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
            options={warehouses.map((w) => ({ value: w.id, label: w.code ? `${w.code} — ${w.nameAr}` : w.nameAr }))} testid="select-raw-warehouse" />
        </Field>
        <Field label="مخزن استلام البضاعة التامة">
          <SelectId value={draft.finishedWarehouseId} onChange={(v) => set("finishedWarehouseId", v)}
            options={warehouses.map((w) => ({ value: w.id, label: w.code ? `${w.code} — ${w.nameAr}` : w.nameAr }))} testid="select-fg-warehouse" />
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

// ─────────────────────────────────────────────────────────────────────────
// PHASE D — Batch + QR banner shown once production has started
// ─────────────────────────────────────────────────────────────────────────
function BatchQrBanner({
  batchNumber,
  qrToken,
  fgExpiryDate,
  orderNumber,
  productTitle,
}: {
  batchNumber: string;
  qrToken: string | null;
  fgExpiryDate: string | null;
  orderNumber: string;
  productTitle: string;
}) {
  // QR payload: a structured JSON the warehouse/QC scanner can parse to
  // resolve the production order without hitting the search box.
  const payload = JSON.stringify({
    type: "production_batch",
    batch: batchNumber,
    token: qrToken,
    order: orderNumber,
    expiry: fgExpiryDate ?? null,
  });
  const print = () => {
    const w = window.open("", "_blank", "width=420,height=560");
    if (!w) return;
    w.document.write(`
      <html dir="rtl" lang="ar"><head><title>ملصق التشغيلة ${batchNumber}</title>
      <style>
        body{font-family:Arial,sans-serif;text-align:center;padding:14px;}
        h2{margin:6px 0;font-size:18px}
        .num{font-family:monospace;font-size:13px;color:#444}
        .exp{font-size:13px;color:#a00;margin-top:6px}
        svg{margin:8px auto}
      </style></head><body>
        <h2>${productTitle}</h2>
        <div class="num">${orderNumber} — ${batchNumber}</div>
        ${document.getElementById(`qr-${batchNumber}`)?.outerHTML ?? ""}
        ${fgExpiryDate ? `<div class="exp">انتهاء الصلاحية: ${fgExpiryDate}</div>` : ""}
        <script>window.onload=()=>{window.print();setTimeout(()=>window.close(),400)}<\/script>
      </body></html>`);
    w.document.close();
  };
  return (
    <div
      className="rounded-lg border border-sky-200 dark:border-sky-900/50 bg-gradient-to-br from-sky-50 to-cyan-50/40 dark:from-sky-950/20 dark:to-cyan-950/10 p-4 flex flex-wrap items-center gap-4"
      data-testid="banner-batch-qr"
    >
      <div className="shrink-0 bg-white p-2 rounded-md border border-sky-200">
        <QRCodeSVG
          id={`qr-${batchNumber}`}
          value={payload}
          size={96}
          level="M"
          includeMargin={false}
        />
      </div>
      <div className="flex-1 min-w-[200px] space-y-1">
        <div className="flex items-center gap-2 text-sm font-semibold text-sky-700 dark:text-sky-300">
          <QrCode className="h-4 w-4" /> رقم التشغيلة (Batch)
        </div>
        <div className="font-mono text-lg font-bold text-slate-800 dark:text-slate-100" data-testid="text-batch-number">
          {batchNumber}
        </div>
        {fgExpiryDate && (
          <div className="text-xs text-rose-700 dark:text-rose-300">
            انتهاء الصلاحية: <span className="font-semibold">{fgExpiryDate}</span>
          </div>
        )}
        <div className="text-[11px] text-slate-500">
          امسح الـQR من جهاز المخزن لربط البضاعة التامة بالتشغيلة تلقائياً.
        </div>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={print} data-testid="btn-print-batch-label">
        <Printer className="h-3.5 w-3.5 me-1" /> طباعة ملصق
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// PHASE D — Detailed waste-records panel (per production order)
// ─────────────────────────────────────────────────────────────────────────
const WASTE_TYPES: { value: string; labelAr: string; tone: string }[] = [
  { value: "burn", labelAr: "احتراق", tone: "bg-orange-100 text-orange-800" },
  { value: "break", labelAr: "كسر", tone: "bg-rose-100 text-rose-800" },
  { value: "deform", labelAr: "تشوّه/عيب شكل", tone: "bg-amber-100 text-amber-800" },
  { value: "packaging_error", labelAr: "خطأ تغليف", tone: "bg-yellow-100 text-yellow-800" },
  { value: "quality", labelAr: "رفض الجودة", tone: "bg-red-100 text-red-800" },
  { value: "overweight", labelAr: "زيادة وزن", tone: "bg-blue-100 text-blue-800" },
  { value: "underweight", labelAr: "نقص وزن", tone: "bg-indigo-100 text-indigo-800" },
  { value: "contamination", labelAr: "تلوث", tone: "bg-fuchsia-100 text-fuchsia-800" },
  { value: "other", labelAr: "أخرى", tone: "bg-slate-100 text-slate-700" },
];

function WasteRecordsTab({
  orderId,
  token,
  records,
  onReload,
  workCenters,
  disabled,
}: {
  orderId: number;
  token: string;
  records: WasteRecord[];
  onReload: () => Promise<void> | void;
  workCenters: WorkCenterRef[];
  disabled: boolean;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    wasteType: "break",
    qty: "",
    unitCode: "PCE",
    costImpact: "",
    workCenterId: "" as number | "",
    reason: "",
    notes: "",
  });

  function reset() {
    setForm({ wasteType: "break", qty: "", unitCode: "PCE", costImpact: "", workCenterId: "", reason: "", notes: "" });
    setOpen(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.qty || Number(form.qty) <= 0) {
      toast({ title: "خطأ", description: "أدخل كمية أكبر من صفر", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const r = await fetch(`${API}/api/production/orders/${orderId}/waste-records`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          wasteType: form.wasteType,
          qty: Number(form.qty),
          unitCode: form.unitCode || "PCE",
          costImpact: Number(form.costImpact) || 0,
          workCenterId: form.workCenterId === "" ? null : Number(form.workCenterId),
          reason: form.reason.trim() || null,
          notes: form.notes.trim() || null,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      toast({ title: "✓ تم تسجيل التالف" });
      reset();
      await onReload();
    } catch (err: any) {
      toast({ title: "خطأ", description: err?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: number) {
    if (!confirm("حذف سجل التالف؟")) return;
    try {
      const r = await fetch(`${API}/api/production/orders/${orderId}/waste-records/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${r.status}`);
      }
      toast({ title: "✓ تم الحذف" });
      await onReload();
    } catch (err: any) {
      toast({ title: "خطأ", description: err?.message, variant: "destructive" });
    }
  }

  // Aggregate stats for the summary tiles.
  const summary = records.reduce<Record<string, { qty: number; cost: number; count: number }>>((acc, r) => {
    const k = r.wasteType;
    const cur = acc[k] ?? { qty: 0, cost: 0, count: 0 };
    cur.qty += Number(r.qty);
    cur.cost += Number(r.costImpact);
    cur.count += 1;
    acc[k] = cur;
    return acc;
  }, {});
  const totalQty = records.reduce((s, r) => s + Number(r.qty), 0);
  const totalCost = records.reduce((s, r) => s + Number(r.costImpact), 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-slate-600 dark:text-slate-300">
          سجلّات التالف التفصيلية لهذا الأمر (مستقلة عن إجمالي الهالك في الإقفال — تساعد على التحليل بنوع السبب).
        </div>
        {!disabled && (
          <Button
            size="sm"
            data-testid="btn-add-waste"
            onClick={() => setOpen((o) => !o)}
            variant={open ? "outline" : "default"}
          >
            {open ? <X className="h-4 w-4 me-1" /> : <Plus className="h-4 w-4 me-1" />}
            {open ? "إلغاء" : "إضافة سجل تالف"}
          </Button>
        )}
      </div>

      {/* By-type tiles */}
      {records.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
          {WASTE_TYPES.filter((t) => summary[t.value]).map((t) => (
            <div
              key={t.value}
              className="rounded-lg border bg-white dark:bg-slate-900 p-2.5"
              data-testid={`tile-waste-${t.value}`}
            >
              <div className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${t.tone}`}>
                {t.labelAr}
              </div>
              <div className="mt-1 text-sm font-bold text-slate-800 dark:text-slate-100">
                {summary[t.value].qty.toLocaleString()}
              </div>
              <div className="text-[11px] text-slate-500">
                {summary[t.value].count} سجل · {summary[t.value].cost.toLocaleString()} ر.س
              </div>
            </div>
          ))}
          <div className="rounded-lg border border-slate-300 bg-slate-50 dark:bg-slate-800/50 p-2.5">
            <div className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">الإجمالي</div>
            <div className="mt-1 text-sm font-bold">{totalQty.toLocaleString()}</div>
            <div className="text-[11px] text-slate-500">{totalCost.toLocaleString()} ر.س</div>
          </div>
        </div>
      )}

      {/* Add-form */}
      {open && !disabled && (
        <form
          onSubmit={submit}
          className="rounded-lg border border-rose-200 dark:border-rose-900/50 bg-rose-50/40 dark:bg-rose-950/10 p-3 space-y-3"
          data-testid="form-waste"
        >
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Field label="نوع التالف">
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={form.wasteType}
                onChange={(e) => setForm({ ...form, wasteType: e.target.value })}
                data-testid="select-waste-type"
              >
                {WASTE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.labelAr}</option>
                ))}
              </select>
            </Field>
            <Field label="الكمية">
              <Input
                type="number" step="0.01" min={0}
                value={form.qty}
                onChange={(e) => setForm({ ...form, qty: e.target.value })}
                data-testid="input-waste-qty-rec"
              />
            </Field>
            <Field label="الوحدة">
              <Input
                value={form.unitCode}
                onChange={(e) => setForm({ ...form, unitCode: e.target.value })}
                data-testid="input-waste-unit"
              />
            </Field>
            <Field label="التكلفة (ر.س) — اختياري">
              <Input
                type="number" step="0.01" min={0}
                value={form.costImpact}
                onChange={(e) => setForm({ ...form, costImpact: e.target.value })}
                data-testid="input-waste-cost"
              />
            </Field>
            <Field label="مركز العمل (اختياري)">
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={form.workCenterId === "" ? "" : String(form.workCenterId)}
                onChange={(e) => setForm({ ...form, workCenterId: e.target.value === "" ? "" : Number(e.target.value) })}
                data-testid="select-waste-wc"
              >
                <option value="">—</option>
                {workCenters.filter((w) => w.isActive).map((w) => (
                  <option key={w.id} value={w.id}>{w.code} — {w.nameAr}</option>
                ))}
              </select>
            </Field>
            <Field label="السبب المختصر">
              <Input
                value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                placeholder="مثال: ارتفاع حرارة الفرن"
                data-testid="input-waste-reason"
              />
            </Field>
          </div>
          <Field label="ملاحظات (اختياري)">
            <Input
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              data-testid="input-waste-notes"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={reset} disabled={saving}>إلغاء</Button>
            <Button type="submit" size="sm" disabled={saving} data-testid="btn-save-waste">
              {saving ? "جارٍ الحفظ…" : "حفظ"}
            </Button>
          </div>
        </form>
      )}

      {/* Records table */}
      {records.length === 0 ? (
        <div className="rounded-lg border bg-white dark:bg-slate-900 p-6 text-center text-sm text-slate-500">
          لا توجد سجلّات تالف بعد.
        </div>
      ) : (
        <div className="rounded-lg border bg-white dark:bg-slate-900 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/50 text-xs">
              <tr>
                <th className="text-start px-3 py-2">النوع</th>
                <th className="text-start px-3 py-2">الكمية</th>
                <th className="text-start px-3 py-2">التكلفة</th>
                <th className="text-start px-3 py-2">السبب</th>
                <th className="text-start px-3 py-2">التاريخ</th>
                <th className="px-3 py-2 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => {
                const t = WASTE_TYPES.find((x) => x.value === r.wasteType);
                return (
                  <tr key={r.id} className="border-t" data-testid={`row-waste-${r.id}`}>
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${t?.tone ?? "bg-slate-100"}`}>
                        {t?.labelAr ?? r.wasteType}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-medium">{Number(r.qty).toLocaleString()} {r.unitCode}</td>
                    <td className="px-3 py-2">{Number(r.costImpact).toLocaleString()}</td>
                    <td className="px-3 py-2 text-xs text-slate-600">{r.reason ?? "—"}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">
                      {new Date(r.createdAt).toLocaleString("ar-SA")}
                    </td>
                    <td className="px-3 py-2">
                      {!disabled && (
                        <Button
                          size="icon" variant="ghost" className="h-7 w-7 text-rose-600"
                          onClick={() => remove(r.id)}
                          data-testid={`btn-delete-waste-${r.id}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
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

function SelectId({
  value, onChange, options, disabled, testid,
}: {
  value: number | string;
  onChange: (v: number | "") => void;
  options: { value: number; label: string }[];
  disabled?: boolean;
  testid?: string;
}) {
  const v = value === "" || value == null ? "" : String(value);
  return (
    <div data-testid={testid}>
      <SearchCombobox
        value={v}
        onValueChange={(s) => onChange(s === "" ? "" : Number(s))}
        disabled={disabled}
        placeholder="—"
        searchPlaceholder="ابحث…"
        items={[
          { value: "", label: "—" },
          ...options.map((o) => ({ value: String(o.value), label: o.label })),
        ]}
      />
    </div>
  );
}
