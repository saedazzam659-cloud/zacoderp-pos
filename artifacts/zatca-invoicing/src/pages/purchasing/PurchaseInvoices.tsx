import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search, ShoppingCart, Eye, Trash2, CheckCircle, FileText, RotateCcw, Printer, Undo2, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import PurchasePrintModal from "./PurchasePrintModal";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function PurchaseInvoices() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const fmt = (n: any) => Number(n || 0).toLocaleString(isRtl ? "ar-SA" : "en-US", { minimumFractionDigits: 2 });
  const STATUS: Record<string, { labelKey: string; cls: string }> = {
    draft:     { labelKey: "status.draft",     cls: "bg-amber-50 text-amber-700 border-amber-200" },
    posted:    { labelKey: "status.posted",    cls: "bg-green-50 text-green-700 border-green-200" },
    cancelled: { labelKey: "status.cancelled", cls: "bg-muted text-muted-foreground border-border" },
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
  const [printData, setPrintData] = useState<any>(null);

  const { data: invoices = [], isLoading } = useQuery<any[]>({
    queryKey: ["purchase-invoices", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/purchasing/purchase-invoices?companyId=${cid}` : `${API}/api/purchasing/purchase-invoices`;
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

  const invalidate = () => qc.invalidateQueries({ queryKey: ["purchase-invoices"] });

  const unpostMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/purchasing/purchase-invoices/${id}/unpost`, { method: "PATCH", headers });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || t("purchasingPages.purchaseInvoices.toasts.unpostFailed"));
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: t("purchasingPages.purchaseInvoices.toasts.unposted") });
      qc.invalidateQueries({ queryKey: ["purchase-invoices"] });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const postMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/purchasing/purchase-invoices/${id}/post`, { method: "PATCH", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: t("purchasingPages.purchaseInvoices.toasts.posted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/purchasing/purchase-invoices/${id}`, { method: "DELETE", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
    },
    onSuccess: () => { invalidate(); toast({ title: t("purchasingPages.purchaseInvoices.toasts.deleted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  async function openPrint(inv: any) {
    const res = await fetch(`${API}/api/purchasing/purchase-invoices/${inv.id}`, { headers: authH });
    const full = await res.json();
    const supplier = suppliers.find((s: any) => s.id === inv.supplierId) ?? null;
    setPrintData({ type: "invoice", doc: full, lines: full.lines ?? [], supplier, company: user?.company ?? null });
  }

  const supName = (s: any) => isRtl ? (s?.nameAr ?? s?.nameEn ?? "") : (s?.nameEn ?? s?.nameAr ?? "");
  const supMap = Object.fromEntries(suppliers.map((s: any) => [s.id, supName(s)]));

  const filtered = invoices.filter(inv => {
    const q = search.toLowerCase();
    const matchText = !search || (inv.docNumber ?? "").toLowerCase().includes(q) || (supMap[inv.supplierId] ?? "").toLowerCase().includes(q);
    const matchStatus = filterStatus === "all" || inv.status === filterStatus;
    return matchText && matchStatus;
  });

  const totalPosted = invoices.filter(i => i.status === "posted").reduce((s, i) => s + Number(i.totalAmount || 0), 0);

  const cols = [
    t("purchasingPages.purchaseInvoices.cols.number"),
    t("purchasingPages.purchaseInvoices.cols.date"),
    t("purchasingPages.purchaseInvoices.cols.supplier"),
    t("purchasingPages.purchaseInvoices.cols.paymentType"),
    t("purchasingPages.purchaseInvoices.cols.currency"),
    t("purchasingPages.purchaseInvoices.cols.subtotal"),
    t("purchasingPages.purchaseInvoices.cols.vat"),
    t("purchasingPages.purchaseInvoices.cols.total"),
    t("purchasingPages.purchaseInvoices.cols.journal"),
    t("purchasingPages.purchaseInvoices.cols.status"),
    t("purchasingPages.purchaseInvoices.cols.actions"),
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
            <ShoppingCart className="h-6 w-6 text-primary" />{t("purchasingPages.purchaseInvoices.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t("purchasingPages.purchaseInvoices.subtitle")}</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => navigate("/purchasing/invoices/new")}>
          <Plus className="h-4 w-4" />{t("purchasingPages.purchaseInvoices.newInvoice")}
        </Button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: t("purchasingPages.purchaseInvoices.totalInvoices"), value: invoices.length, color: "text-primary" },
          { label: t(STATUS.posted.labelKey), value: invoices.filter(i => i.status === "posted").length, color: "text-green-700" },
          { label: t(STATUS.draft.labelKey),  value: invoices.filter(i => i.status === "draft").length,  color: "text-amber-700" },
          { label: t("purchasingPages.purchaseInvoices.totalPurchases"), value: `${fmt(totalPosted)} ${t("purchasingPages.purchaseInvoices.currencyRiyal")}`, color: "text-primary" },
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
          <Input className={isRtl ? "pr-9" : "pl-9"} placeholder={t("purchasingPages.purchaseInvoices.searchPlaceholder")} value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-1">
          {["all", "draft", "posted", "cancelled"].map(s => (
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
            <p className="text-muted-foreground text-sm">{t("purchasingPages.purchaseInvoices.noInvoices")}</p>
            <Button size="sm" className="mt-4 gap-2" onClick={() => navigate("/purchasing/invoices/new")}>
              <Plus className="h-4 w-4" />{t("purchasingPages.purchaseInvoices.createFirst")}
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
                {filtered.map(inv => {
                  const st = STATUS[inv.status] ?? STATUS.draft;
                  return (
                    <tr key={inv.id} className="border-b hover:bg-muted/30 transition-colors cursor-pointer"
                      onDoubleClick={() => navigate(`/purchasing/invoices/${inv.id}`)}
                      title={t("purchasingPages.purchaseInvoices.tooltips.openEdit")}>
                      <td className="px-3 py-2.5 font-mono text-xs font-semibold text-primary">
                        {inv.docNumber ?? `PI-${inv.id}`}
                      </td>
                      <td className="px-3 py-2.5">{inv.invoiceDate}</td>
                      <td className="px-3 py-2.5">{supMap[inv.supplierId] ?? "—"}</td>
                      <td className="px-3 py-2.5 text-muted-foreground text-xs">
                        {inv.paymentType === "cash"
                          ? t("purchasingPages.purchaseInvoices.paymentCash")
                          : t("purchasingPages.purchaseInvoices.paymentCredit")}
                      </td>
                      <td className="px-3 py-2.5">{inv.currencyCode}</td>
                      <td className="px-3 py-2.5 font-mono">{fmt(inv.subtotal)}</td>
                      <td className="px-3 py-2.5 font-mono text-amber-700">{fmt(inv.vatAmount)}</td>
                      <td className="px-3 py-2.5 font-mono font-semibold">{fmt(inv.totalAmount)}</td>
                      <td className="px-3 py-2.5 font-mono text-xs">
                        {inv.journalEntryId ? (
                          <button
                            type="button"
                            className="text-blue-700 hover:text-blue-900 hover:underline font-semibold"
                            title={t("purchasingPages.purchaseInvoices.tooltips.viewJournal")}
                            onClick={() => navigate(`/accounting/journals/${inv.journalEntryId}?tab=lines`)}>
                            JE-{inv.journalEntryId}
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
                          <Button variant="ghost" size="icon" className="h-7 w-7" title={t("purchasingPages.purchaseInvoices.tooltips.viewEdit")}
                            onClick={() => navigate(`/purchasing/invoices/${inv.id}`)}>
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                            title={t("purchasingPages.purchaseInvoices.tooltips.duplicate")}
                            onClick={() => navigate(`/purchasing/invoices/new?from=${inv.id}`)}>
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-primary hover:bg-primary/10"
                            title={t("purchasingPages.purchaseInvoices.tooltips.print")}
                            onClick={() => openPrint(inv)}>
                            <Printer className="h-3.5 w-3.5" />
                          </Button>
                          {inv.status === "posted" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-orange-600 hover:text-orange-700 hover:bg-orange-50"
                              title={t("purchasingPages.purchaseInvoices.tooltips.createReturn")}
                              onClick={() => navigate(`/purchasing/returns?fromInvoice=${inv.id}`)}>
                              <RotateCcw className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {inv.status === "posted" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-amber-700 hover:bg-amber-50"
                              title={t("purchasingPages.purchaseInvoices.tooltips.unpost")}
                              onClick={() => { if (confirm(t("purchasingPages.purchaseInvoices.confirms.unpost"))) unpostMut.mutate(inv.id); }}>
                              <Undo2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {inv.status === "draft" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-green-700" title={t("purchasingPages.purchaseInvoices.tooltips.post")}
                              onClick={() => { if (confirm(t("purchasingPages.purchaseInvoices.confirms.post"))) postMut.mutate(inv.id); }}>
                              <CheckCircle className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {inv.status === "draft" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive"
                              onClick={() => { if (confirm(t("purchasingPages.purchaseInvoices.confirms.delete"))) deleteMut.mutate(inv.id); }}>
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

      <PurchasePrintModal
        open={!!printData}
        onClose={() => setPrintData(null)}
        data={printData}
      />
    </div>
  );
}
