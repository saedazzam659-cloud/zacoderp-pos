import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useFormatters } from "@/lib/format";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { SearchCombobox } from "@/components/ui/search-combobox";
import ExportButtons from "@/components/ExportButtons";
import AccountsImportPanel from "@/components/AccountsImportPanel";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { Plus, Pencil, Trash2, BookOpen, Search, ChevronLeft, ChevronRight, Network } from "lucide-react";
import { cn } from "@/lib/utils";
import { AccountTreePickerDialog } from "@/components/AccountTreePickerDialog";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const DEFAULT_DIRECTION: Record<string, string> = {
  asset:     "balance_sheet",
  liability: "balance_sheet",
  equity:    "balance_sheet",
  revenue:   "income_statement",
  expense:   "income_statement",
};

const EMPTY: any = {
  code: "", nameAr: "", nameEn: "", accountType: "asset",
  reportDirection: "", parentId: "", level: 1, isPosting: true, isActive: true, notes: "",
};

export default function ChartOfAccounts() {
  const { user, token } = useAuth() as any;
  const { t } = useTranslation();
  const { fmt, isRtl } = useFormatters();
  const { toast } = useToast();
  const qc = useQueryClient();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;

  const ACCOUNT_TYPES = [
    { value: "asset",     label: t("chartOfAccounts.typeAsset"),     badgeClass: "bg-blue-50 text-blue-700 border-blue-200" },
    { value: "liability", label: t("chartOfAccounts.typeLiability"), badgeClass: "bg-red-50 text-red-700 border-red-200" },
    { value: "equity",    label: t("chartOfAccounts.typeEquity"),    badgeClass: "bg-purple-50 text-purple-700 border-purple-200" },
    { value: "revenue",   label: t("chartOfAccounts.typeRevenue"),   badgeClass: "bg-green-50 text-green-700 border-green-200" },
    { value: "expense",   label: t("chartOfAccounts.typeExpense"),   badgeClass: "bg-orange-50 text-orange-700 border-orange-200" },
  ];
  const TYPE_MAP = Object.fromEntries(ACCOUNT_TYPES.map(t => [t.value, t]));

  const REPORT_DIRECTIONS = [
    { value: "",                 label: t("chartOfAccounts.autoByType") },
    { value: "balance_sheet",    label: t("chartOfAccounts.rdBalanceSheet") },
    { value: "income_statement", label: t("chartOfAccounts.rdIncomeStatement") },
  ];

  const EXPORT_COLS = [
    { key: "code",        header: t("chartOfAccounts.accountCode"), width: 14 },
    { key: "nameAr",      header: t("accountingReports.accountName"), width: 32 },
    { key: "nameEn",      header: t("chartOfAccounts.nameEnHeader"), width: 32 },
    { key: "accountType", header: t("chartOfAccounts.accountType"), width: 16 },
    { key: "level",       header: t("chartOfAccounts.level"), width: 10 },
    { key: "isPosting",   header: t("chartOfAccounts.posting"), width: 10 },
    { key: "isActive",    header: t("common.status"), width: 10 },
    { key: "balance",     header: t("accountingReports.balance"), width: 16 },
  ];

  const [search, setSearch]         = useState("");
  const [filterType, setFilterType] = useState("all");
  const [form, setForm]             = useState<any>(EMPTY);
  const [editId, setEditId]         = useState<number | null>(null);
  const [showForm, setShowForm]     = useState(false);
  const [treeOpen, setTreeOpen]     = useState(false);
  const [quickParentRow, setQuickParentRow] = useState<any | null>(null);

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const { data: accounts = [], isLoading } = useQuery<any[]>({
    queryKey: ["accounts", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/accounts?companyId=${cid}` : `${API}/api/accounts`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      return res.json();
    },
    enabled: !!user,
  });

  const { data: balanceRows = [] } = useQuery<any[]>({
    queryKey: ["accounts-balances", cid],
    queryFn: async () => {
      const url = cid
        ? `${API}/api/reports-accounting/trial-balance?companyId=${cid}`
        : `${API}/api/reports-accounting/trial-balance`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!user,
  });

  const leafBalanceMap = new Map<number, number>();
  for (const r of balanceRows) leafBalanceMap.set(r.id, Number(r.balance) || 0);

  const childrenIndex = new Map<number | null, any[]>();
  for (const a of accounts) {
    const key = a.parentId ?? null;
    const arr = childrenIndex.get(key) || [];
    arr.push(a);
    childrenIndex.set(key, arr);
  }
  const balanceCache = new Map<number, number>();
  function computeBalance(accountId: number): number {
    if (balanceCache.has(accountId)) return balanceCache.get(accountId)!;
    const own = leafBalanceMap.get(accountId) ?? 0;
    const kids = childrenIndex.get(accountId) || [];
    const sum = own + kids.reduce((s, c) => s + computeBalance(c.id), 0);
    balanceCache.set(accountId, sum);
    return sum;
  }

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["accounts"] });
    qc.invalidateQueries({ queryKey: ["accounts-balances"] });
  };

  const createMut = useMutation({
    mutationFn: async (data: any) => {
      const res = await fetch(`${API}/api/accounts`, { method: "POST", headers, body: JSON.stringify(data) });
      const json = await res.json(); if (!res.ok) throw new Error(json.error);
      return json;
    },
    onSuccess: () => { invalidate(); reset(); toast({ title: t("chartOfAccounts.saveSuccess") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const updateMut = useMutation({
    mutationFn: async ({ id, data }: any) => {
      const res = await fetch(`${API}/api/accounts/${id}`, { method: "PUT", headers, body: JSON.stringify(data) });
      const json = await res.json(); if (!res.ok) throw new Error(json.error);
      return json;
    },
    onSuccess: () => { invalidate(); reset(); toast({ title: t("chartOfAccounts.updateSuccess") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/accounts/${id}`, { method: "DELETE", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
    },
    onSuccess: () => { invalidate(); toast({ title: t("chartOfAccounts.deleteSuccess") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  function reset() { setForm(EMPTY); setEditId(null); setShowForm(false); }

  function handleEdit(a: any) {
    setForm({ ...a, parentId: a.parentId ? String(a.parentId) : "", reportDirection: a.reportDirection ?? "" });
    setEditId(a.id);
    setShowForm(true);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload = { ...form, parentId: form.parentId ? Number(form.parentId) : null, level: Number(form.level) || 1 };
    if (editId) updateMut.mutate({ id: editId, data: payload });
    else        createMut.mutate(payload);
  }

  const filtered = accounts.filter((a: any) => {
    const q = search.toLowerCase();
    const matchText = !search || a.nameAr.includes(search) || a.code.includes(search) || (a.nameEn ?? "").toLowerCase().includes(q);
    const matchType = filterType === "all" || a.accountType === filterType;
    return matchText && matchType;
  });

  const exportRows = filtered.map((a: any) => ({
    code:        a.code,
    nameAr:      isRtl ? a.nameAr : (a.nameEn || a.nameAr),
    nameEn:      a.nameEn ?? "",
    accountType: TYPE_MAP[a.accountType]?.label ?? a.accountType,
    level:       a.level,
    isPosting:   a.isPosting ? t("chartOfAccounts.exportYes") : t("chartOfAccounts.exportNo"),
    isActive:    a.isActive ? t("chartOfAccounts.active") : t("chartOfAccounts.inactive"),
    balance:     fmt(computeBalance(a.id)),
  }));

  const parentItems = [
    { value: "", label: t("chartOfAccounts.noParent") },
    ...accounts.filter((a: any) => a.id !== editId).map((a: any) => ({ value: String(a.id), code: a.code, label: isRtl ? a.nameAr : (a.nameEn || a.nameAr) })),
  ];

  const ChevronParent = isRtl ? ChevronLeft : ChevronRight;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BookOpen className="h-6 w-6 text-primary" />{t("chartOfAccounts.title")}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">{t("chartOfAccounts.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <ExportButtons rows={exportRows} columns={EXPORT_COLS} filename={`${t("chartOfAccounts.filename_prefix")}-${new Date().toISOString().slice(0,10)}`} title={t("chartOfAccounts.export_title")} />
          <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
            <Plus className="h-4 w-4" />{t("chartOfAccounts.newAccount")}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setFilterType("all")}
          className={cn("text-xs rounded-full px-3 py-1 border font-medium transition-colors",
            filterType === "all" ? "bg-primary text-primary-foreground border-primary" : "border-input bg-background hover:bg-muted"
          )}
        >
          {t("common.all")} ({accounts.length})
        </button>
        {ACCOUNT_TYPES.map(tt => {
          const cnt = accounts.filter((a: any) => a.accountType === tt.value).length;
          return (
            <button
              key={tt.value}
              onClick={() => setFilterType(tt.value)}
              className={cn("text-xs rounded-full px-3 py-1 border font-medium transition-colors",
                filterType === tt.value ? "bg-primary text-primary-foreground border-primary" : "border-input bg-background hover:bg-muted"
              )}
            >
              {tt.label} ({cnt})
            </button>
          );
        })}
      </div>

      {showForm && (
        <FormPanel
          icon={BookOpen}
          title={editId ? t("chartOfAccounts.editAccount") : t("chartOfAccounts.addAccount")}
          subtitle={t("chartOfAccounts.formSubtitle")}
          width="4xl"
          onClose={reset}
          onSave={() => handleSubmit({ preventDefault() {} } as any)}
          saving={createMut.isPending || updateMut.isPending}
          saveDisabled={!form.code || !form.nameAr || !form.accountType}
          saveLabel={editId ? t("chartOfAccounts.saveEdit") : t("chartOfAccounts.addAccountAction")}
        >
          <AccountTreePickerDialog
            open={treeOpen}
            onOpenChange={setTreeOpen}
            title="اختر الحساب الأب من شجرة الحسابات"
            description="تصفّح وابحث في شجرة الحسابات. يمكن اختيار أي حساب رئيسي أو فرعي ليكون الأب."
            currentAccountId={form.parentId ? Number(form.parentId) : null}
            onlyPosting={false}
            onSelect={(acc) => {
              setForm((p: any) => ({ ...p, parentId: String(acc.id) }));
              setTreeOpen(false);
            }}
          />
          <FormGrid>
            <Field label={t("chartOfAccounts.accountCode")} required>
              <Input placeholder={t("chartOfAccounts.placeholderCode")} value={form.code} onChange={e => setForm((p: any) => ({ ...p, code: e.target.value }))} />
            </Field>
            <Field label={t("chartOfAccounts.accountType")} required>
              <SearchCombobox
                items={ACCOUNT_TYPES.map(tt => ({ value: tt.value, label: tt.label, badge: tt.label, badgeClass: tt.badgeClass }))}
                value={form.accountType}
                onValueChange={v => setForm((p: any) => ({ ...p, accountType: v, reportDirection: p.reportDirection || "" }))}
                placeholder={t("chartOfAccounts.accountType")}
              />
            </Field>
            <Field label={t("chartOfAccounts.nameAr")} required>
              <Input placeholder={t("chartOfAccounts.placeholderNameAr")} value={form.nameAr} onChange={e => setForm((p: any) => ({ ...p, nameAr: e.target.value }))} />
            </Field>
            <Field label={t("chartOfAccounts.nameEn")}>
              <Input placeholder={t("chartOfAccounts.placeholderNameEn")} dir="ltr" className="text-left" value={form.nameEn} onChange={e => setForm((p: any) => ({ ...p, nameEn: e.target.value }))} />
            </Field>
            <Field label={t("chartOfAccounts.parentAccount")}>
              <div className="flex gap-1.5">
                <div className="flex-1 min-w-0">
                  <SearchCombobox
                    items={parentItems}
                    value={form.parentId}
                    onValueChange={v => setForm((p: any) => ({ ...p, parentId: v }))}
                    placeholder={t("chartOfAccounts.noParent")}
                    searchPlaceholder={t("chartOfAccounts.searchParent")}
                  />
                </div>
                <Button
                  type="button" variant="outline" size="icon"
                  className="h-9 w-9 shrink-0"
                  title="اختر من شجرة الحسابات"
                  onClick={() => setTreeOpen(true)}
                  data-testid="btn-tree-parent-account"
                >
                  <Network className="h-4 w-4" />
                </Button>
              </div>
            </Field>
            <Field label={t("chartOfAccounts.level")}>
              <Input type="number" min="1" max="10" value={form.level} onChange={e => setForm((p: any) => ({ ...p, level: Number(e.target.value) }))} />
            </Field>
            <Field label={t("chartOfAccounts.reportDirection")} className="md:col-span-2">
              <SearchCombobox
                items={REPORT_DIRECTIONS.map(d => ({ value: d.value, label: d.label }))}
                value={form.reportDirection ?? ""}
                onValueChange={v => setForm((p: any) => ({ ...p, reportDirection: v }))}
                placeholder={t("chartOfAccounts.reportAuto", { label: DEFAULT_DIRECTION[form.accountType] === "balance_sheet" ? t("chartOfAccounts.autoBs") : t("chartOfAccounts.autoIs") })}
              />
            </Field>
            <Field label={t("chartOfAccounts.notes")} className="md:col-span-2">
              <Input placeholder={t("chartOfAccounts.notesPlaceholder")} value={form.notes} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} />
            </Field>
            <div className="md:col-span-2 flex items-center gap-6 rounded-lg border bg-muted/30 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <Switch id="is-posting" checked={form.isPosting} onCheckedChange={v => setForm((p: any) => ({ ...p, isPosting: v }))} />
                <Label htmlFor="is-posting" className="cursor-pointer text-sm">{t("chartOfAccounts.isPosting")}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch id="is-active" checked={form.isActive} onCheckedChange={v => setForm((p: any) => ({ ...p, isActive: v }))} />
                <Label htmlFor="is-active" className="cursor-pointer text-sm">{t("chartOfAccounts.isActive")}</Label>
              </div>
            </div>
          </FormGrid>
        </FormPanel>
      )}

      <div className="relative">
        <Search className={cn("absolute top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground", isRtl ? "right-3" : "left-3")} />
        <Input className={isRtl ? "pr-9" : "pl-9"} placeholder={t("chartOfAccounts.searchPlaceholder")} value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {quickParentRow && (
        <AccountTreePickerDialog
          open={!!quickParentRow}
          onOpenChange={(o) => { if (!o) setQuickParentRow(null); }}
          title={`تغيير الحساب الأب لـ: ${quickParentRow.code} — ${quickParentRow.nameAr}`}
          description="اختر الحساب الأب الجديد. سيتم حفظ التغيير فوراً."
          currentAccountId={quickParentRow.parentId ?? null}
          onlyPosting={false}
          onSelect={(acc) => {
            if (acc.id === quickParentRow.id) {
              toast({ title: "لا يمكن جعل الحساب أباً لنفسه", variant: "destructive" });
              return;
            }
            const payload = {
              ...quickParentRow,
              parentId: acc.id,
              level: Number(quickParentRow.level) || 1,
              reportDirection: quickParentRow.reportDirection ?? "",
            };
            updateMut.mutate(
              { id: quickParentRow.id, data: payload },
              { onSuccess: () => setQuickParentRow(null) }
            );
          }}
        />
      )}

      <div className="rounded-xl border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="px-4 py-3 text-start font-semibold text-muted-foreground w-28">{t("chartOfAccounts.accountCode")}</th>
              <th className="px-4 py-3 text-start font-semibold text-muted-foreground">{t("accountingReports.accountName")}</th>
              <th className="px-4 py-3 text-start font-semibold text-muted-foreground hidden md:table-cell">{t("chartOfAccounts.nameEnHeader")}</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground w-28">{t("chartOfAccounts.accountType")}</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground w-32 hidden md:table-cell">{t("chartOfAccounts.reportDirectionHeader")}</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground w-20 hidden sm:table-cell">{t("chartOfAccounts.level")}</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground w-20 hidden sm:table-cell">{t("chartOfAccounts.posting")}</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground w-20">{t("common.status")}</th>
              <th className="px-4 py-3 text-end font-semibold text-muted-foreground w-32">{t("accountingReports.balance")}</th>
              <th className="px-4 py-3 w-24 font-semibold text-muted-foreground">{t("chartOfAccounts.actions")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading
              ? [...Array(5)].map((_, i) => <tr key={i}><td colSpan={10} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
              : filtered.length === 0
              ? (
                <tr>
                  <td colSpan={10} className="px-4 py-12 text-center text-muted-foreground">
                    <BookOpen className="h-10 w-10 mx-auto mb-2 opacity-20" />
                    <p className="font-medium">{t("chartOfAccounts.noAccounts")}</p>
                    <p className="text-xs mt-1">{t("chartOfAccounts.addFirstHint")}</p>
                  </td>
                </tr>
              )
              : filtered.map((a: any) => {
                  const typeInfo  = TYPE_MAP[a.accountType];
                  const parentAcc = a.parentId ? accounts.find((x: any) => x.id === a.parentId) : null;
                  const displayName = isRtl ? a.nameAr : (a.nameEn || a.nameAr);
                  const parentDisplay = parentAcc ? (isRtl ? parentAcc.nameAr : (parentAcc.nameEn || parentAcc.nameAr)) : "";
                  return (
                    <tr key={a.id} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <span className="font-mono text-xs bg-muted px-2 py-0.5 rounded border">{a.code}</span>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium">{displayName}</p>
                        {parentAcc && (
                          <p className="text-[10px] text-muted-foreground flex items-center gap-0.5 mt-0.5">
                            <ChevronParent className="h-3 w-3" />{parentAcc.code} — {parentDisplay}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs hidden md:table-cell" dir="ltr">{a.nameEn ?? "—"}</td>
                      <td className="px-4 py-3 text-center">
                        {typeInfo && <span className={cn("text-[10px] font-medium rounded-full px-2 py-0.5 border", typeInfo.badgeClass)}>{typeInfo.label}</span>}
                      </td>
                      <td className="px-4 py-3 text-center text-xs text-muted-foreground hidden md:table-cell">
                        {a.reportDirection === "balance_sheet" ? t("chartOfAccounts.autoBs") : a.reportDirection === "income_statement" ? t("chartOfAccounts.autoIs") : "—"}
                      </td>
                      <td className="px-4 py-3 text-center text-xs text-muted-foreground hidden sm:table-cell">{a.level}</td>
                      <td className="px-4 py-3 text-center hidden sm:table-cell">
                        {a.isPosting
                          ? <span className="text-[10px] bg-green-50 text-green-700 border border-green-200 rounded-full px-2 py-0.5">{t("chartOfAccounts.posting")}</span>
                          : <span className="text-[10px] bg-muted text-muted-foreground border rounded-full px-2 py-0.5">{t("chartOfAccounts.header")}</span>}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {a.isActive
                          ? <span className="text-[10px] bg-green-50 text-green-700 border border-green-200 rounded-full px-2 py-0.5">{t("chartOfAccounts.active")}</span>
                          : <span className="text-[10px] bg-red-50 text-red-700 border border-red-200 rounded-full px-2 py-0.5">{t("chartOfAccounts.inactive")}</span>}
                      </td>
                      <td className="px-4 py-3 text-end tabular-nums" dir="ltr">
                        {(() => {
                          const bal = computeBalance(a.id);
                          if (Math.abs(bal) < 0.005) {
                            return <span className="text-xs text-muted-foreground">0.00</span>;
                          }
                          return (
                            <span className={cn("text-xs font-mono font-medium", bal < 0 ? "text-destructive" : "text-foreground")}>
                              {fmt(Math.abs(bal))} {bal < 0 ? t("accountingReports.creditShort") : t("accountingReports.debitShort")}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1">
                          <Button
                            variant="ghost" size="icon" className="h-8 w-8"
                            title="تغيير الحساب الأب"
                            onClick={() => setQuickParentRow(a)}
                            data-testid={`btn-row-tree-${a.id}`}
                          >
                            <Network className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleEdit(a)}><Pencil className="h-3.5 w-3.5" /></Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive"
                            onClick={() => { if (confirm(t("chartOfAccounts.confirmDelete"))) deleteMut.mutate(a.id); }}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
          </tbody>
        </table>
        {!isLoading && <div className="px-4 py-2 border-t bg-muted/20 text-xs text-muted-foreground">{t("chartOfAccounts.countAccount", { count: filtered.length })}</div>}
      </div>

      <AccountsImportPanel />

    </div>
  );
}
