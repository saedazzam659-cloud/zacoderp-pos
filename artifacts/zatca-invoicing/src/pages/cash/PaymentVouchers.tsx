import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import MultiBranchFilter from "@/components/MultiBranchFilter";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useFormatters } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { TablePagination, usePagination } from "@/components/TablePagination";
import { ArrowUpCircle, Plus, Pencil, Trash2, Search, CheckCircle2, Clock, Send, Undo2, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  rowToneFor, DocColorLegend, buildToneTooltip, type LegendItem,
} from "@/lib/docRowTone";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─────────────────────────────────────────────────────────────────
// Listing-only screen for payment vouchers. The data-entry form is
// a dedicated full-page route (`/cash/payment-vouchers/new` and
// `/cash/payment-vouchers/:id`) so users get the same comfortable
// layout, searchable comboboxes, Enter-key navigation, prev/next
// nav and live JE preview as the receipt-vouchers form.
// This component only owns:
//   • table + search + pagination
//   • post / unpost / delete confirmation dialogs
//   • navigation to the dedicated form route on add/edit
// ─────────────────────────────────────────────────────────────────

export default function PaymentVouchers() {
  const { user, token } = useAuth();
  const { toast } = useToast();
  const { t } = useTranslation();
  const { fmt, isRtl } = useFormatters();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const h = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;
  const NS = "paymentVouchers";

  const ENTITY_LABELS: Record<string, string> = {
    customer: t(`${NS}.customer`),
    supplier: t(`${NS}.supplier`),
    other: t(`${NS}.other`),
  };

  const [search, setSearch] = useState("");
  const [branchIds, setBranchIds] = useState<number[]>([]);
  const branchKey = branchIds.length ? branchIds.slice().sort((a, b) => a - b).join(",") : "all";
  const [postRow,   setPostRow]   = useState<any>(null);
  const [delRow,    setDelRow]    = useState<any>(null);
  const [unpostRow, setUnpostRow] = useState<any>(null);

  const { data: vouchers = [], isLoading } = useQuery({
    queryKey: ["payment-vouchers", cid, branchKey],
    queryFn: () => {
      const params = new URLSearchParams();
      if (cid) params.set("companyId", String(cid));
      if (branchIds.length) params.set("branchIds", branchIds.join(","));
      return fetch(`${API}/api/payment-vouchers?${params.toString()}`, { headers: h }).then(r => r.json());
    },
    enabled: !!cid,
  });

  const filtered = (vouchers as any[]).filter((v: any) =>
    v.code?.includes(search) || v.description?.includes(search) || v.entityName?.includes(search)
  );
  const pager = usePagination(filtered);
  const totalAmount = (vouchers as any[])
    .filter((v: any) => v.status === "posted")
    .reduce((a: number, v: any) => a + parseFloat(v.amount || "0"), 0);

  function openAdd()  { navigate("/cash/payment-vouchers/new"); }
  function openEdit(r: any) { navigate(`/cash/payment-vouchers/${r.id}`); }

  const postMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/payment-vouchers/${id}/post`, { method: "POST", headers: h });
      if (!res.ok) throw new Error((await res.json()).error || t(`${NS}.err_post`));
      return res.json();
    },
    onSuccess: () => { toast({ title: t(`${NS}.posted_toast`) }); qc.invalidateQueries({ queryKey: ["payment-vouchers"] }); qc.invalidateQueries({ queryKey: ["purchase-invoices"] }); setPostRow(null); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async (id: number) => { const res = await fetch(`${API}/api/payment-vouchers/${id}`, { method: "DELETE", headers: h }); if (!res.ok && res.status !== 204) throw new Error((await res.json()).error); },
    onSuccess: () => { toast({ title: t(`${NS}.deleted_toast`) }); qc.invalidateQueries({ queryKey: ["payment-vouchers"] }); qc.invalidateQueries({ queryKey: ["purchase-invoices"] }); setDelRow(null); },
    onError: (e: any) => toast({ title: e.message || t(`${NS}.err_delete`), variant: "destructive" }),
  });

  const unpostMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/payment-vouchers/${id}/unpost`, { method: "POST", headers: h });
      if (!res.ok) throw new Error((await res.json()).error || t(`${NS}.err_unpost`));
      return res.json();
    },
    onSuccess: () => { toast({ title: t(`${NS}.unposted_toast`) }); qc.invalidateQueries({ queryKey: ["payment-vouchers"] }); qc.invalidateQueries({ queryKey: ["purchase-invoices"] }); setUnpostRow(null); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><ArrowUpCircle className="h-6 w-6 text-red-500" />{t(`${NS}.title`)}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t(`${NS}.subtitle`)}</p>
        </div>
        <Button onClick={openAdd} className="gap-2"><Plus className="h-4 w-4" />{t(`${NS}.newVoucher`)}</Button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {[
          { label: t(`${NS}.totalVouchers`), value: (vouchers as any[]).length, color: "text-primary bg-primary/10" },
          { label: t(`${NS}.posted`),         value: (vouchers as any[]).filter((v: any) => v.status === "posted").length, color: "text-green-700 bg-green-100" },
          { label: t(`${NS}.totalAmount`),    value: fmt(totalAmount), color: "text-red-700 bg-red-50" },
        ].map((s, i) => (
          <div key={i} className="rounded-xl border bg-card p-4">
            <p className="text-xl font-bold">{isLoading ? "—" : s.value}</p>
            <p className={`text-xs mt-1 font-medium px-2 py-0.5 rounded-full inline-block ${s.color}`}>{s.label}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="text-sm font-medium">{t(`${NS}.list`)}</p>
          <div className="flex items-center gap-2">
            <MultiBranchFilter value={branchIds} onChange={setBranchIds} size="sm" />
            <div className="relative">
              <Search className={`absolute ${isRtl ? "right-3" : "left-3"} top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground`} />
              <Input className={`${isRtl ? "pr-9" : "pl-9"} h-8 w-56 text-sm`} placeholder={t("cashCommon.search")} value={search} onChange={e => setSearch(e.target.value)} />
            </div>
          </div>
        </div>
        {(() => {
          const items: LegendItem[] = [
            { kind: "draft",  count: filtered.filter((v: any) => v.status === "draft").length },
            { kind: "posted", count: filtered.filter((v: any) => v.status === "posted").length },
          ];
          return <div className="px-3 pt-2"><DocColorLegend items={items} /></div>;
        })()}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/20 text-xs text-muted-foreground">
                <th className="h-9 px-4 text-start font-medium">{t(`${NS}.colCodeDate`)}</th>
                <th className="h-9 px-4 text-start font-medium">{t(`${NS}.colDescription`)}</th>
                <th className="h-9 px-4 text-start font-medium hidden md:table-cell">{t(`${NS}.colEntity`)}</th>
                <th className="h-9 px-4 text-start font-medium hidden md:table-cell">{t(`${NS}.colMethod`)}</th>
                <th className="h-9 px-4 text-start font-medium">{t(`${NS}.colAmount`)}</th>
                <th className="h-9 px-4 text-center font-medium hidden lg:table-cell">{t(`${NS}.colJournalNo`)}</th>
                <th className="h-9 px-4 text-center font-medium">{t(`${NS}.colStatus`)}</th>
                <th className="h-9 px-4 text-center font-medium w-28">{t(`${NS}.colActions`)}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? Array.from({ length: 4 }).map((_, i) => (
                <tr key={i} className="border-b"><td colSpan={8} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td></tr>
              )) : filtered.length === 0 ? (
                <tr><td colSpan={8} className="py-14 text-center text-muted-foreground">
                  <ArrowUpCircle className="h-8 w-8 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">{search ? t("cashCommon.noResults") : t(`${NS}.noVouchers`)}</p>
                  {!search && <Button variant="outline" size="sm" className="mt-3" onClick={openAdd}><Plus className={`h-3.5 w-3.5 ${isRtl ? "ml-1" : "mr-1"}`} />{t(`${NS}.newVoucher`)}</Button>}
                </td></tr>
              ) : pager.pagedItems.map((row: any) => (
                <tr key={row.id}
                    data-status={row.status}
                    onDoubleClick={() => openEdit(row)}
                    className={cn("border-b transition-colors cursor-pointer", rowToneFor({ status: row.status }))}
                    title={buildToneTooltip({ status: row.status })}>
                  <td className="px-4 py-3">
                    <p className="font-mono text-xs font-medium">{row.code}</p>
                    <p className="text-xs text-muted-foreground">{row.date}</p>
                  </td>
                  <td className="px-4 py-3 max-w-48">
                    <p className="text-sm truncate">{row.description || "—"}</p>
                    {row.refNumber && <p className="text-xs text-muted-foreground">{t(`${NS}.ref`, { value: row.refNumber })}</p>}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    <span className="text-xs bg-muted px-2 py-0.5 rounded-full">{ENTITY_LABELS[row.entityType] || "—"}</span>
                    {row.entityName && <p className="text-xs text-muted-foreground mt-0.5">{row.entityName}</p>}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${row.paymentType === "cash" ? "bg-amber-50 text-amber-700" : "bg-blue-50 text-blue-700"}`}>
                      {row.paymentType === "cash" ? t(`${NS}.cash`) : t(`${NS}.bank`)}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-medium text-red-600">
                    {fmt(row.amount)}
                  </td>
                  <td className="px-4 py-3 text-center hidden lg:table-cell">
                    {row.journalEntryId
                      ? <a href={`${import.meta.env.BASE_URL}accounting/journals/${row.journalEntryId}?tab=lines`} className="text-xs font-mono text-primary hover:underline" title={t(`${NS}.viewJournal`)}>JE-{row.journalEntryId}</a>
                      : <span className="text-xs text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {row.status === "posted"
                      ? <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded-full"><CheckCircle2 className="h-3 w-3" />{t("cashCommon.posted")}</span>
                      : <span className="inline-flex items-center gap-1 text-xs text-amber-600 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full"><Clock className="h-3 w-3" />{t("cashCommon.draft")}</span>}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="flex justify-center gap-1">
                      {row.status === "draft" ? <>
                        <button onClick={() => openEdit(row)} className="p-1.5 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors" title={t("cashCommon.edit", { defaultValue: "تعديل (خصائص)" })}><Pencil className="h-3.5 w-3.5" /></button>
                        <button onClick={() => navigate(`/cash/payment-vouchers/new?from=${row.id}`)} className="p-1.5 rounded hover:bg-blue-50 text-muted-foreground hover:text-blue-600 transition-colors" title="نسخة مماثلة"><Copy className="h-3.5 w-3.5" /></button>
                        <button onClick={() => setPostRow(row)} className="p-1.5 rounded hover:bg-green-50 text-muted-foreground hover:text-green-600 transition-colors" title={t(`${NS}.postBtn`)}><Send className="h-3.5 w-3.5" /></button>
                        <button onClick={() => setDelRow(row)} className="p-1.5 rounded hover:bg-red-50 text-muted-foreground hover:text-red-600 transition-colors" title={t("cashCommon.delete")}><Trash2 className="h-3.5 w-3.5" /></button>
                      </> : <>
                        <button onClick={() => openEdit(row)} className="p-1.5 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors" title="عرض / خصائص"><Pencil className="h-3.5 w-3.5" /></button>
                        <button onClick={() => navigate(`/cash/payment-vouchers/new?from=${row.id}`)} className="p-1.5 rounded hover:bg-blue-50 text-muted-foreground hover:text-blue-600 transition-colors" title="نسخة مماثلة"><Copy className="h-3.5 w-3.5" /></button>
                        <button onClick={() => setUnpostRow(row)} className="p-1.5 rounded hover:bg-amber-50 text-muted-foreground hover:text-amber-600 transition-colors" title={t(`${NS}.unpostBtn`)}><Undo2 className="h-3.5 w-3.5" /></button>
                      </>}
                    </div>
                  </td>
                </tr>
              ))}
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
            itemLabel={t("paymentVouchers.itemLabel", { defaultValue: "سند" })}
          />
        )}
      </div>


      <AlertDialog open={!!postRow} onOpenChange={v => { if (!v) setPostRow(null); }}>
        <AlertDialogContent dir={isRtl ? "rtl" : "ltr"}>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2"><Send className="h-5 w-5 text-green-600" />{t(`${NS}.postTitle`)}</AlertDialogTitle>
            <AlertDialogDescription>{t(`${NS}.postBody`, { code: postRow?.code, amount: fmt(postRow?.amount || 0) })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cashCommon.cancel")}</AlertDialogCancel>
            <AlertDialogAction className="bg-green-600 hover:bg-green-700" onClick={() => postMut.mutate(postRow.id)} disabled={postMut.isPending}>
              {postMut.isPending ? t(`${NS}.posting`) : t(`${NS}.postBtn`)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!unpostRow} onOpenChange={v => { if (!v) setUnpostRow(null); }}>
        <AlertDialogContent dir={isRtl ? "rtl" : "ltr"}>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2"><Undo2 className="h-5 w-5 text-amber-600" />{t(`${NS}.unpostTitle`)}</AlertDialogTitle>
            <AlertDialogDescription>{t(`${NS}.unpostBody`, { code: unpostRow?.code })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cashCommon.cancel")}</AlertDialogCancel>
            <AlertDialogAction className="bg-amber-600 hover:bg-amber-700" onClick={() => unpostMut.mutate(unpostRow.id)} disabled={unpostMut.isPending}>
              {unpostMut.isPending ? t(`${NS}.unposting`) : t(`${NS}.unpostBtn`)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!delRow} onOpenChange={v => { if (!v) setDelRow(null); }}>
        <AlertDialogContent dir={isRtl ? "rtl" : "ltr"}>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2"><Trash2 className="h-5 w-5 text-destructive" />{t(`${NS}.delTitle`)}</AlertDialogTitle>
            <AlertDialogDescription>{t(`${NS}.delBody`, { code: delRow?.code })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cashCommon.cancel")}</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive hover:bg-destructive/90" onClick={() => delMut.mutate(delRow.id)} disabled={delMut.isPending}>
              {delMut.isPending ? t(`${NS}.deleting`) : t(`${NS}.delBtn`)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
