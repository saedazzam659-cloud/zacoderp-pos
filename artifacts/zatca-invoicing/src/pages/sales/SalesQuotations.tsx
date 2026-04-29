import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useFormatters } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search, FileSignature, Eye, Trash2, FileText, ArrowRightLeft, CheckCircle, XCircle, Send, Printer } from "lucide-react";
import { cn } from "@/lib/utils";
import SalesPrintModal from "./SalesPrintModal";
import { TablePagination, usePagination } from "@/components/TablePagination";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const STATUS_CLS: Record<string, string> = {
  draft:     "bg-amber-50 text-amber-700 border-amber-200",
  sent:      "bg-blue-50 text-blue-700 border-blue-200",
  accepted:  "bg-green-50 text-green-700 border-green-200",
  rejected:  "bg-red-50 text-red-700 border-red-200",
  converted: "bg-primary/10 text-primary border-primary/30",
};

export default function SalesQuotations() {
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

  async function openPrint(q: any, opts?: { autoPrint?: boolean }) {
    setAutoPrintOnOpen(!!opts?.autoPrint);
    try {
      const res = await fetch(`${API}/api/sales/sales-quotations/${q.id}`, { headers: authH });
      const full = await res.json();
      const customer = customers.find((c: any) => c.id === q.customerId) ?? null;
      setPrintData({ type: "quotation", doc: full, lines: full.lines ?? [], customer, company: user?.company ?? null });
    } catch (e: any) {
      toast({ title: e?.message ?? "تعذّر تحميل عرض السعر للطباعة", variant: "destructive" });
    }
  }

  const statusLabel = (s: string) =>
    s === "all" ? t("common.all") : t(`salesQuotations.status${s.charAt(0).toUpperCase()}${s.slice(1)}`);

  const { data: quotations = [], isLoading } = useQuery<any[]>({
    queryKey: ["sales-quotations", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/sales/sales-quotations?companyId=${cid}` : `${API}/api/sales/sales-quotations`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  const { data: customers = [] } = useQuery<any[]>({
    queryKey: ["customers", cid],
    queryFn: async () => { const r = await fetch(cid ? `${API}/api/customers?companyId=${cid}` : `${API}/api/customers`, { headers: authH }); return r.json(); },
    enabled: !!user,
  });

  // Pick up the auto-print hint planted by SalesDocumentForm via
  // window.history.state when the user clicks "طباعة" on the
  // quotation edit screen and gets redirected back here. We wait for
  // both queries to load so the lookup and customer enrichment in
  // openPrint both succeed, then clear the marker so refresh /
  // re-visits don't re-print.
  const autoPrintHandledRef = useRef(false);
  useEffect(() => {
    if (autoPrintHandledRef.current) return;
    if (!quotations || quotations.length === 0) return;
    if (!customers) return;
    const st = (typeof window !== "undefined" ? window.history.state : null) as any;
    const id = st?.autoPrintInvoiceId;
    if (!id) return;
    const q = quotations.find((x: any) => Number(x.id) === Number(id));
    if (!q) return;
    autoPrintHandledRef.current = true;
    try { window.history.replaceState({}, ""); } catch { /* noop */ }
    openPrint(q, { autoPrint: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quotations, customers]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["sales-quotations"] });

  const statusMut = useMutation({
    mutationFn: async (args: { id: number; status: string }) => {
      const res = await fetch(`${API}/api/sales/sales-quotations/${args.id}/status`, { method: "PATCH", headers, body: JSON.stringify({ status: args.status }) });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: t("salesQuotations.toastStatusUpdated") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const convertMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/sales/sales-quotations/${id}/convert`, { method: "POST", headers });
      const j = await res.json(); if (!res.ok) throw new Error(j.error); return j;
    },
    onSuccess: (j) => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["sales-invoices"] });
      toast({ title: t("salesQuotations.toastConverted") });
      navigate(`/sales/invoices/${j.invoice.id}`);
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/sales/sales-quotations/${id}`, { method: "DELETE", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
    },
    onSuccess: () => { invalidate(); toast({ title: t("salesQuotations.toastDeleted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const cusMap = Object.fromEntries(customers.map((c: any) => [c.id, c.nameAr ?? c.nameEn]));

  const filtered = quotations.filter(q => {
    const s = search.toLowerCase();
    const matchText = !search || (q.docNumber ?? "").includes(s) || (cusMap[q.customerId] ?? "").includes(search);
    const matchStatus = filterStatus === "all" || q.status === filterStatus;
    return matchText && matchStatus;
  });

  const pager = usePagination(filtered);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileSignature className="h-6 w-6 text-primary" />{t("salesQuotations.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t("salesQuotations.subtitle")}</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => navigate("/sales/quotations/new")}>
          <Plus className="h-4 w-4" />{t("salesQuotations.newQuotation")}
        </Button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        {[
          { label: t("salesQuotations.totalQuotations"), v: quotations.length, c: "text-primary" },
          { label: t("salesQuotations.drafts"), v: quotations.filter(q => q.status === "draft").length, c: "text-amber-700" },
          { label: t("salesQuotations.sent"), v: quotations.filter(q => q.status === "sent").length, c: "text-blue-700" },
          { label: t("salesQuotations.accepted"), v: quotations.filter(q => q.status === "accepted").length, c: "text-green-700" },
          { label: t("salesQuotations.converted"), v: quotations.filter(q => q.status === "converted").length, c: "text-primary" },
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
          <Input className="ps-9" placeholder={t("salesQuotations.searchPlaceholder")} value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-1 flex-wrap">
          {["all","draft","sent","accepted","rejected","converted"].map(s => (
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
            <p className="text-muted-foreground text-sm">{t("salesQuotations.noQuotations")}</p>
            <Button size="sm" className="mt-4 gap-2" onClick={() => navigate("/sales/quotations/new")}>
              <Plus className="h-4 w-4" />{t("salesQuotations.createFirst")}
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 border-b">
                  {[
                    t("salesQuotations.colNumber"),
                    t("salesQuotations.colDate"),
                    t("salesQuotations.colValidUntil"),
                    t("salesQuotations.colCustomer"),
                    t("salesQuotations.colCurrency"),
                    t("salesQuotations.colSubtotal"),
                    t("salesQuotations.colVat"),
                    t("salesQuotations.colTotal"),
                    t("salesQuotations.colStatus"),
                    t("salesQuotations.colActions"),
                  ].map(h => (
                    <th key={h} className="text-start px-3 py-3 font-semibold text-muted-foreground text-xs">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pager.pagedItems.map(q => {
                  const st = STATUS_CLS[q.status] ?? STATUS_CLS.draft;
                  return (
                    <tr key={q.id} className="border-b hover:bg-muted/30 transition-colors">
                      <td className="px-3 py-2.5 font-mono text-xs font-semibold text-primary">{q.docNumber ?? `SQ-${q.id}`}</td>
                      <td className="px-3 py-2.5">{q.quotationDate}</td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground">{q.validUntil ?? t("common.none")}</td>
                      <td className="px-3 py-2.5">{cusMap[q.customerId] ?? t("common.none")}</td>
                      <td className="px-3 py-2.5">{q.currencyCode}</td>
                      <td className="px-3 py-2.5 font-mono">{fmt(q.subtotal)}</td>
                      <td className="px-3 py-2.5 font-mono text-amber-700">{fmt(q.vatAmount)}</td>
                      <td className="px-3 py-2.5 font-mono font-semibold">{fmt(q.totalAmount)}</td>
                      <td className="px-3 py-2.5">
                        <span className={cn("text-xs rounded-full px-2 py-0.5 font-medium border", st)}>{statusLabel(q.status)}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" className="h-7 w-7" title={t("common.openEdit")}
                            onClick={() => navigate(`/sales/quotations/${q.id}`)}>
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-slate-700 hover:text-primary hover:bg-muted"
                            title="طباعة"
                            onClick={() => openPrint(q)}>
                            <Printer className="h-3.5 w-3.5" />
                          </Button>
                          {q.status === "draft" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-blue-600" title={t("salesQuotations.actionSend")}
                              onClick={() => statusMut.mutate({ id: q.id, status: "sent" })}>
                              <Send className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {(q.status === "sent" || q.status === "draft") && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-green-700" title={t("salesQuotations.actionAccept")}
                              onClick={() => statusMut.mutate({ id: q.id, status: "accepted" })}>
                              <CheckCircle className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {(q.status === "sent" || q.status === "draft") && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-red-600" title={t("salesQuotations.actionReject")}
                              onClick={() => statusMut.mutate({ id: q.id, status: "rejected" })}>
                              <XCircle className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {q.status === "accepted" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-primary" title={t("salesQuotations.actionConvert")}
                              onClick={() => { if (confirm(t("salesQuotations.confirmConvert"))) convertMut.mutate(q.id); }}>
                              <ArrowRightLeft className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {q.status !== "converted" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive"
                              onClick={() => { if (confirm(t("salesQuotations.confirmDelete"))) deleteMut.mutate(q.id); }}>
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
            itemLabel={t("salesQuotations.itemLabel", { defaultValue: "عرض سعر" })}
          />
        )}
      </div>
      <SalesPrintModal open={!!printData} onClose={() => setPrintData(null)} data={printData} />
    </div>
  );
}
