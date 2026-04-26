import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Link, useLocation } from "wouter";
import { Plus, Search, Factory, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import ProductionAIAssistant from "@/components/ProductionAIAssistant";

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
  const [form, setForm] = useState({
    title: "",
    plannedQty: "",
    unitCode: "PCE",
    notes: "",
  });

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
          plannedQty: Number(form.plannedQty) || 0,
          unitCode: form.unitCode || "PCE",
          notes: form.notes || null,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      toast({ title: `✓ ${t("production.saved")}` });
      setOpenCreate(false);
      setForm({ title: "", plannedQty: "", unitCode: "PCE", notes: "" });
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
        <Dialog open={openCreate} onOpenChange={setOpenCreate}>
          <DialogTrigger asChild>
            <Button data-testid="btn-new-order">
              <Plus className="h-4 w-4 me-1" />
              {t("production.newOrder")}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("production.newOrder")}</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-3">
              <div>
                <Label>{t("production.title_field")}</Label>
                <Input
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  required
                  data-testid="input-title"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>{t("production.plannedQty")}</Label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    value={form.plannedQty}
                    onChange={(e) => setForm({ ...form, plannedQty: e.target.value })}
                    data-testid="input-planned-qty"
                  />
                </div>
                <div>
                  <Label>{t("production.unitCode")}</Label>
                  <Input
                    value={form.unitCode}
                    onChange={(e) => setForm({ ...form, unitCode: e.target.value })}
                    data-testid="input-unit-code"
                  />
                </div>
              </div>
              <div>
                <Label>{t("production.notes")}</Label>
                <Input
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  data-testid="input-notes"
                />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpenCreate(false)}>
                  {t("common.cancel")}
                </Button>
                <Button type="submit" disabled={creating} data-testid="btn-create-order">
                  {creating ? t("common.loading") : t("common.save")}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

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
            <Select value={statusFilter || "__all__"} onValueChange={(v) => setStatusFilter(v === "__all__" ? "" : v)}>
              <SelectTrigger className="w-48" data-testid="select-status-filter">
                <SelectValue placeholder={t("production.filterAll")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">{t("production.filterAll")}</SelectItem>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(`production.status_${s}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

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
                  <tr key={o.id} className="border-t hover:bg-slate-50 dark:hover:bg-slate-800/50" data-testid={`row-order-${o.id}`}>
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
