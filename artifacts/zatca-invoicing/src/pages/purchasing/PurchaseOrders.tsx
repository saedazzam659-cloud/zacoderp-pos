// Purchase Orders list page — operational, finance-FREE.
// Mirrors the purchase invoices list with order-flavored statuses
// (draft / confirmed / cancelled / converted) and a "convert to invoice"
// action that calls the dedicated /convert endpoint.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search, ClipboardList, Eye, Trash2, CheckCircle, XCircle, FileText, FileCheck2 } from "lucide-react";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function PurchaseOrders() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const fmt = (n: any) => Number(n || 0).toLocaleString(isRtl ? "ar-SA" : "en-US", { minimumFractionDigits: 2 });
  const STATUS: Record<string, { labelKey: string; cls: string }> = {
    draft:     { labelKey: "status.draft",     cls: "bg-amber-50 text-amber-700 border-amber-200" },
    confirmed: { labelKey: "status.confirmed", cls: "bg-blue-50 text-blue-700 border-blue-200" },
    cancelled: { labelKey: "status.cancelled", cls: "bg-muted text-muted-foreground border-border" },
    converted: { labelKey: "status.converted", cls: "bg-green-50 text-green-700 border-green-200" },
  };
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const authH   = { Authorization: `Bearer ${token}` };

  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");

  const { data: orders = [], isLoading } = useQuery<any[]>({
    queryKey: ["purchase-orders", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/purchasing/purchase-orders?companyId=${cid}` : `${API}/api/purchasing/purchase-orders`;
      const res = await fetch(url, { headers: authH }); return res.json();
    },
    enabled: !!user,
  });

  const { data: suppliers = [] } = useQuery<any[]>({
    queryKey: ["suppliers", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/suppliers?companyId=${cid}` : `${API}/api/suppliers`;
      const res = await fetch(url, { headers: authH }); return res.json();
    },
    enabled: !!user,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["purchase-orders"] });

  const statusMut = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) => {
      const res = await fetch(`${API}/api/purchasing/purchase-orders/${id}/status`, {
        method: "PATCH", headers, body: JSON.stringify({ status }),
      });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || "تعذر تحديث الحالة"); }
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: t("purchasingPages.purchaseOrders.toasts.statusUpdated") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const convertMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/purchasing/purchase-orders/${id}/convert`, { method: "POST", headers });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || "تعذر التحويل"); }
      return res.json();
    },
    onSuccess: (j: any) => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["purchase-invoices"] });
      toast({ title: t("purchasingPages.purchaseOrders.toasts.converted"), description: `INV-${j.invoiceId}` });
      navigate(`/purchasing/invoices/${j.invoiceId}`);
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/purchasing/purchase-orders/${id}`, { method: "DELETE", headers });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || "تعذر الحذف"); }
    },
    onSuccess: () => { invalidate(); toast({ title: t("purchasingPages.purchaseOrders.toasts.deleted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const supName = (s: any) => isRtl ? (s?.nameAr ?? s?.nameEn ?? "") : (s?.nameEn ?? s?.nameAr ?? "");
  const supMap = Object.fromEntries(suppliers.map((s: any) => [s.id, supName(s)]));

  const filtered = orders.filter(ord => {
    const q = search.toLowerCase();
    const matchText = !search || (ord.docNumber ?? "").toLowerCase().includes(q) || (supMap[ord.supplierId] ?? "").toLowerCase().includes(q);
    const matchStatus = filterStatus === "all" || ord.status === filterStatus;
    return matchText && matchStatus;
  });

  const totalConfirmed = orders.filter(o => o.status === "confirmed").reduce((s, o) => s + Number(o.totalAmount || 0), 0);

  const cols = [
    t("purchasingPages.purchaseOrders.cols.number"),
    t("purchasingPages.purchaseOrders.cols.date"),
    t("purchasingPages.purchaseOrders.cols.expectedDelivery"),
    t("purchasingPages.purchaseOrders.cols.supplier"),
    t("purchasingPages.purchaseOrders.cols.paymentType"),
    t("purchasingPages.purchaseOrders.cols.currency"),
    t("purchasingPages.purchaseOrders.cols.subtotal"),
    t("purchasingPages.purchaseOrders.cols.vat"),
    t("purchasingPages.purchaseOrders.cols.total"),
    t("purchasingPages.purchaseOrders.cols.invoice"),
    t("purchasingPages.purchaseOrders.cols.status"),
    t("purchasingPages.purchaseOrders.cols.actions"),
  ];

  const statusFilterLabel = (s: string) => {
    if (s === "all") return t("common.all");
    return t(STATUS[s].labelKey);
  };

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ClipboardList className="h-6 w-6 text-primary" />{t("purchasingPages.purchaseOrders.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t("purchasingPages.purchaseOrders.subtitle")}</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => navigate("/purchasing/orders/new")}>
          <Plus className="h-4 w-4" />{t("purchasingPages.purchaseOrders.newOrder")}
        </Button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: t("purchasingPages.purchaseOrders.totalOrders"), value: orders.length, color: "text-primary" },
          { label: t(STATUS.confirmed.labelKey), value: orders.filter(o => o.status === "confirmed").length, color: "text-blue-700" },
          { label: t(STATUS.draft.labelKey),     value: orders.filter(o => o.status === "draft").length,     color: "text-amber-700" },
          { label: t("purchasingPages.purchaseOrders.totalConfirmedValue"), value: `${fmt(totalConfirmed)} ${t("purchasingPages.purchaseOrders.currencyRiyal")}`, color: "text-primary" },
        ].map((c, i) => (
          <div key={i} className="rounded-xl border bg-card p-4 shadow-sm">
            <p className="text-xs text-muted-foreground mb-1">{c.label}</p>
            <p className={cn("text-xl font-bold font-mono", c.color)}>{c.value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-48">
          <Search className={cn("absolute top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground", isRtl ? "right-3" : "left-3")} />
          <Input className={isRtl ? "pr-9" : "pl-9"} placeholder={t("purchasingPages.purchaseOrders.searchPlaceholder")} value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-1">
          {["all", "draft", "confirmed", "converted", "cancelled"].map(s => (
            <button key={s} onClick={() => setFilterStatus(s)}
              className={cn("text-xs rounded-full px-3 py-1 border font-medium transition-colors",
                filterStatus === s ? "bg-primary text-primary-foreground border-primary" : "border-input bg-background hover:bg-muted"
              )}>
              {statusFilterLabel(s)}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
        {isLoading ? (
          <div className="p-12 text-center text-muted-foreground text-sm">{t("common.loading")}</div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center">
            <FileText className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-40" />
            <p className="text-muted-foreground text-sm">{t("purchasingPages.purchaseOrders.noOrders")}</p>
            <Button size="sm" className="mt-4 gap-2" onClick={() => navigate("/purchasing/orders/new")}>
              <Plus className="h-4 w-4" />{t("purchasingPages.purchaseOrders.createFirst")}
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 border-b">
                  {cols.map(h => (
                    <th key={h} className={cn("px-3 py-3 font-semibold text-muted-foreground text-xs", isRtl ? "text-right" : "text-left")}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(ord => {
                  const st = STATUS[ord.status] ?? STATUS.draft;
                  return (
                    <tr key={ord.id} className="border-b hover:bg-muted/30 transition-colors cursor-pointer"
                      onDoubleClick={() => navigate(`/purchasing/orders/${ord.id}`)}
                      title={t("purchasingPages.purchaseOrders.tooltips.openEdit")}>
                      <td className="px-3 py-2.5 font-mono text-xs font-semibold text-primary">
                        {ord.docNumber ?? `PO-${ord.id}`}
                      </td>
                      <td className="px-3 py-2.5">{ord.orderDate}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{ord.expectedDeliveryDate ?? "—"}</td>
                      <td className="px-3 py-2.5">{supMap[ord.supplierId] ?? "—"}</td>
                      <td className="px-3 py-2.5 text-muted-foreground text-xs">
                        {ord.paymentType === "cash"
                          ? t("purchasingPages.purchaseOrders.paymentCash")
                          : ord.paymentType === "bank"
                            ? t("purchasingPages.purchaseOrders.paymentBank")
                            : t("purchasingPages.purchaseOrders.paymentCredit")}
                      </td>
                      <td className="px-3 py-2.5">{ord.currencyCode}</td>
                      <td className="px-3 py-2.5 font-mono">{fmt(ord.subtotal)}</td>
                      <td className="px-3 py-2.5 font-mono text-amber-700">{fmt(ord.vatAmount)}</td>
                      <td className="px-3 py-2.5 font-mono font-semibold">{fmt(ord.totalAmount)}</td>
                      <td className="px-3 py-2.5 font-mono text-xs">
                        {ord.convertedInvoiceId ? (
                          <button
                            type="button"
                            className="text-blue-700 hover:text-blue-900 hover:underline font-semibold"
                            title={t("purchasingPages.purchaseOrders.tooltips.openInvoice")}
                            onClick={() => navigate(`/purchasing/invoices/${ord.convertedInvoiceId}`)}>
                            INV-{ord.convertedInvoiceId}
                          </button>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={cn("text-xs rounded-full px-2 py-0.5 font-medium border", st.cls)}>{t(st.labelKey)}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" className="h-7 w-7" title={t("purchasingPages.purchaseOrders.tooltips.viewEdit")}
                            onClick={() => navigate(`/purchasing/orders/${ord.id}`)}>
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                          {ord.status === "draft" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-blue-700 hover:bg-blue-50"
                              title={t("purchasingPages.purchaseOrders.tooltips.confirm")}
                              onClick={() => statusMut.mutate({ id: ord.id, status: "confirmed" })}>
                              <CheckCircle className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {ord.status === "draft" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-red-700 hover:bg-red-50"
                              title={t("purchasingPages.purchaseOrders.tooltips.cancel")}
                              onClick={() => { if (confirm(t("purchasingPages.purchaseOrders.confirms.cancel"))) statusMut.mutate({ id: ord.id, status: "cancelled" }); }}>
                              <XCircle className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {ord.status === "confirmed" && !ord.convertedInvoiceId && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-green-700 hover:bg-green-50"
                              title={t("purchasingPages.purchaseOrders.tooltips.convert")}
                              onClick={() => { if (confirm(t("purchasingPages.purchaseOrders.confirms.convert"))) convertMut.mutate(ord.id); }}>
                              <FileCheck2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {/* Delete only available while still mutable (draft / confirmed). */}
                          {ord.status !== "converted" && ord.status !== "cancelled" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive"
                              title={t("purchasingPages.purchaseOrders.tooltips.delete")}
                              onClick={() => { if (confirm(t("purchasingPages.purchaseOrders.confirms.delete"))) deleteMut.mutate(ord.id); }}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
