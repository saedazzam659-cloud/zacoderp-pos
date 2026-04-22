import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useFormatters } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { AccountCombobox } from "@/components/AccountCombobox";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Wallet, Plus, Pencil, Trash2, AlertTriangle,
  TrendingUp, Search, CheckCircle2, XCircle, Info, SlidersHorizontal,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const EMPTY = { code: "", nameAr: "", nameEn: "", currencyId: "", accountId: "", minBalance: "", maxBalance: "", notes: "", isActive: true };

export default function CashBoxes() {
  const { user, token } = useAuth();
  const { toast } = useToast();
  const { t } = useTranslation();
  const { fmt, isRtl } = useFormatters();
  const qc = useQueryClient();
  const h = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [search,  setSearch]  = useState("");
  const [panel,   setPanel]   = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form,    setForm]    = useState<typeof EMPTY>(EMPTY);
  const [acctId,  setAcctId]  = useState("");
  const [delRow,  setDelRow]  = useState<any>(null);
  const [tab,     setTab]     = useState<"basic" | "limits">("basic");
  const [errors,  setErrors]  = useState<Record<string, string>>({});

  const { data: boxes = [], isLoading } = useQuery({
    queryKey: ["cash-boxes", cid],
    queryFn: () => fetch(`${API}/api/cash-boxes?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
  });
  const { data: balances = [] } = useQuery({
    queryKey: ["cash-boxes-bal", cid],
    queryFn: () => fetch(`${API}/api/cash-boxes/balances?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
  });
  const { data: currencies = [] } = useQuery({
    queryKey: ["currencies"],
    queryFn: () => fetch(`${API}/api/currencies`, { headers: h }).then(r => r.json()),
    enabled: !!user,
  });

  const balMap: Record<number, number> = Object.fromEntries((balances as any[]).map((b: any) => [b.cashBoxId, b.balance]));
  const filtered = (boxes as any[]).filter((b: any) => b.nameAr?.includes(search) || b.nameEn?.toLowerCase().includes(search.toLowerCase()) || b.code?.includes(search));

  function openAdd()  { setEditing(null); setForm(EMPTY); setAcctId(""); setErrors({}); setTab("basic"); setPanel(true); }
  function openEdit(r: any) {
    setEditing(r);
    setForm({ code: r.code ?? "", nameAr: r.nameAr ?? "", nameEn: r.nameEn ?? "", currencyId: r.currencyId ? String(r.currencyId) : "", accountId: "", minBalance: r.minBalance ?? "", maxBalance: r.maxBalance ?? "", notes: r.notes ?? "", isActive: r.isActive ?? true });
    setAcctId(r.accountId ? String(r.accountId) : "");
    setErrors({});
    setTab("basic");
    setPanel(true);
  }

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!form.code.trim())   e.code   = t("cashBoxes.codeRequired");
    else if (form.code.trim().length > 20) e.code = t("cashBoxes.codeTooLong");
    if (!form.nameAr.trim()) e.nameAr = t("cashBoxes.nameArRequired");
    else if (form.nameAr.trim().length < 2) e.nameAr = t("cashBoxes.nameArShort");
    if (form.minBalance && isNaN(Number(form.minBalance))) e.minBalance = t("cashBoxes.invalidValue");
    else if (form.minBalance && Number(form.minBalance) < 0) e.minBalance = t("cashBoxes.cannotBeNegative");
    if (form.maxBalance && isNaN(Number(form.maxBalance))) e.maxBalance = t("cashBoxes.invalidValue");
    else if (form.maxBalance && Number(form.maxBalance) < 0) e.maxBalance = t("cashBoxes.cannotBeNegative");
    if (form.minBalance && form.maxBalance && Number(form.maxBalance) > 0 && Number(form.minBalance) > Number(form.maxBalance)) {
      e.maxBalance = t("cashBoxes.maxMustBeGreater");
    }
    setErrors(e);
    if (e.code || e.nameAr) setTab("basic");
    else if (e.minBalance || e.maxBalance) setTab("limits");
    return Object.keys(e).length === 0;
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      const body = { ...form, companyId: cid, accountId: acctId ? parseInt(acctId) : null, currencyId: form.currencyId ? parseInt(form.currencyId) : null };
      const url  = editing ? `${API}/api/cash-boxes/${editing.id}` : `${API}/api/cash-boxes`;
      const res  = await fetch(url, { method: editing ? "PUT" : "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        const txt = await res.text();
        let msg = txt;
        try { msg = JSON.parse(txt).error ?? txt; } catch {}
        throw new Error(msg || t("cashBoxes.err_generic"));
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: editing ? t("cashBoxes.saved_update") : t("cashBoxes.saved_create") });
      qc.invalidateQueries({ queryKey: ["cash-boxes"] });
      qc.invalidateQueries({ queryKey: ["cash-boxes-bal"] });
      setPanel(false);
    },
    onError: (e: any) => toast({ title: t("cashBoxes.err_save"), description: e?.message || t("cashBoxes.err_generic"), variant: "destructive" }),
  });

  const dupCode = form.code.trim() && (boxes as any[]).some((b: any) =>
    b.code?.trim().toLowerCase() === form.code.trim().toLowerCase() && b.id !== editing?.id);
  const dupAccount = acctId && (boxes as any[]).some((b: any) =>
    b.accountId === parseInt(acctId) && b.id !== editing?.id);

  const delMut = useMutation({
    mutationFn: async (id: number) => {
      await fetch(`${API}/api/cash-boxes/${id}`, { method: "DELETE", headers: h });
    },
    onSuccess: () => { toast({ title: t("cashBoxes.deleted_toast") }); qc.invalidateQueries({ queryKey: ["cash-boxes"] }); setDelRow(null); },
    onError: () => toast({ title: t("cashBoxes.err_delete"), variant: "destructive" }),
  });

  function f(name: keyof typeof EMPTY) {
    return {
      value: form[name] as string,
      onChange: (e: any) => {
        setForm(p => ({ ...p, [name]: e.target.value }));
        if (errors[name as string]) setErrors(p => { const n = { ...p }; delete n[name as string]; return n; });
      },
    };
  }
  const errCls = "border-destructive focus-visible:ring-destructive/40";

  const totalBalance = Object.values(balMap).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Wallet className="h-6 w-6 text-primary" />{t("cashBoxes.title")}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t("cashBoxes.subtitle")}</p>
        </div>
        <Button onClick={openAdd} className="gap-2"><Plus className="h-4 w-4" />{t("cashBoxes.add")}</Button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {[
          { label: t("cashBoxes.totalBoxes"),    value: (boxes as any[]).length, icon: Wallet, color: "text-primary bg-primary/10" },
          { label: t("cashBoxes.totalBalance"),  value: fmt(totalBalance),       icon: TrendingUp, color: "text-green-700 bg-green-100" },
          { label: t("cashBoxes.activeBoxes"),   value: (boxes as any[]).filter((b: any) => b.isActive).length, icon: CheckCircle2, color: "text-blue-700 bg-blue-100" },
        ].map((s, i) => (
          <div key={i} className="rounded-xl border bg-card p-4 flex items-center gap-3">
            <div className={`h-10 w-10 rounded-lg flex items-center justify-center shrink-0 ${s.color}`}>
              <s.icon className="h-5 w-5" />
            </div>
            <div><p className="text-xl font-bold">{isLoading ? "—" : s.value}</p><p className="text-xs text-muted-foreground">{s.label}</p></div>
          </div>
        ))}
      </div>

      {panel && (
        <FormPanel
          icon={Wallet}
          title={editing ? t("cashBoxes.edit") : t("cashBoxes.addLong")}
          subtitle={t("cashBoxes.formSubtitle")}
          onClose={() => setPanel(false)}
          onSave={() => { if (validate()) saveMut.mutate(); }}
          saving={saveMut.isPending}
        >
          {(dupCode || dupAccount) && (
            <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <div className="space-y-1">
                {dupCode && <p>{t("cashBoxes.warnDupCode", { code: form.code })}</p>}
                {dupAccount && <p>{t("cashBoxes.warnDupAccount")}</p>}
              </div>
            </div>
          )}

          <Tabs value={tab} onValueChange={v => setTab(v as "basic" | "limits")} dir={isRtl ? "rtl" : "ltr"}>
            <TabsList className={`grid grid-cols-2 w-full max-w-md ${isRtl ? "mr-auto" : "ml-auto"} mb-5`}>
              <TabsTrigger value="basic" className="gap-1.5">
                <Info className="h-3.5 w-3.5" />
                {t("cashBoxes.tabBasic")}
                {(errors.code || errors.nameAr) && <span className="h-1.5 w-1.5 rounded-full bg-destructive" />}
              </TabsTrigger>
              <TabsTrigger value="limits" className="gap-1.5">
                <SlidersHorizontal className="h-3.5 w-3.5" />
                {t("cashBoxes.tabLimits")}
                {(errors.minBalance || errors.maxBalance) && <span className="h-1.5 w-1.5 rounded-full bg-destructive" />}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="basic" className="mt-0">
              <FormGrid>
                <Field label={t("cashBoxes.code")} required hint={errors.code && <span className="text-destructive">{errors.code}</span>}>
                  <Input placeholder="C001" className={errors.code ? errCls : ""} {...f("code")} />
                </Field>
                <Field label={t("cashBoxes.nameAr")} required hint={errors.nameAr && <span className="text-destructive">{errors.nameAr}</span>}>
                  <Input className={errors.nameAr ? errCls : ""} {...f("nameAr")} />
                </Field>
                <Field label={t("cashBoxes.nameEn")} className="md:col-span-2">
                  <Input placeholder={t("cashBoxes.nameEnPh")} dir="ltr" className="text-left" {...f("nameEn")} />
                </Field>
                <Field label={t("cashCommon.currency")}>
                  <select
                    className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background"
                    value={form.currencyId}
                    onChange={e => setForm(p => ({ ...p, currencyId: e.target.value }))}
                  >
                    <option value="">{t("cashCommon.selectCurrency")}</option>
                    {(currencies as any[]).map((c: any) => <option key={c.id} value={c.id}>{c.code} — {isRtl ? c.nameAr : (c.nameEn || c.nameAr)}</option>)}
                  </select>
                </Field>
                <Field label={t("cashCommon.account")}>
                  <AccountCombobox value={acctId} onValueChange={setAcctId} placeholder={t("cashCommon.selectAccount")} filterTypes={["asset"]} grouped={false} />
                </Field>
              </FormGrid>
            </TabsContent>

            <TabsContent value="limits" className="mt-0">
              <FormGrid>
                <Field label={t("cashBoxes.minBalance")} hint={errors.minBalance && <span className="text-destructive">{errors.minBalance}</span>}>
                  <Input type="number" placeholder="0" className={errors.minBalance ? errCls : ""} {...f("minBalance")} />
                </Field>
                <Field label={t("cashBoxes.maxBalance")} hint={errors.maxBalance && <span className="text-destructive">{errors.maxBalance}</span>}>
                  <Input type="number" placeholder="—" className={errors.maxBalance ? errCls : ""} {...f("maxBalance")} />
                </Field>
                <Field label={t("cashCommon.notes")} className="md:col-span-2">
                  <Input placeholder={t("cashCommon.notesPlaceholder")} {...f("notes")} />
                </Field>
                <div className="md:col-span-2">
                  <label className="flex items-center gap-2 cursor-pointer w-fit">
                    <input type="checkbox" checked={form.isActive} onChange={e => setForm(p => ({ ...p, isActive: e.target.checked }))} className="rounded" />
                    <span className="text-sm">{t("cashBoxes.isActive")}</span>
                  </label>
                </div>
              </FormGrid>
            </TabsContent>
          </Tabs>
        </FormPanel>
      )}

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="text-sm font-medium">{t("cashBoxes.list")}</p>
          <div className="relative">
            <Search className={`absolute ${isRtl ? "right-3" : "left-3"} top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground`} />
            <Input className={`${isRtl ? "pr-9" : "pl-9"} h-8 w-56 text-sm`} placeholder={t("cashCommon.search")} value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/20 text-xs text-muted-foreground">
                <th className="h-9 px-4 text-start font-medium">{t("cashBoxes.colCode")}</th>
                <th className="h-9 px-4 text-start font-medium">{t("cashBoxes.colName")}</th>
                <th className="h-9 px-4 text-start font-medium hidden md:table-cell">{t("cashBoxes.colCurrency")}</th>
                <th className="h-9 px-4 text-start font-medium">{t("cashBoxes.colCurrentBalance")}</th>
                <th className="h-9 px-4 text-start font-medium hidden sm:table-cell">{t("cashBoxes.colMin")}</th>
                <th className="h-9 px-4 text-start font-medium hidden sm:table-cell">{t("cashBoxes.colMax")}</th>
                <th className="h-9 px-4 text-center font-medium">{t("cashBoxes.colStatus")}</th>
                <th className="h-9 px-4 text-center font-medium w-20">{t("cashBoxes.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? Array.from({ length: 3 }).map((_, i) => (
                <tr key={i} className="border-b"><td colSpan={8} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td></tr>
              )) : filtered.length === 0 ? (
                <tr><td colSpan={8} className="py-14 text-center text-muted-foreground">
                  <Wallet className="h-8 w-8 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">{search ? t("cashCommon.noResults") : t("cashBoxes.noBoxes")}</p>
                  {!search && <Button variant="outline" size="sm" className="mt-3" onClick={openAdd}><Plus className={`h-3.5 w-3.5 ${isRtl ? "ml-1" : "mr-1"}`} />{t("cashBoxes.add")}</Button>}
                </td></tr>
              ) : filtered.map((row: any) => {
                const bal = balMap[row.id] ?? 0;
                const min = parseFloat(row.minBalance ?? "0");
                const low = bal < min && min > 0;
                const max = parseFloat(row.maxBalance ?? "0");
                const high = max > 0 && bal > max;
                const displayName = isRtl ? row.nameAr : (row.nameEn || row.nameAr);
                const subName     = isRtl ? row.nameEn : (row.nameEn ? row.nameAr : null);
                return (
                  <tr key={row.id} onDoubleClick={() => openEdit(row)} className="border-b hover:bg-muted/20 transition-colors cursor-pointer" title={t("cashCommon.doubleClickEdit")}>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{row.code}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-7 w-7 rounded-lg bg-primary/10 text-primary font-bold text-xs flex items-center justify-center">{displayName?.[0] ?? "C"}</div>
                        <div>
                          <p className="font-medium">{displayName}</p>
                          {subName && <p className="text-xs text-muted-foreground">{subName}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell text-xs text-muted-foreground">
                      {currencies.find((c: any) => c.id === row.currencyId)?.code ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 text-xs font-medium ${low ? "text-red-600" : high ? "text-orange-600" : "text-foreground"}`}>
                        {low && <AlertTriangle className="h-3 w-3" />}
                        {high && <AlertTriangle className="h-3 w-3" />}
                        {fmt(bal)}
                      </span>
                      {low  && <p className="text-xs text-red-500">{t("cashBoxes.belowMin")}</p>}
                      {high && <p className="text-xs text-orange-500">{t("cashBoxes.aboveMax")}</p>}
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell text-xs text-muted-foreground">{row.minBalance ? fmt(row.minBalance) : "—"}</td>
                    <td className="px-4 py-3 hidden sm:table-cell text-xs text-muted-foreground">{row.maxBalance ? fmt(row.maxBalance) : "—"}</td>
                    <td className="px-4 py-3 text-center">
                      {row.isActive
                        ? <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded-full"><CheckCircle2 className="h-3 w-3" />{t("cashCommon.active")}</span>
                        : <span className="inline-flex items-center gap-1 text-xs text-gray-500 bg-gray-50 border border-gray-200 px-2 py-0.5 rounded-full"><XCircle className="h-3 w-3" />{t("cashCommon.inactive")}</span>}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex justify-center gap-1">
                        <button onClick={() => openEdit(row)} className="p-1.5 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors"><Pencil className="h-3.5 w-3.5" /></button>
                        <button onClick={() => setDelRow(row)} className="p-1.5 rounded hover:bg-red-50 text-muted-foreground hover:text-red-600 transition-colors"><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!isLoading && filtered.length > 0 && (
          <div className="border-t bg-muted/20 px-4 py-2 text-xs text-muted-foreground">{t("cashCommon.resultsCount", { count: filtered.length })}</div>
        )}
      </div>


      <AlertDialog open={!!delRow} onOpenChange={v => { if (!v) setDelRow(null); }}>
        <AlertDialogContent dir={isRtl ? "rtl" : "ltr"}>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2"><Trash2 className="h-5 w-5 text-destructive" />{t("cashBoxes.delTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("cashBoxes.delBody", { name: isRtl ? delRow?.nameAr : (delRow?.nameEn || delRow?.nameAr) })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cashCommon.cancel")}</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive hover:bg-destructive/90" onClick={() => delMut.mutate(delRow.id)} disabled={delMut.isPending}>
              {delMut.isPending ? t("cashCommon.loading") : t("cashCommon.confirmDelete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
