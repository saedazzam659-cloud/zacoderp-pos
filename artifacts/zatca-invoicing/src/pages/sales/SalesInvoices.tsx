import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useFormatters } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search, ShoppingBag, Eye, Trash2, CheckCircle, FileText, RotateCcw, Undo2, Copy, Printer } from "lucide-react";
import { cn } from "@/lib/utils";
import SalesPrintModal from "./SalesPrintModal";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function SalesInvoices() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const { t } = useTranslation();
  const { fmt, isRtl } = useFormatters();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const authH   = { Authorization: `Bearer ${token}` };

  const STATUS: Record<string, { label: string; cls: string }> = {
    draft:     { label: t("status.draft"),     cls: "bg-amber-50 text-amber-700 border-amber-200" },
    posted:    { label: t("status.posted"),    cls: "bg-green-50 text-green-700 border-green-200" },
    cancelled: { label: t("status.cancelled"), cls: "bg-muted text-muted-foreground border-border" },
  };

  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [printData, setPrintData] = useState<any>(null);

  async function openPrint(inv: any) {
    try {
      const res = await fetch(`${API}/api/sales/sales-invoices/${inv.id}`, { headers: authH });
      const full = await res.json();
      const customer = customers.find((c: any) => c.id === inv.customerId) ?? null;
      setPrintData({ type: "invoice", doc: full, lines: full.lines ?? [], customer, company: user?.company ?? null });
    } catch (e: any) {
      toast({ title: e?.message ?? "تعذّر تحميل الفاتورة للطباعة", variant: "destructive" });
    }
  }

  const { data: invoices = [], isLoading } = useQuery<any[]>({
    queryKey: ["sales-invoices", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/sales/sales-invoices?companyId=${cid}` : `${API}/api/sales/sales-invoices`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const { data: customers = [] } = useQuery<any[]>({
    queryKey: ["customers", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/customers?companyId=${cid}` : `${API}/api/customers`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["sales-invoices"] });

  const postMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/sales/sales-invoices/${id}/post`, { method: "PATCH", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: t("salesInvoices.toastPosted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const unpostMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/sales/sales-invoices/${id}/unpost`, { method: "PATCH", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: t("salesInvoices.toastUnposted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/sales/sales-invoices/${id}`, { method: "DELETE", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
    },
    onSuccess: () => { invalidate(); toast({ title: t("salesInvoices.toastDeleted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const cusMap = Object.fromEntries(customers.map((c: any) => [c.id, c.nameAr ?? c.nameEn]));

  const filtered = invoices.filter(inv => {
    const q = search.toLowerCase();
    const matchText = !search || (inv.docNumber ?? "").includes(q) || (cusMap[inv.customerId] ?? "").includes(search);
    const matchStatus = filterStatus === "all" || inv.status === filterStatus;
    return matchText && matchStatus;
  });

  const totalPosted = invoices.filter(i => i.status === "posted").reduce((s, i) => s + Number(i.totalAmount || 0), 0);

  const headerCells: string[] = [
    t("salesInvoices.colNumber"), t("salesInvoices.colDate"), t("salesInvoices.colCustomer"),
    t("salesInvoices.colPaymentType"), t("salesInvoices.colCurrency"), t("salesInvoices.colSubtotal"),
    t("salesInvoices.colVat"), t("salesInvoices.colTotal"), t("salesInvoices.colJournal"),
    t("salesInvoices.colStatus"), t("salesInvoices.colActions"),
  ];
  const align = isRtl ? "text-right" : "text-left";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShoppingBag className="h-6 w-6 text-primary" />{t("salesInvoices.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t("salesInvoices.subtitle")}</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => navigate("/sales/invoices/new")}>
          <Plus className="h-4 w-4" />{t("salesInvoices.newInvoice")}
        </Button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: t("salesInvoices.totalInvoices"), value: invoices.length, color: "text-primary" },
          { label: t("salesInvoices.posted"),        value: invoices.filter(i => i.status === "posted").length, color: "text-green-700" },
          { label: t("salesInvoices.drafts"),        value: invoices.filter(i => i.status === "draft").length,  color: "text-amber-700" },
          { label: t("salesInvoices.totalSales"),    value: `${fmt(totalPosted)} ${t("common.currencySAR")}`,    color: "text-primary" },
        ].map((c, i) => (
          <div key={i} className="rounded-xl border bg-card p-4 shadow-sm">
            <p className="text-xs text-muted-foreground mb-1">{c.label}</p>
            <p className={cn("text-xl font-bold font-mono", c.color)}>{c.value}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-48">
          <Search className={cn("absolute top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground", isRtl ? "right-3" : "left-3")} />
          <Input className={isRtl ? "pr-9" : "pl-9"} placeholder={t("salesInvoices.searchPlaceholder")} value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-1">
          {["all", "draft", "posted", "cancelled"].map(s => (
            <button key={s} onClick={() => setFilterStatus(s)}
              className={cn("text-xs rounded-full px-3 py-1 border font-medium transition-colors",
                filterStatus === s ? "bg-primary text-primary-foreground border-primary" : "border-input bg-background hover:bg-muted"
              )}>
              {s === "all" ? t("common.all") : STATUS[s]?.label}
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
            <p className="text-muted-foreground text-sm">{t("salesInvoices.noInvoices")}</p>
            <Button size="sm" className="mt-4 gap-2" onClick={() => navigate("/sales/invoices/new")}>
              <Plus className="h-4 w-4" />{t("salesInvoices.createFirst")}
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 border-b">
                  {headerCells.map(h => (
                    <th key={h} className={cn("px-3 py-3 font-semibold text-muted-foreground text-xs", align)}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(inv => {
                  const st = STATUS[inv.status] ?? STATUS.draft;
                  const payLabel = inv.paymentType === "cash"
                    ? t("salesInvoices.paymentCash")
                    : inv.paymentType === "bank"
                      ? t("salesInvoices.paymentBank")
                      : t("salesInvoices.paymentCredit");
                  return (
                    <tr key={inv.id} className="border-b hover:bg-muted/30 transition-colors cursor-pointer"
                      onDoubleClick={() => navigate(`/sales/invoices/${inv.id}`)}
                      title={t("common.doubleClickToOpen")}>
                      <td className="px-3 py-2.5 font-mono text-xs font-semibold text-primary">{inv.docNumber ?? `SI-${inv.id}`}</td>
                      <td className="px-3 py-2.5">{inv.invoiceDate}</td>
                      <td className="px-3 py-2.5">{cusMap[inv.customerId] ?? "—"}</td>
                      <td className="px-3 py-2.5 text-muted-foreground text-xs">{payLabel}</td>
                      <td className="px-3 py-2.5">{inv.currencyCode}</td>
                      <td className="px-3 py-2.5 font-mono">{fmt(inv.subtotal)}</td>
                      <td className="px-3 py-2.5 font-mono text-amber-700">{fmt(inv.vatAmount)}</td>
                      <td className="px-3 py-2.5 font-mono font-semibold">{fmt(inv.totalAmount)}</td>
                      <td className="px-3 py-2.5">
                        {inv.journalEntryId ? (
                          <button onClick={() => navigate(`/accounting/journals/${inv.journalEntryId}?tab=lines`)}
                            className="font-mono text-xs text-blue-600 hover:underline">
                            JE-{inv.journalEntryId}
                          </button>
                        ) : <span className="text-muted-foreground text-xs">—</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={cn("text-xs rounded-full px-2 py-0.5 font-medium border", st.cls)}>{st.label}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" className="h-7 w-7" title={t("common.openEdit")}
                            onClick={() => navigate(`/sales/invoices/${inv.id}`)}>
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-slate-700 hover:text-primary hover:bg-muted"
                            title="طباعة"
                            onClick={() => openPrint(inv)}>
                            <Printer className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                            title={t("common.duplicate")}
                            onClick={() => navigate(`/sales/invoices/new?from=${inv.id}`)}>
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                          {inv.status === "posted" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-orange-600 hover:text-orange-700 hover:bg-orange-50"
                              title={t("salesInvoices.createReturn")}
                              onClick={() => navigate(`/sales/returns?fromInvoice=${inv.id}`)}>
                              <RotateCcw className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {inv.status === "posted" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                              title={t("salesInvoices.unpostTitle")}
                              onClick={() => { if (confirm(t("salesInvoices.confirmUnpost"))) unpostMut.mutate(inv.id); }}>
                              <Undo2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {inv.status === "draft" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-green-700" title={t("common.post")}
                              onClick={() => { if (confirm(t("salesInvoices.confirmPost"))) postMut.mutate(inv.id); }}>
                              <CheckCircle className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {inv.status === "draft" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive"
                              onClick={() => { if (confirm(t("salesInvoices.confirmDelete"))) deleteMut.mutate(inv.id); }}>
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
      <SalesPrintModal open={!!printData} onClose={() => setPrintData(null)} data={printData} />
    </div>
  );
}
