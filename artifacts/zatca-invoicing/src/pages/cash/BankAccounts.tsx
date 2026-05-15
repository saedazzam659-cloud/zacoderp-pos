import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import MultiBranchFilter from "@/components/MultiBranchFilter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useFormatters } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { AccountCombobox } from "@/components/AccountCombobox";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { TablePagination, usePagination } from "@/components/TablePagination";
import { Landmark, Plus, Pencil, Trash2, Search, CheckCircle2, XCircle, TrendingUp, CreditCard, AlertTriangle, Check, X, ChevronsUpDown, Building2 } from "lucide-react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const EMPTY = { code: "", nameAr: "", nameEn: "", bankName: "", bankNameEn: "", accountNumber: "", iban: "", swiftCode: "", currencyId: "", branchIds: [] as number[], notes: "", isActive: true };

// ─── BranchMultiSelect ────────────────────────────────────────────────────────
// Searchable multi-select dropdown for picking the branches a bank account
// belongs to. Renders selected branches as pills with a quick-remove button.
function BranchMultiSelect({
  branches,
  value,
  onChange,
  isRtl,
  disabled,
}: {
  branches: any[];
  value: number[];
  onChange: (next: number[]) => void;
  isRtl: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const filtered = branches.filter((b: any) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      b.code?.toLowerCase().includes(s) ||
      b.nameAr?.includes(search) ||
      b.nameEn?.toLowerCase().includes(s)
    );
  });
  const selectedSet = new Set(value);
  const toggle = (id: number) => {
    if (selectedSet.has(id)) onChange(value.filter(v => v !== id));
    else onChange([...value, id]);
  };
  const clearOne = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(value.filter(v => v !== id));
  };
  const selectedBranches = value
    .map(id => branches.find((b: any) => b.id === id))
    .filter(Boolean);

  return (
    <Popover open={open} onOpenChange={o => { setOpen(o); if (!o) setSearch(""); }}>
      <PopoverAnchor asChild>
        <div
          className={cn(
            "min-h-9 w-full rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm cursor-text",
            "focus-within:ring-1 focus-within:ring-ring",
            disabled && "opacity-50 cursor-not-allowed",
          )}
          onClick={() => !disabled && setOpen(true)}
        >
          <div className="flex flex-wrap items-center gap-1">
            {selectedBranches.length === 0 && (
              <span className="text-muted-foreground text-sm py-1 px-1">— لم يُحدَّد فرع —</span>
            )}
            {selectedBranches.map((b: any) => (
              <span
                key={b.id}
                className="inline-flex items-center gap-1 bg-primary/10 text-primary border border-primary/20 rounded-full ps-2 pe-1 py-0.5 text-xs"
                onClick={e => e.stopPropagation()}
              >
                <Building2 className="h-3 w-3" />
                <span className="font-medium">{b.code}</span>
                <span>—</span>
                <span>{isRtl ? b.nameAr : (b.nameEn || b.nameAr)}</span>
                {!disabled && (
                  <button
                    type="button"
                    onClick={e => clearOne(b.id, e)}
                    className="ms-0.5 rounded-full hover:bg-primary/20 p-0.5"
                    aria-label="إزالة"
                    tabIndex={-1}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </span>
            ))}
            <div className="ms-auto flex items-center gap-1 self-stretch text-muted-foreground">
              <ChevronsUpDown className="h-3.5 w-3.5 opacity-50" />
            </div>
          </div>
        </div>
      </PopoverAnchor>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0 min-w-[280px]"
        align="start"
        side="bottom"
        onOpenAutoFocus={e => e.preventDefault()}
      >
        <div className="p-2 border-b">
          <div className="relative">
            <Search className={`absolute ${isRtl ? "right-2" : "left-2"} top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground`} />
            <Input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="ابحث عن فرع..."
              className={`h-8 ${isRtl ? "pr-8" : "pl-8"} text-sm`}
            />
          </div>
          {value.length > 0 && (
            <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
              <span>تم اختيار {value.length} فرع</span>
              <button
                type="button"
                onClick={() => onChange([])}
                className="text-destructive hover:underline"
              >
                مسح الكل
              </button>
            </div>
          )}
        </div>
        <div className="max-h-64 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">لا توجد نتائج</div>
          ) : filtered.map((b: any) => {
            const sel = selectedSet.has(b.id);
            return (
              <div
                key={b.id}
                onClick={() => toggle(b.id)}
                className={cn(
                  "px-2 py-2 mx-1 rounded-sm cursor-pointer flex items-start gap-2 text-sm",
                  sel ? "bg-primary/10" : "hover:bg-muted/60",
                )}
              >
                <Check className={cn("h-4 w-4 mt-0.5 shrink-0 text-primary", sel ? "opacity-100" : "opacity-0")} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-[10px] bg-muted px-1.5 py-0.5 rounded border shrink-0">{b.code}</span>
                    <span className="font-medium">{isRtl ? b.nameAr : (b.nameEn || b.nameAr)}</span>
                    {b.isMain && (
                      <span className="text-[10px] bg-amber-100 text-amber-800 border border-amber-200 px-1.5 py-0.5 rounded">رئيسي</span>
                    )}
                  </div>
                  {b.nameEn && isRtl && (
                    <p className="text-[11px] text-muted-foreground mt-0.5 truncate" dir="ltr">{b.nameEn}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default function BankAccounts() {
  const { user, token } = useAuth();
  const { toast } = useToast();
  const { t } = useTranslation();
  const { fmt, isRtl } = useFormatters();
  const qc = useQueryClient();
  const h = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [search,  setSearch]  = useState("");
  const [branchIds, setBranchIds] = useState<number[]>([]);
  const branchKey = branchIds.length ? branchIds.slice().sort((a, b) => a - b).join(",") : "all";
  const [panel,   setPanel]   = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form,    setForm]    = useState<typeof EMPTY>(EMPTY);
  const [acctId,  setAcctId]  = useState("");
  const [delRow,  setDelRow]  = useState<any>(null);

  const { data: banks = [], isLoading } = useQuery({
    queryKey: ["bank-accounts", cid, branchKey],
    queryFn: () => {
      const params = new URLSearchParams();
      if (cid) params.set("companyId", String(cid));
      if (branchIds.length) params.set("branchIds", branchIds.join(","));
      return fetch(`${API}/api/bank-accounts?${params.toString()}`, { headers: h }).then(r => r.json());
    },
    enabled: !!cid,
  });
  const { data: balances = [] } = useQuery({
    queryKey: ["bank-accounts-bal", cid],
    queryFn: () => fetch(`${API}/api/bank-accounts/balances?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
  });
  const { data: currencies = [] } = useQuery({
    queryKey: ["currencies", cid],
    queryFn: () => fetch(`${API}/api/currencies?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
  });
  const { data: branches = [] } = useQuery({
    queryKey: ["branches", cid],
    queryFn: () => fetch(`${API}/api/org/branches?companyId=${cid}`, { headers: h }).then(r => r.json()),
    enabled: !!cid,
  });
  const defaultCurrencyId = (currencies as any[]).find((c: any) => c.isDefault)?.id ?? (currencies as any[])[0]?.id ?? null;
  const defaultBranchId   = (branches   as any[]).find((b: any) => b.isMain)?.id   ?? (branches   as any[])[0]?.id ?? null;

  useEffect(() => {
    if (panel && !editing && !form.currencyId && defaultCurrencyId) {
      setForm(p => ({ ...p, currencyId: String(defaultCurrencyId) }));
    }
    if (panel && !editing && form.branchIds.length === 0 && defaultBranchId) {
      setForm(p => ({ ...p, branchIds: [defaultBranchId] }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, editing, defaultCurrencyId, defaultBranchId]);

  const balMap: Record<number, number> = Object.fromEntries((balances as any[]).map((b: any) => [b.bankAccountId, b.balance]));
  const filtered = (banks as any[]).filter((b: any) => {
    const s = search.toLowerCase();
    return b.nameAr?.includes(search) || b.nameEn?.toLowerCase().includes(s) || b.code?.toLowerCase().includes(s) || b.bankName?.includes(search) || b.bankNameEn?.toLowerCase().includes(s) || b.iban?.toLowerCase().includes(s);
  });

  const pager = usePagination(filtered);

  function openAdd()  {
    setEditing(null);
    setForm({ ...EMPTY, currencyId: defaultCurrencyId ? String(defaultCurrencyId) : "" });
    setAcctId(""); setPanel(true);
  }
  function openEdit(r: any) {
    setEditing(r);
    const branchIds: number[] = Array.isArray(r.branchIds) && r.branchIds.length
      ? r.branchIds.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n))
      : (r.branchId ? [Number(r.branchId)] : []);
    setForm({ code: r.code ?? "", nameAr: r.nameAr ?? "", nameEn: r.nameEn ?? "", bankName: r.bankName ?? "", bankNameEn: r.bankNameEn ?? "", accountNumber: r.accountNumber ?? "", iban: r.iban ?? "", swiftCode: r.swiftCode ?? "", currencyId: r.currencyId ? String(r.currencyId) : "", branchIds, notes: r.notes ?? "", isActive: r.isActive ?? true });
    setAcctId(r.accountId ? String(r.accountId) : "");
    setPanel(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      const body = {
        ...form,
        companyId: cid,
        accountId: acctId ? parseInt(acctId) : null,
        currencyId: form.currencyId ? parseInt(form.currencyId) : null,
        // Multi-branch — server stores as int[]; legacy `branchId` kept in
        // sync server-side from `branchIds[0]`.
        branchIds: form.branchIds,
      };
      const url  = editing ? `${API}/api/bank-accounts/${editing.id}` : `${API}/api/bank-accounts`;
      const res  = await fetch(url, { method: editing ? "PUT" : "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        const txt = await res.text();
        let msg = txt;
        try { msg = JSON.parse(txt).error ?? txt; } catch {}
        throw new Error(msg || t("bankAccounts.err_generic"));
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: editing ? t("bankAccounts.saved_update") : t("bankAccounts.saved_create") });
      qc.invalidateQueries({ queryKey: ["bank-accounts"] });
      qc.invalidateQueries({ queryKey: ["bank-accounts-bal"] });
      setPanel(false);
    },
    onError: (e: any) => toast({ title: t("bankAccounts.err_save"), description: e?.message || t("bankAccounts.err_generic"), variant: "destructive" }),
  });

  const dupCode = form.code.trim() && (banks as any[]).some((b: any) =>
    b.code?.trim().toLowerCase() === form.code.trim().toLowerCase() && b.id !== editing?.id);
  const dupIban = form.iban.trim() && (banks as any[]).some((b: any) =>
    b.iban?.trim() === form.iban.trim() && b.id !== editing?.id);
  const dupAccount = acctId && (banks as any[]).some((b: any) =>
    b.accountId === parseInt(acctId) && b.id !== editing?.id);

  const delMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/bank-accounts/${id}`, { method: "DELETE", headers: h });
      if (!res.ok) {
        const txt = await res.text();
        let msg = txt;
        try { msg = JSON.parse(txt).error ?? txt; } catch {}
        throw new Error(msg || t("bankAccounts.err_delete"));
      }
    },
    onSuccess: () => { toast({ title: t("bankAccounts.deleted_toast") }); qc.invalidateQueries({ queryKey: ["bank-accounts"] }); qc.invalidateQueries({ queryKey: ["bank-accounts-bal"] }); setDelRow(null); },
    onError: (e: any) => toast({ title: t("bankAccounts.err_delete"), description: e?.message, variant: "destructive" }),
  });

  function f(name: keyof typeof EMPTY) {
    return { value: form[name] as string, onChange: (e: any) => setForm(p => ({ ...p, [name]: e.target.value })) };
  }
  const totalBalance = Object.values(balMap).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Landmark className="h-6 w-6 text-primary" />{t("bankAccounts.title")}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t("bankAccounts.subtitle")}</p>
        </div>
        <Button onClick={openAdd} className="gap-2"><Plus className="h-4 w-4" />{t("bankAccounts.add")}</Button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {[
          { label: t("bankAccounts.totalAccounts"), value: (banks as any[]).length, icon: Landmark, color: "text-primary bg-primary/10" },
          { label: t("bankAccounts.totalBalances"), value: fmt(totalBalance),       icon: TrendingUp, color: "text-green-700 bg-green-100" },
          { label: t("bankAccounts.activeAccounts"), value: (banks as any[]).filter((b: any) => b.isActive).length, icon: CheckCircle2, color: "text-blue-700 bg-blue-100" },
        ].map((s, i) => (
          <div key={i} className="rounded-xl border bg-card p-4 flex items-center gap-3">
            <div className={`h-10 w-10 rounded-lg flex items-center justify-center shrink-0 ${s.color}`}><s.icon className="h-5 w-5" /></div>
            <div><p className="text-xl font-bold">{isLoading ? "—" : s.value}</p><p className="text-xs text-muted-foreground">{s.label}</p></div>
          </div>
        ))}
      </div>

      {panel && (
        <FormPanel
          icon={Landmark}
          title={editing ? t("bankAccounts.edit") : t("bankAccounts.addLong")}
          subtitle={t("bankAccounts.formSubtitle")}
          width="4xl"
          onClose={() => setPanel(false)}
          onSave={() => saveMut.mutate()}
          saving={saveMut.isPending}
          saveDisabled={!form.nameAr}
        >
          {(dupCode || dupIban || dupAccount) && (
            <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <div className="space-y-1">
                {dupCode && <p>{t("bankAccounts.warnDupCode", { code: form.code })}</p>}
                {dupIban && <p>{t("bankAccounts.warnDupIban")}</p>}
                {dupAccount && <p>{t("bankAccounts.warnDupAccount")}</p>}
              </div>
            </div>
          )}
          <FormGrid>
            <Field label={t("bankAccounts.code")} hint={<span className="text-muted-foreground text-xs">يُولَّد تلقائياً عند الترك فارغاً</span>}><Input placeholder="BA-0001" {...f("code")} /></Field>
            <Field label={t("bankAccounts.nameAr")} required><Input {...f("nameAr")} /></Field>
            <Field label={t("bankAccounts.nameEn")} className="md:col-span-2">
              <Input placeholder="Riyadh Bank" dir="ltr" className="text-left" {...f("nameEn")} />
            </Field>
            <Field label={t("bankAccounts.bankNameAr")}><Input {...f("bankName")} /></Field>
            <Field label={t("bankAccounts.bankNameEn")}><Input placeholder="Riyadh Bank" dir="ltr" className="text-left" {...f("bankNameEn")} /></Field>
            <Field label={t("bankAccounts.accountNumber")}><Input placeholder="0000000000" dir="ltr" className="text-left font-mono" {...f("accountNumber")} /></Field>
            <Field label={t("bankAccounts.swiftCode")}><Input placeholder="RIBLSARI" dir="ltr" className="text-left font-mono" {...f("swiftCode")} /></Field>
            <Field label={t("bankAccounts.iban")} className="md:col-span-2">
              <Input placeholder="SA0000000000000000000000" dir="ltr" className="text-left font-mono" {...f("iban")} />
            </Field>
            <Field label={t("cashCommon.currency")}>
              <select className="w-full h-9 border border-input rounded-md px-3 text-sm bg-background" value={form.currencyId} onChange={e => setForm(p => ({ ...p, currencyId: e.target.value }))}>
                <option value="">{t("cashCommon.selectCurrency")}</option>
                {(currencies as any[]).map((c: any) => <option key={c.id} value={c.id}>{c.code} — {isRtl ? c.nameAr : (c.nameEn || c.nameAr)}</option>)}
              </select>
            </Field>
            <Field label="الفروع" hint={<span className="text-muted-foreground text-xs">يمكن ربط الحساب بأكثر من فرع — اتركه فارغاً ليكون مشتركاً بين كل الفروع</span>}>
              <BranchMultiSelect
                branches={branches as any[]}
                value={form.branchIds}
                onChange={next => setForm(p => ({ ...p, branchIds: next }))}
                isRtl={isRtl}
              />
            </Field>
            <Field label={t("cashCommon.account")} className="md:col-span-2">
              <AccountCombobox value={acctId} onValueChange={setAcctId} placeholder={t("cashCommon.selectAccount")} filterTypes={["asset"]} grouped={false} />
            </Field>
            <Field label={t("cashCommon.notes")} className="md:col-span-2"><Input placeholder={t("cashCommon.notesPlaceholder")} {...f("notes")} /></Field>
            <div className="md:col-span-2">
              <label className="flex items-center gap-2 cursor-pointer w-fit">
                <input type="checkbox" checked={form.isActive} onChange={e => setForm(p => ({ ...p, isActive: e.target.checked }))} className="rounded" />
                <span className="text-sm">{t("bankAccounts.isActive")}</span>
              </label>
            </div>
          </FormGrid>
        </FormPanel>
      )}

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="text-sm font-medium">{t("bankAccounts.list")}</p>
          <div className="flex items-center gap-2">
            <MultiBranchFilter value={branchIds} onChange={setBranchIds} size="sm" />
            <div className="relative">
              <Search className={`absolute ${isRtl ? "right-3" : "left-3"} top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground`} />
              <Input className={`${isRtl ? "pr-9" : "pl-9"} h-8 w-56 text-sm`} placeholder={t("cashCommon.search")} value={search} onChange={e => setSearch(e.target.value)} />
            </div>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/20 text-xs text-muted-foreground">
                <th className="h-9 px-4 text-start font-medium">{t("bankAccounts.colCodeName")}</th>
                <th className="h-9 px-4 text-start font-medium hidden md:table-cell">{t("bankAccounts.colBank")}</th>
                <th className="h-9 px-4 text-start font-medium hidden lg:table-cell">{t("bankAccounts.colIban")}</th>
                <th className="h-9 px-4 text-start font-medium hidden md:table-cell">{t("bankAccounts.colCurrency")}</th>
                <th className="h-9 px-4 text-start font-medium">{t("bankAccounts.colBalance")}</th>
                <th className="h-9 px-4 text-center font-medium">{t("bankAccounts.colStatus")}</th>
                <th className="h-9 px-4 text-center font-medium w-20">{t("bankAccounts.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? Array.from({ length: 3 }).map((_, i) => (
                <tr key={i} className="border-b"><td colSpan={7} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td></tr>
              )) : filtered.length === 0 ? (
                <tr><td colSpan={7} className="py-14 text-center text-muted-foreground">
                  <Landmark className="h-8 w-8 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">{search ? t("cashCommon.noResults") : t("bankAccounts.noAccounts")}</p>
                  {!search && <Button variant="outline" size="sm" className="mt-3" onClick={openAdd}><Plus className={`h-3.5 w-3.5 ${isRtl ? "ml-1" : "mr-1"}`} />{t("bankAccounts.add")}</Button>}
                </td></tr>
              ) : pager.pagedItems.map((row: any) => {
                const bal = balMap[row.id] ?? 0;
                const displayName = isRtl ? row.nameAr : (row.nameEn || row.nameAr);
                const bankDisplay = isRtl ? row.bankName : (row.bankNameEn || row.bankName);
                return (
                  <tr key={row.id} onDoubleClick={() => openEdit(row)} className="border-b hover:bg-muted/20 transition-colors cursor-pointer" title={t("cashCommon.doubleClickEdit")}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-7 w-7 rounded-lg bg-blue-100 text-blue-700 font-bold text-xs flex items-center justify-center"><CreditCard className="h-4 w-4" /></div>
                        <div>
                          <p className="font-medium">{displayName}</p>
                          <p className="text-xs text-muted-foreground font-mono">{row.code}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <p className="text-sm">{bankDisplay || "—"}</p>
                      {row.accountNumber && <p className="text-xs text-muted-foreground font-mono">{row.accountNumber}</p>}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell font-mono text-xs text-muted-foreground">{row.iban || "—"}</td>
                    <td className="px-4 py-3 hidden md:table-cell text-xs text-muted-foreground">
                      {currencies.find((c: any) => c.id === row.currencyId)?.code ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-sm font-medium ${bal >= 0 ? "text-green-700" : "text-red-600"}`}>
                        {fmt(bal)}
                      </span>
                    </td>
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
          <TablePagination
            page={pager.page}
            pageSize={pager.pageSize}
            pageCount={pager.pageCount}
            total={pager.total}
            onPageChange={pager.setPage}
            onPageSizeChange={pager.setPageSize}
            itemLabel={t("bankAccounts.itemLabel", { defaultValue: "حساب بنكي" })}
          />
        )}
      </div>


      <AlertDialog open={!!delRow} onOpenChange={v => { if (!v) setDelRow(null); }}>
        <AlertDialogContent dir={isRtl ? "rtl" : "ltr"}>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2"><Trash2 className="h-5 w-5 text-destructive" />{t("bankAccounts.delTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("bankAccounts.delBody", { name: isRtl ? delRow?.nameAr : (delRow?.nameEn || delRow?.nameAr) })}</AlertDialogDescription>
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
