import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useFormatters } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { TablePagination, usePagination } from "@/components/TablePagination";
import {
  ArrowLeftRight, Plus, Pencil, Trash2, Search, CheckCircle2, Clock,
  Send, Wallet, Landmark, Plus as PlusIcon, Minus, RefreshCw,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const NS = "financialTransactions";

// Map backend transferType → friendly badge.
const KIND_BADGE: Record<string, { labelKey: string; icon: any; cls: string }> = {
  cash_to_bank: { labelKey: "deposit",      icon: PlusIcon,  cls: "bg-green-50 text-green-700 border-green-200" },
  bank_to_cash: { labelKey: "withdraw",     icon: Minus,     cls: "bg-rose-50 text-rose-700 border-rose-200" },
  cash_to_cash: { labelKey: "transferCash", icon: RefreshCw, cls: "bg-amber-50 text-amber-700 border-amber-200" },
  bank_to_bank: { labelKey: "transferBank", icon: RefreshCw, cls: "bg-blue-50 text-blue-700 border-blue-200" },
};

export default function FinancialTransactions() {
  const { user, token } = useAuth();
  const { toast } = useToast();
  const { t } = useTranslation();
  const { fmt, isRtl } = useFormatters();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const h = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [search,  setSearch]  = useState("");
  const [postRow, setPostRow] = useState<any>(null);
  const [delRow,  setDelRow]  = useState<any>(null);

  const { data: transfers = [], isLoading } = useQuery<any[]>({
    queryKey: ["cash-transfers", cid],
    queryFn: () => fetch(`${API}/api/cash-transfers?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
  });
  const { data: cashBoxes = [] } = useQuery<any[]>({
    queryKey: ["cash-boxes", cid],
    queryFn: () => fetch(`${API}/api/cash-boxes?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
  });
  const { data: bankAccounts = [] } = useQuery<any[]>({
    queryKey: ["bank-accounts", cid],
    queryFn: () => fetch(`${API}/api/bank-accounts?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
  });

  const filtered = (transfers as any[]).filter((v: any) =>
    v.code?.toLowerCase().includes(search.toLowerCase()) ||
    (v.description ?? "").toLowerCase().includes(search.toLowerCase()),
  );
  const pager = usePagination(filtered);
  const totalAmount = (transfers as any[])
    .filter((v: any) => v.status === "posted")
    .reduce((a: number, v: any) => a + parseFloat(v.amount || "0"), 0);

  function nameOfCash(id: any) {
    const c = (cashBoxes as any[]).find((x: any) => x.id === id);
    return c ? (isRtl ? c.nameAr : (c.nameEn || c.nameAr)) : `#${id}`;
  }
  function nameOfBank(id: any) {
    const b = (bankAccounts as any[]).find((x: any) => x.id === id);
    return b ? (isRtl ? b.nameAr : (b.nameEn || b.nameAr)) : `#${id}`;
  }
  function getSourceName(row: any) {
    if (row.fromCashBoxId) return nameOfCash(row.fromCashBoxId);
    if (row.fromBankId)    return nameOfBank(row.fromBankId);
    return "—";
  }
  function getTargetName(row: any) {
    if (row.toCashBoxId) return nameOfCash(row.toCashBoxId);
    if (row.toBankId)    return nameOfBank(row.toBankId);
    return "—";
  }

  const postMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/cash-transfers/${id}/post`, { method: "POST", headers: h });
      if (!res.ok) throw new Error((await res.json()).error);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: t(`${NS}.posted_toast`, "تم الترحيل بنجاح") });
      qc.invalidateQueries({ queryKey: ["cash-transfers"] });
      setPostRow(null);
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/cash-transfers/${id}`, { method: "DELETE", headers: h });
      if (!res.ok && res.status !== 204) throw new Error((await res.json()).error);
    },
    onSuccess: () => {
      toast({ title: t(`${NS}.deleted_toast`, "تم الحذف") });
      qc.invalidateQueries({ queryKey: ["cash-transfers"] });
      setDelRow(null);
    },
    onError: (e: any) => toast({ title: e.message || t(`${NS}.err_delete`, "تعذّر الحذف"), variant: "destructive" }),
  });

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ArrowLeftRight className="h-6 w-6 text-violet-600" />
            {t(`${NS}.title`, "المعاملات المالية")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t(`${NS}.subtitle`, "إيداع، سحب، وتحويل بين الخزن والحسابات البنكية")}
          </p>
        </div>
        <Button onClick={() => navigate("/cash/financial-transactions/new")} className="gap-2 bg-violet-600 hover:bg-violet-700">
          <Plus className="h-4 w-4" />{t(`${NS}.newOne`, "معاملة جديدة")}
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {[
          { label: t(`${NS}.totalCount`, "إجمالي المعاملات"), value: (transfers as any[]).length, color: "text-primary bg-primary/10" },
          { label: t(`${NS}.posted`, "المرحَّل"),             value: (transfers as any[]).filter((v: any) => v.status === "posted").length, color: "text-green-700 bg-green-100" },
          { label: t(`${NS}.totalAmount`, "إجمالي المبالغ"),  value: fmt(totalAmount), color: "text-violet-700 bg-violet-50" },
        ].map((s, i) => (
          <div key={i} className="rounded-xl border bg-card p-4">
            <p className="text-xl font-bold">{isLoading ? "—" : s.value}</p>
            <p className={`text-xs mt-1 font-medium px-2 py-0.5 rounded-full inline-block ${s.color}`}>{s.label}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="flex items-center justify-between border-b px-4 py-3 gap-2 flex-wrap">
          <p className="text-sm font-medium">{t(`${NS}.log`, "سجل المعاملات")}</p>
          <div className="relative">
            <Search className={`absolute ${isRtl ? "right-3" : "left-3"} top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground`} />
            <Input className={`${isRtl ? "pr-9" : "pl-9"} h-8 w-56 text-sm`} placeholder={t("cashCommon.search")} value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/20 text-xs text-muted-foreground">
                <th className="h-9 px-4 text-start font-medium">{t(`${NS}.colCodeDate`, "كود / تاريخ")}</th>
                <th className="h-9 px-4 text-start font-medium">{t(`${NS}.colKind`, "نوع المعاملة")}</th>
                <th className="h-9 px-4 text-start font-medium hidden md:table-cell">{t(`${NS}.colFrom`, "من")}</th>
                <th className="h-9 px-4 text-start font-medium hidden md:table-cell">{t(`${NS}.colTo`, "إلى")}</th>
                <th className="h-9 px-4 text-start font-medium">{t(`${NS}.colAmount`, "المبلغ")}</th>
                <th className="h-9 px-4 text-center font-medium">{t(`${NS}.colStatus`, "الحالة")}</th>
                <th className="h-9 px-4 text-center font-medium w-28">{t(`${NS}.colActions`, "إجراءات")}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? Array.from({ length: 4 }).map((_, i) => (
                <tr key={i} className="border-b"><td colSpan={7} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td></tr>
              )) : filtered.length === 0 ? (
                <tr><td colSpan={7} className="py-14 text-center text-muted-foreground">
                  <ArrowLeftRight className="h-8 w-8 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">{search ? t("cashCommon.noResults") : t(`${NS}.empty`, "لا توجد معاملات بعد")}</p>
                  {!search && (
                    <Button variant="outline" size="sm" className="mt-3" onClick={() => navigate("/cash/financial-transactions/new")}>
                      <Plus className={`h-3.5 w-3.5 ${isRtl ? "ml-1" : "mr-1"}`} />{t(`${NS}.newOne`, "معاملة جديدة")}
                    </Button>
                  )}
                </td></tr>
              ) : pager.pagedItems.map((row: any) => {
                const badge = KIND_BADGE[row.transferType] ?? { labelKey: "transferCash", icon: RefreshCw, cls: "bg-muted text-muted-foreground border" };
                const Icon = badge.icon;
                return (
                  <tr
                    key={row.id}
                    onDoubleClick={() => navigate(`/cash/financial-transactions/${row.id}`)}
                    className="border-b hover:bg-muted/20 transition-colors cursor-pointer"
                    title={row.status === "draft" ? t("cashCommon.doubleClickEdit") : t("cashCommon.posted")}
                  >
                    <td className="px-4 py-3">
                      <p className="font-mono text-xs font-medium">{row.code}</p>
                      <p className="text-xs text-muted-foreground">{row.date}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${badge.cls}`}>
                        <Icon className="h-3 w-3" />
                        {t(`${NS}.${badge.labelKey}`)}
                      </span>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        {row.fromCashBoxId ? <Wallet className="h-3 w-3 shrink-0" /> : <Landmark className="h-3 w-3 shrink-0" />}
                        {getSourceName(row)}
                      </div>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        {row.toCashBoxId ? <Wallet className="h-3 w-3 shrink-0" /> : <Landmark className="h-3 w-3 shrink-0" />}
                        {getTargetName(row)}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-medium text-violet-700">{fmt(row.amount)}</td>
                    <td className="px-4 py-3 text-center">
                      {row.status === "posted"
                        ? <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded-full"><CheckCircle2 className="h-3 w-3" />{t("cashCommon.posted")}</span>
                        : <span className="inline-flex items-center gap-1 text-xs text-amber-600 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full"><Clock className="h-3 w-3" />{t("cashCommon.draft")}</span>}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex justify-center gap-1">
                        <button onClick={() => navigate(`/cash/financial-transactions/${row.id}`)} className="p-1.5 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors" title={t("cashCommon.edit")}>
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        {row.status === "draft" && (
                          <>
                            <button onClick={() => setPostRow(row)} className="p-1.5 rounded hover:bg-green-50 text-muted-foreground hover:text-green-600 transition-colors" title={t(`${NS}.postBtn`, "ترحيل")}>
                              <Send className="h-3.5 w-3.5" />
                            </button>
                            <button onClick={() => setDelRow(row)} className="p-1.5 rounded hover:bg-red-50 text-muted-foreground hover:text-red-600 transition-colors" title={t("cashCommon.delete")}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!isLoading && filtered.length > 0 && (
          <TablePagination
            page={pager.page}
            pageSize={pager.pageSize}
            pageCount={pager.pageCount}
            total={pager.total}
            onPageChange={pager.setPage}
            onPageSizeChange={pager.setPageSize}
            itemLabel={t(`${NS}.itemLabel`, "معاملة")}
          />
        )}
      </div>

      <AlertDialog open={!!postRow} onOpenChange={v => { if (!v) setPostRow(null); }}>
        <AlertDialogContent dir={isRtl ? "rtl" : "ltr"}>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Send className="h-5 w-5 text-green-600" />{t(`${NS}.postTitle`, "ترحيل المعاملة")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(`${NS}.postBody`, "هل أنت متأكد من ترحيل المعاملة {{code}} بمبلغ {{amount}}؟", { code: postRow?.code, amount: fmt(postRow?.amount || 0) })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cashCommon.cancel")}</AlertDialogCancel>
            <AlertDialogAction className="bg-green-600 hover:bg-green-700" onClick={() => postMut.mutate(postRow.id)} disabled={postMut.isPending}>
              {postMut.isPending ? t(`${NS}.posting`, "جارٍ الترحيل...") : t(`${NS}.postBtn`, "ترحيل")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!delRow} onOpenChange={v => { if (!v) setDelRow(null); }}>
        <AlertDialogContent dir={isRtl ? "rtl" : "ltr"}>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Trash2 className="h-5 w-5 text-destructive" />{t(`${NS}.delTitle`, "حذف المعاملة")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(`${NS}.delBody`, "هل أنت متأكد من حذف المعاملة {{code}}؟", { code: delRow?.code })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cashCommon.cancel")}</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive hover:bg-destructive/90" onClick={() => delMut.mutate(delRow.id)} disabled={delMut.isPending}>
              {delMut.isPending ? t(`${NS}.deleting`, "جارٍ الحذف...") : t(`${NS}.delBtn`, "حذف")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
