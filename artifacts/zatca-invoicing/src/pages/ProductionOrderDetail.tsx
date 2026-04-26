import { useEffect, useState, useCallback } from "react";
import { useParams, Link } from "wouter";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft, Plus, Trash2, Activity, ListChecks, Sparkles,
  CheckCircle2, PlayCircle, ClipboardCheck, Flag, Ban,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import ProductionAIAssistant from "@/components/ProductionAIAssistant";

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
  const [itemForm, setItemForm] = useState({
    kind: "raw" as Item["kind"],
    description: "",
    quantity: "",
    unitCode: "PCE",
    unitCost: "",
  });

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

  async function transitionTo(target: string) {
    setTransitioning(true);
    try {
      const r = await fetch(`${API}/api/production/orders/${orderId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: target }),
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
              onClick={() => transitionTo(tr.to)}
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
          </div>

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
                <Dialog open={openItem} onOpenChange={setOpenItem}>
                  <DialogTrigger asChild>
                    <Button size="sm" data-testid="btn-add-item">
                      <Plus className="h-4 w-4 me-1" />{t("production.addItem")}
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>{t("production.addItem")}</DialogTitle>
                    </DialogHeader>
                    <form onSubmit={addItem} className="space-y-3">
                      <div>
                        <Label>{t("production.itemKind")}</Label>
                        <Select value={itemForm.kind} onValueChange={(v: any) => setItemForm({ ...itemForm, kind: v })}>
                          <SelectTrigger data-testid="select-item-kind"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="raw">{t("production.kind_raw")}</SelectItem>
                            <SelectItem value="product">{t("production.kind_product")}</SelectItem>
                            <SelectItem value="byproduct">{t("production.kind_byproduct")}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label>{t("production.description")}</Label>
                        <Input
                          value={itemForm.description}
                          onChange={(e) => setItemForm({ ...itemForm, description: e.target.value })}
                          required
                          data-testid="input-item-description"
                        />
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <Label>{t("production.quantity")}</Label>
                          <Input
                            type="number" step="0.01"
                            value={itemForm.quantity}
                            onChange={(e) => setItemForm({ ...itemForm, quantity: e.target.value })}
                            data-testid="input-item-qty"
                          />
                        </div>
                        <div>
                          <Label>{t("production.unitCode")}</Label>
                          <Input
                            value={itemForm.unitCode}
                            onChange={(e) => setItemForm({ ...itemForm, unitCode: e.target.value })}
                          />
                        </div>
                        <div>
                          <Label>{t("production.unitCost")}</Label>
                          <Input
                            type="number" step="0.01"
                            value={itemForm.unitCost}
                            onChange={(e) => setItemForm({ ...itemForm, unitCost: e.target.value })}
                            data-testid="input-item-cost"
                          />
                        </div>
                      </div>
                      <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => setOpenItem(false)}>
                          {t("common.cancel")}
                        </Button>
                        <Button type="submit" disabled={savingItem} data-testid="btn-save-item">
                          {savingItem ? t("common.loading") : t("common.save")}
                        </Button>
                      </DialogFooter>
                    </form>
                  </DialogContent>
                </Dialog>
              </div>
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
