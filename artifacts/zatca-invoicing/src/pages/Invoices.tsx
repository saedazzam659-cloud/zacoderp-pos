import { useState } from "react";
import { useListInvoices, useDeleteInvoice } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Plus, Search, FileText, TrendingUp, Clock, CheckCircle2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";
import { arSA } from "date-fns/locale";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useFmt } from "@/hooks/use-fmt";
import ExportButtons from "@/components/ExportButtons";
import { useTranslation } from "react-i18next";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export default function Invoices() {
  const { t } = useTranslation();
  const [search, setSearch]           = useState("");
  const [activeTab, setActiveTab]     = useState("all");
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; number: string } | null>(null);

  const { user }        = useAuth();
  const { toast }       = useToast();
  const { dp }          = useFmt();
  const queryClient     = useQueryClient();
  const deleteInvoice   = useDeleteInvoice();

  const INVOICE_EXPORT_COLS = [
    { key: "invoiceNumber",  header: t("pages.invoices.invoiceNumber"),         width: 22 },
    { key: "invoiceType",    header: t("pages.invoices.type"),                 width: 14 },
    { key: "customerName",   header: t("pages.invoices.customer"),                width: 28 },
    { key: "issueDate",      header: t("pages.invoices.issueDate"),         width: 18 },
    { key: "subtotal",       header: t("pages.invoices.subtotal"),    width: 22 },
    { key: "vatTotal",       header: t("pages.invoices.vatTotal"),  width: 24 },
    { key: "grandTotal",     header: t("pages.invoices.grandTotal"),              width: 18 },
    { key: "status",         header: t("common.status"),                width: 14 },
    { key: "zatcaStatus",    header: t("pages.invoices.zatcaStatus"),            width: 16 },
  ];

  const STATUS_TABS = [
    { key: "all",       label: t("pages.invoices.all") },
    { key: "draft",     label: t("pages.invoices.draft") },
    { key: "issued",    label: t("pages.invoices.issued") },
    { key: "cancelled", label: t("pages.invoices.cancelled") },
  ];

  const getStatusStyle = (status: string) => {
    switch (status) {
      case "issued":    return "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30";
      case "draft":     return "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30";
      case "cancelled": return "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30";
      default:          return "bg-muted text-muted-foreground border-border";
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case "issued":    return t("pages.invoices.issued");
      case "draft":     return t("pages.invoices.draft");
      case "cancelled": return t("pages.invoices.cancelled");
      default:          return status;
    }
  };

  const getZatcaStyle = (status?: string) => {
    switch (status) {
      case "cleared":
      case "reported":  return { cls: "bg-blue-50 text-blue-700 border-blue-200", label: t("pages.invoices.zatcaCleared") };
      case "rejected":  return { cls: "bg-red-50 text-red-700 border-red-200", label: t("pages.invoices.zatcaRejected") };
      case "pending":   return { cls: "bg-yellow-50 text-yellow-700 border-yellow-200", label: t("pages.invoices.zatcaPending") };
      default:          return null;
    }
  };

  const { data: invoices, isLoading } = useListInvoices(
    activeTab !== "all" ? { status: activeTab as "draft" | "issued" | "cancelled" } : undefined,
    { query: { queryKey: ["invoices", user?.companyId, activeTab] } }
  );

  const formatCurrency = (amount: number | string) =>
    new Intl.NumberFormat("ar-SA", { style: "currency", currency: "SAR", minimumFractionDigits: dp, maximumFractionDigits: dp }).format(Number(amount));

  const filtered = invoices?.filter(inv =>
    inv.invoiceNumber.toLowerCase().includes(search.toLowerCase()) ||
    inv.customer?.nameAr?.includes(search)
  );

  const all = invoices ?? [];
  const stats = {
    total:   all.length,
    issued:  all.filter(i => i.status === "issued").length,
    pending: all.filter(i => i.zatcaStatus === "pending" && i.status === "issued").length,
    amount:  all.filter(i => i.status === "issued").reduce((s, i) => s + Number(i.grandTotal), 0),
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    deleteInvoice.mutate({ id: deleteTarget.id }, {
      onSuccess: () => {
        toast({ title: t("pages.invoices.deleteSuccessTitle"), description: t("pages.invoices.deleteSuccessDesc", { number: deleteTarget.number }) });
        queryClient.invalidateQueries({ queryKey: ["invoices"] });
        setDeleteTarget(null);
      },
      onError: () => {
        toast({ title: t("pages.invoices.error"), description: t("pages.invoices.deleteErrorDesc"), variant: "destructive" });
        setDeleteTarget(null);
      },
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("pages.invoices.title")}</h1>
          <p className="text-muted-foreground mt-1">{t("pages.invoices.description")}</p>
        </div>
        <div className="flex items-center gap-2">
          <ExportButtons
            rows={(filtered ?? []).map(inv => ({
              invoiceNumber: inv.invoiceNumber,
              invoiceType:   inv.invoiceType === "standard" ? t("pages.invoices.taxInvoice") : t("pages.invoices.simplifiedInvoice"),
              customerName:  inv.customer?.nameAr ?? t("pages.invoices.cashCustomer"),
              issueDate:     inv.issueDate,
              subtotal:      Number(inv.subtotal).toFixed(dp),
              vatTotal:      Number(inv.vatTotal).toFixed(dp),
              grandTotal:    Number(inv.grandTotal).toFixed(dp),
              status:        getStatusLabel(inv.status),
              zatcaStatus:   inv.zatcaStatus ?? "—",
            }))}
            columns={INVOICE_EXPORT_COLS}
            filename={`فواتير-${new Date().toISOString().slice(0, 10)}`}
            title={t("pages.invoices.listTitle")}
            subtitle={`${t("pages.invoices.listSubtitle")}${new Date().toLocaleDateString("ar-SA-u-nu-latn")}`}
          />
          <Button asChild className="gap-2">
            <Link href="/invoices/new">
              <Plus className="h-4 w-4" /><span>{t("pages.invoices.newInvoice")}</span>
            </Link>
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)
        ) : (
          <>
            <div className="rounded-xl border bg-card p-4 flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                <FileText className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="text-2xl font-bold">{stats.total}</p>
                <p className="text-xs text-muted-foreground">{t("pages.invoices.totalInvoices")}</p>
              </div>
            </div>
            <div className="rounded-xl border bg-card p-4 flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center shrink-0">
                <CheckCircle2 className="h-5 w-5 text-emerald-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{stats.issued}</p>
                <p className="text-xs text-muted-foreground">{t("pages.invoices.issued")}</p>
              </div>
            </div>
            <div className="rounded-xl border bg-card p-4 flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center shrink-0">
                <Clock className="h-5 w-5 text-amber-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{stats.pending}</p>
                <p className="text-xs text-muted-foreground">{t("pages.invoices.waitingZatca")}</p>
              </div>
            </div>
            <div className="rounded-xl border bg-card p-4 flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center shrink-0">
                <TrendingUp className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <p className="text-lg font-bold leading-tight" dir="ltr">{formatCurrency(stats.amount)}</p>
                <p className="text-xs text-muted-foreground">{t("pages.invoices.totalIssued")}</p>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Filters + Table */}
      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-0 border-b">
          {/* Status tabs */}
          <div className="flex overflow-x-auto">
            {STATUS_TABS.map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-5 py-3.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px ${
                  activeTab === tab.key
                    ? "border-primary text-primary bg-primary/5"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40"
                }`}
              >
                {tab.label}
                {tab.key === "all" && invoices && (
                  <span className="mr-1.5 text-xs bg-muted px-1.5 py-0.5 rounded-full">{invoices.length}</span>
                )}
              </button>
            ))}
          </div>
          {/* Search */}
          <div className="relative px-4 py-3">
            <Search className="absolute right-7 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t("pages.invoices.searchPlaceholder")}
              className="pl-4 pr-10 w-full sm:w-72 h-9"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full caption-bottom text-sm">
            <thead>
              <tr className="border-b bg-muted/20">
                <th className="h-10 px-5 text-right align-middle font-medium text-muted-foreground text-xs tracking-wide">{t("pages.invoices.invoiceNumber")}</th>
                <th className="h-10 px-5 text-right align-middle font-medium text-muted-foreground text-xs tracking-wide hidden sm:table-cell">{t("pages.invoices.date")}</th>
                <th className="h-10 px-5 text-right align-middle font-medium text-muted-foreground text-xs tracking-wide">{t("pages.invoices.customer")}</th>
                <th className="h-10 px-5 text-right align-middle font-medium text-muted-foreground text-xs tracking-wide">{t("pages.invoices.totalAmount")}</th>
                <th className="h-10 px-5 text-right align-middle font-medium text-muted-foreground text-xs tracking-wide">{t("common.status")}</th>
                <th className="h-10 px-5 text-right align-middle font-medium text-muted-foreground text-xs tracking-wide hidden md:table-cell">ZATCA</th>
                <th className="h-10 px-3 text-right align-middle font-medium text-muted-foreground text-xs tracking-wide w-12"></th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b">
                    {Array.from({ length: 7 }).map((_, j) => (
                      <td key={j} className="px-5 py-4"><Skeleton className="h-4 w-full max-w-28" /></td>
                    ))}
                  </tr>
                ))
              ) : !filtered?.length ? (
                <tr>
                  <td colSpan={7} className="py-16 text-center text-muted-foreground">
                    <FileText className="h-10 w-10 mx-auto mb-3 opacity-30" />
                    <p className="text-sm">{search ? t("pages.invoices.noResults") : t("pages.invoices.noInvoices")}</p>
                    {!search && (
                      <Button asChild variant="outline" size="sm" className="mt-4 gap-2">
                        <Link href="/invoices/new"><Plus className="h-3.5 w-3.5" />{t("pages.invoices.createInvoice")}</Link>
                      </Button>
                    )}
                  </td>
                </tr>
              ) : (
                filtered?.map(invoice => {
                  const zatca = getZatcaStyle(invoice.zatcaStatus);
                  const isCancelled = invoice.status === "cancelled";
                  return (
                    <tr
                      key={invoice.id}
                      className="border-b transition-colors hover:bg-muted/30 cursor-pointer group"
                      onClick={() => window.location.href = `/invoices/${invoice.id}`}
                    >
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2">
                          <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                            invoice.status === "issued" ? "bg-emerald-500" :
                            invoice.status === "draft" ? "bg-amber-400" : "bg-red-400"
                          }`} />
                          <span className="font-mono font-medium text-xs group-hover:text-primary transition-colors" dir="ltr">
                            {invoice.invoiceNumber}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 sm:hidden">
                          {format(new Date(invoice.issueDate), "yyyy/MM/dd")}
                        </p>
                      </td>
                      <td className="px-5 py-3.5 text-muted-foreground hidden sm:table-cell">
                        {format(new Date(invoice.issueDate), "PP", { locale: arSA })}
                      </td>
                      <td className="px-5 py-3.5">
                        <span className="font-medium">{invoice.customer?.nameAr || t("pages.invoices.cashCustomer")}</span>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {invoice.invoiceType === "standard" ? t("pages.invoices.taxInvoiceB2B") : t("pages.invoices.simplifiedInvoiceB2C")}
                        </p>
                      </td>
                      <td className="px-5 py-3.5 font-bold tabular-nums" dir="ltr">
                        {formatCurrency(invoice.grandTotal)}
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${getStatusStyle(invoice.status)}`}>
                          {getStatusLabel(invoice.status)}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 hidden md:table-cell">
                        {zatca && (
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${zatca.cls}`}>
                            {zatca.label}
                          </span>
                        )}
                      </td>
                      {/* Delete button — only for cancelled */}
                      <td className="px-3 py-3.5 text-left">
                        {isCancelled && (
                          <button
                            type="button"
                            onClick={e => {
                              e.stopPropagation();
                              setDeleteTarget({ id: invoice.id, number: invoice.invoiceNumber });
                            }}
                            className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-md text-red-500 hover:bg-red-50 hover:text-red-700"
                            title={t("pages.invoices.deleteCancelledTitle")}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={open => !open && setDeleteTarget(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-red-600">
              <Trash2 className="h-5 w-5" />
              {t("pages.invoices.confirmDeleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-right">
              {t("pages.invoices.confirmDeleteDesc")}
              <span className="font-mono font-semibold text-foreground" dir="ltr">{deleteTarget?.number}</span>؟
              <br />
              <span className="text-red-600 font-medium">{t("pages.invoices.irreversibleAction")}</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row-reverse gap-2">
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              disabled={deleteInvoice.isPending}
              className="bg-red-600 hover:bg-red-700 text-white gap-2"
            >
              <Trash2 className="h-4 w-4" />
              {deleteInvoice.isPending ? t("pages.invoices.deleting") : t("pages.invoices.deleteInvoice")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
