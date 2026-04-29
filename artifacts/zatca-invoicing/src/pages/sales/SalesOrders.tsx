import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useFormatters } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Plus, Search, ClipboardList, Eye, Trash2, FileText,
  ArrowRightLeft, CheckCircle, XCircle, Printer,
} from "lucide-react";
import { cn } from "@/lib/utils";
import SalesPrintModal from "./SalesPrintModal";
import { TablePagination, usePagination } from "@/components/TablePagination";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// Order statuses are intentionally narrower than invoices: an order has no
// "posted" state because saving an order produces ZERO accounting entries.
// Lifecycle: draft → confirmed → converted (terminal) | cancelled (terminal)
const STATUS_CLS: Record<string, string> = {
  draft:     "bg-amber-50 text-amber-700 border-amber-200",
  confirmed: "bg-green-50 text-green-700 border-green-200",
  converted: "bg-primary/10 text-primary border-primary/30",
  cancelled: "bg-muted text-muted-foreground border-border",
};

export default function SalesOrders() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const { t } = useTranslation();
  const { fmt } = useFormatters();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const authH   = { Authorization: `Bearer ${token}` };

  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [printData, setPrintData] = useState<any>(null);
  const [autoPrintOnOpen, setAutoPrintOnOpen] = useState(false);

  async function openPrint(o: any, opts?: { autoPrint?: boolean }) {
    setAutoPrintOnOpen(!!opts?.autoPrint);
    try {
      const res = await fetch(`${API}/api/sales/sales-orders/${o.id}`, { headers: authH });
      const full = await res.json();
      const customer = customers.find((c: any) => c.id === o.customerId) ?? null;
      // Reuse the invoice print template (same shape: header + lines + customer)
      // since the order shares the same line/total layout.
      setPrintData({ type: "order", doc: full, lines: full.lines ?? [], customer, company: user?.company ?? null });
    } catch (e: any) {
      toast({ title: e?.message ?? "تعذّر تحميل أمر البيع للطباعة", variant: "destructive" });
    }
  }

  const statusLabel = (s: string) =>
    s === "all" ? t("common.all") : t(`salesOrders.status${s.charAt(0).toUpperCase()}${s.slice(1)}`);

  const { data: orders = [], isLoading } = useQuery<any[]>({
    queryKey: ["sales-orders", cid],
    queryFn: async () => {
      const r = await fetch(cid ? `${API}/api/sales/sales-orders?companyId=${cid}` : `${API}/api/sales/sales-orders`, { headers: authH });
      return r.json();
    },
    enabled: !!user,
  });

  const { data: customers = [] } = useQuery<any[]>({
    queryKey: ["customers", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/customers?companyId=${cid}` : `${API}/api/customers`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  // Pick up the auto-print hint planted by SalesDocumentForm via
  // window.history.state when the user clicks "طباعة" on the order
  // edit screen and gets redirected back here. We wait until orders +
  // customers have loaded so the lookup and customer enrichment in
  // openPrint both succeed, then clear the marker so refresh /
  // re-visits don't re-print.
  const autoPrintHandledRef = useRef(false);
  useEffect(() => {
    if (autoPrintHandledRef.current) return;
    if (!orders || orders.length === 0) return;
    if (!customers) return;
    const st = (typeof window !== "undefined" ? window.history.state : null) as any;
    const id = st?.autoPrintInvoiceId;
    if (!id) return;
    const ord = orders.find((x: any) => Number(x.id) === Number(id));
    if (!ord) return;
    autoPrintHandledRef.current = true;
    try { window.history.replaceState({}, ""); } catch { /* noop */ }
    openPrint(ord, { autoPrint: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, customers]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["sales-orders"] });

  const statusMut = useMutation({
    mutationFn: async (args: { id: number; status: string }) => {
      const res = await fetch(`${API}/api/sales/sales-orders/${args.id}/status`, {
        method: "PATCH", headers, body: JSON.stringify({ status: args.status }),
      });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: t("salesOrders.toastStatusUpdated") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const convertMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/sales/sales-orders/${id}/convert`, { method: "POST", headers });
      const j = await res.json(); if (!res.ok) throw new Error(j.error); return j;
    },
    onSuccess: (j) => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["sales-invoices"] });
      toast({ title: t("salesOrders.toastConverted") });
      navigate(`/sales/invoices/${j.invoice.id}`);
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/sales/sales-orders/${id}`, { method: "DELETE", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
    },
    onSuccess: () => { invalidate(); toast({ title: t("salesOrders.toastDeleted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const cusMap = Object.fromEntries(customers.map((c: any) => [c.id, c.nameAr ?? c.nameEn]));

  const filtered = orders.filter(o => {
    const s = search.toLowerCase();
    const matchText = !search || (o.docNumber ?? "").includes(s) || (cusMap[o.customerId] ?? "").includes(search);
    const matchStatus = filterStatus === "all" || o.status === filterStatus;
    return matchText && matchStatus;
  });

  const pager = usePagination(filtered);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ClipboardList className="h-6 w-6 text-primary" />{t("salesOrders.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t("salesOrders.subtitle")}</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => navigate("/sales/orders/new")}>
          <Plus className="h-4 w-4" />{t("salesOrders.newOrder")}
        </Button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        {[
          { label: t("salesOrders.totalOrders"), v: orders.length, c: "text-primary" },
          { label: t("salesOrders.drafts"),      v: orders.filter(o => o.status === "draft").length,     c: "text-amber-700" },
          { label: t("salesOrders.confirmed"),   v: orders.filter(o => o.status === "confirmed").length, c: "text-green-700" },
          { label: t("salesOrders.converted"),   v: orders.filter(o => o.status === "converted").length, c: "text-primary" },
          { label: t("salesOrders.cancelled"),   v: orders.filter(o => o.status === "cancelled").length, c: "text-muted-foreground" },
        ].map((s, i) => (
          <div key={i} className="rounded-xl border bg-card p-4 shadow-sm">
            <p className="text-xs text-muted-foreground mb-1">{s.label}</p>
            <p className={cn("text-xl font-bold", s.c)}>{s.v}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input className="ps-9" placeholder={t("salesOrders.searchPlaceholder")} value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-1 flex-wrap">
          {["all","draft","confirmed","converted","cancelled"].map(s => (
            <button key={s} onClick={() => setFilterStatus(s)}
              className={cn("text-xs rounded-full px-3 py-1 border font-medium transition-colors",
                filterStatus === s ? "bg-primary text-primary-foreground border-primary" : "border-input bg-background hover:bg-muted"
              )}>
              {statusLabel(s)}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
        {isLoading ? (
          <div className="p-12 text-center text-muted-foreground text-sm">{t("common.loading")}</div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center">
            <FileText className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-40" />
            <p className="text-muted-foreground text-sm">{t("salesOrders.noOrders")}</p>
            <Button size="sm" className="mt-4 gap-2" onClick={() => navigate("/sales/orders/new")}>
              <Plus className="h-4 w-4" />{t("salesOrders.createFirst")}
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 border-b">
                  {[
                    t("salesOrders.colNumber"),
                    t("salesOrders.colDate"),
                    t("salesOrders.colExpectedDelivery"),
                    t("salesOrders.colCustomer"),
                    t("salesOrders.colCurrency"),
                    t("salesOrders.colSubtotal"),
                    t("salesOrders.colVat"),
                    t("salesOrders.colTotal"),
                    t("salesOrders.colStatus"),
                    t("salesOrders.colActions"),
                  ].map(h => (
                    <th key={h} className="text-start px-3 py-3 font-semibold text-muted-foreground text-xs">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pager.pagedItems.map(o => {
                  const st = STATUS_CLS[o.status] ?? STATUS_CLS.draft;
                  const isTerminal = o.status === "converted" || o.status === "cancelled";
                  return (
                    <tr key={o.id} className="border-b hover:bg-muted/30 transition-colors">
                      <td className="px-3 py-2.5 font-mono text-xs font-semibold text-primary">{o.docNumber ?? `SO-${o.id}`}</td>
                      <td className="px-3 py-2.5">{o.orderDate}</td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground">{o.expectedDeliveryDate ?? t("common.none")}</td>
                      <td className="px-3 py-2.5">{cusMap[o.customerId] ?? t("common.none")}</td>
                      <td className="px-3 py-2.5">{o.currencyCode}</td>
                      <td className="px-3 py-2.5 font-mono">{fmt(o.subtotal)}</td>
                      <td className="px-3 py-2.5 font-mono text-amber-700">{fmt(o.vatAmount)}</td>
                      <td className="px-3 py-2.5 font-mono font-semibold">{fmt(o.totalAmount)}</td>
                      <td className="px-3 py-2.5">
                        <span className={cn("inline-block text-[10px] rounded-full px-2 py-0.5 border font-medium", st)}>
                          {statusLabel(o.status)}
                        </span>
                        {o.convertedInvoiceId && (
                          <span className="block mt-1 text-[10px] text-muted-foreground">
                            {t("salesOrders.linkedInvoice")} #{o.convertedInvoiceId}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex gap-0.5 items-center">
                          <Button variant="ghost" size="icon" className="h-7 w-7" title={t("common.view")} onClick={() => navigate(`/sales/orders/${o.id}`)}>
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7" title={t("common.print")} onClick={() => openPrint(o)}>
                            <Printer className="h-3.5 w-3.5" />
                          </Button>
                          {o.status === "draft" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-green-700" title={t("salesOrders.confirm")}
                              onClick={() => statusMut.mutate({ id: o.id, status: "confirmed" })}>
                              <CheckCircle className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {o.status === "confirmed" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-primary" title={t("salesOrders.convertToInvoice")}
                              onClick={() => convertMut.mutate(o.id)}>
                              <ArrowRightLeft className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {!isTerminal && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-amber-700" title={t("salesOrders.cancel")}
                              onClick={() => {
                                if (window.confirm(t("salesOrders.confirmCancel"))) {
                                  statusMut.mutate({ id: o.id, status: "cancelled" });
                                }
                              }}>
                              <XCircle className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {!o.convertedInvoiceId && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" title={t("common.delete")}
                              onClick={() => {
                                if (window.confirm(t("salesOrders.confirmDelete"))) deleteMut.mutate(o.id);
                              }}>
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
        {filtered.length > 0 && (
          <TablePagination
            page={pager.page}
            pageSize={pager.pageSize}
            pageCount={pager.pageCount}
            total={pager.total}
            onPageChange={pager.setPage}
            onPageSizeChange={pager.setPageSize}
            itemLabel={t("salesOrders.itemLabel", { defaultValue: "أمر بيع" })}
          />
        )}
      </div>

      <SalesPrintModal open={!!printData} data={printData} onClose={() => setPrintData(null)} autoPrintOnOpen={autoPrintOnOpen} />
    </div>
  );
}
