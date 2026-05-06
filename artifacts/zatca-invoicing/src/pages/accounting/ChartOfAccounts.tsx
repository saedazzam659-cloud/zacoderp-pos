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
import { TablePagination, usePagination } from "@/components/TablePagination";
import { Plus, Pencil, Trash2, Copy, BookOpen, Search, ChevronLeft, ChevronRight, Printer, LayoutGrid, ListTree, ChevronDown, FolderTree, CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { printChartOfAccountsExternal, type CoaPrintAccount, type CoaPrintTypeMeta } from "@/lib/export";

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
  reportDirection: "", parentId: "", level: 1, isPosting: true, isActive: true,
  costCenterId: "", notes: "",
};

export default function ChartOfAccounts() {
  const { user, token } = useAuth() as any;
  const { t } = useTranslation();
  const { fmt, isRtl } = useFormatters();
  const { toast } = useToast();
  const qc = useQueryClient();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;

  const ACCOUNT_TYPES = [
    { value: "asset",     label: t("chartOfAccounts.typeAsset"),     badgeClass: "bg-blue-50 text-blue-700 border-blue-200",       printColor: "#1d4ed8", printBg: "#eff6ff" },
    { value: "liability", label: t("chartOfAccounts.typeLiability"), badgeClass: "bg-red-50 text-red-700 border-red-200",          printColor: "#dc2626", printBg: "#fef2f2" },
    { value: "equity",    label: t("chartOfAccounts.typeEquity"),    badgeClass: "bg-purple-50 text-purple-700 border-purple-200", printColor: "#7c3aed", printBg: "#faf5ff" },
    { value: "revenue",   label: t("chartOfAccounts.typeRevenue"),   badgeClass: "bg-green-50 text-green-700 border-green-200",    printColor: "#15803d", printBg: "#f0fdf4" },
    { value: "expense",   label: t("chartOfAccounts.typeExpense"),   badgeClass: "bg-orange-50 text-orange-700 border-orange-200", printColor: "#ea580c", printBg: "#fff7ed" },
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
  const [viewMode, setViewMode]     = useState<"tree" | "table">(() => {
    if (typeof window === "undefined") return "tree";
    return (localStorage.getItem("coa.viewMode") as "tree" | "table") || "tree";
  });
  const [expandedIds, setExpandedIds] = useState<Set<number>>(() => new Set());
  const [allExpanded, setAllExpanded] = useState(true);
  function toggleNode(id: number) {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function setView(v: "tree" | "table") {
    setViewMode(v);
    try { localStorage.setItem("coa.viewMode", v); } catch { /* ignore */ }
  }

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

  const { data: costCenters = [] } = useQuery<any[]>({
    queryKey: ["cost-centers", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/cost-centers?companyId=${cid}` : `${API}/api/cost-centers`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return [];
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
  function computeBalance(accountId: number, seen: Set<number> = new Set()): number {
    if (balanceCache.has(accountId)) return balanceCache.get(accountId)!;
    if (seen.has(accountId)) return 0; // cycle guard
    seen.add(accountId);
    const own = leafBalanceMap.get(accountId) ?? 0;
    const kids = childrenIndex.get(accountId) || [];
    const sum = own + kids.reduce((s, c) => s + computeBalance(c.id, seen), 0);
    seen.delete(accountId);
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
    setForm({
      ...a,
      parentId: a.parentId ? String(a.parentId) : "",
      reportDirection: a.reportDirection ?? "",
      costCenterId: a.costCenterId ? String(a.costCenterId) : "",
    });
    setEditId(a.id);
    setShowForm(true);
  }

  function handleCopy(a: any) {
    setForm({
      code:            "",
      nameAr:          a.nameAr ?? "",
      nameEn:          a.nameEn ?? "",
      accountType:     a.accountType ?? "asset",
      reportDirection: a.reportDirection ?? "",
      parentId:        a.parentId ? String(a.parentId) : "",
      level:           a.level ?? 1,
      isPosting:       a.isPosting ?? true,
      isActive:        a.isActive ?? true,
      costCenterId:    a.costCenterId ? String(a.costCenterId) : "",
      notes:           a.notes ?? "",
    });
    setEditId(null);
    setShowForm(true);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload = {
      ...form,
      parentId: form.parentId ? Number(form.parentId) : null,
      costCenterId: form.costCenterId ? Number(form.costCenterId) : null,
      level: Number(form.level) || 1,
    };
    if (editId) updateMut.mutate({ id: editId, data: payload });
    else        createMut.mutate(payload);
  }

  const filtered = accounts.filter((a: any) => {
    const q = search.toLowerCase();
    const matchText = !search || a.nameAr.includes(search) || a.code.includes(search) || (a.nameEn ?? "").toLowerCase().includes(q);
    const matchType = filterType === "all" || a.accountType === filterType;
    return matchText && matchType;
  });

  const pager = usePagination(filtered);

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
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BookOpen className="h-6 w-6 text-primary" />{t("chartOfAccounts.title")}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">{t("chartOfAccounts.subtitle")}</p>
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <Button
            size="sm"
            className="gap-2 bg-gradient-to-l from-emerald-700 to-green-600 hover:from-emerald-800 hover:to-green-700 text-white shadow-md hover:shadow-lg transition-all border-0"
            onClick={() => {
              const printAccounts: CoaPrintAccount[] = accounts.map((a: any) => {
                const bal = computeBalance(a.id);
                const balStr = Math.abs(bal) < 0.005
                  ? "0.00"
                  : `${fmt(Math.abs(bal))} ${bal < 0 ? t("accountingReports.creditShort") : t("accountingReports.debitShort")}`;
                return {
                  id: a.id,
                  parentId: a.parentId ?? null,
                  code: a.code,
                  nameAr: a.nameAr,
                  nameEn: a.nameEn,
                  accountType: a.accountType,
                  level: a.level,
                  isPosting: !!a.isPosting,
                  isActive: !!a.isActive,
                  balance: balStr,
                };
              });
              const printTypes: CoaPrintTypeMeta[] = ACCOUNT_TYPES.map(tp => ({
                value: tp.value,
                label: tp.label,
                color: tp.printColor,
                bg: tp.printBg,
              }));
              printChartOfAccountsExternal({
                accounts: printAccounts,
                types: printTypes,
                title: t("chartOfAccounts.export_title"),
                subtitle: t("chartOfAccounts.subtitle"),
                companyName: user?.company?.name ?? null,
                logo: user?.company?.logo ?? null,
                autoPrint: true,
              });
            }}
            title={t("chartOfAccounts.export_title")}
          >
            <Printer className="h-4 w-4" />
            طباعة الجرد الخارجي
          </Button>
          <div className="inline-flex rounded-md border bg-background overflow-hidden shadow-sm">
            <button
              onClick={() => setView("tree")}
              className={cn(
                "px-3 py-1.5 text-xs font-medium flex items-center gap-1.5 transition-colors",
                viewMode === "tree" ? "bg-emerald-600 text-white" : "bg-background text-muted-foreground hover:bg-muted"
              )}
              title="عرض شجري"
            >
              <ListTree className="h-3.5 w-3.5" />
              شجري
            </button>
            <button
              onClick={() => setView("table")}
              className={cn(
                "px-3 py-1.5 text-xs font-medium flex items-center gap-1.5 transition-colors border-r",
                viewMode === "table" ? "bg-emerald-600 text-white" : "bg-background text-muted-foreground hover:bg-muted"
              )}
              title="عرض جدولي"
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              جدول
            </button>
          </div>
          <ExportButtons rows={exportRows} columns={EXPORT_COLS} filename={`${t("chartOfAccounts.filename_prefix")}-${new Date().toISOString().slice(0,10)}`} title={t("chartOfAccounts.export_title")} />
          <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
            <Plus className="h-4 w-4" />{t("chartOfAccounts.newAccount")}
          </Button>
        </div>
      </div>

      {/* Summary cards — counts per account type, always visible */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <button
          onClick={() => setFilterType("all")}
          className={cn(
            "rounded-xl border-2 px-4 py-3 text-center transition-all hover:shadow-md hover:-translate-y-0.5",
            filterType === "all"
              ? "bg-gradient-to-br from-slate-50 to-slate-100 border-slate-400 ring-2 ring-slate-300"
              : "bg-white border-slate-200 hover:border-slate-300"
          )}
        >
          <div className="text-[11px] font-semibold text-slate-600 mb-1">إجمالي الحسابات</div>
          <div className="text-2xl font-extrabold text-slate-800">{accounts.length}</div>
        </button>
        {ACCOUNT_TYPES.map(tp => {
          const cnt = accounts.filter((a: any) => a.accountType === tp.value).length;
          const isActive = filterType === tp.value;
          return (
            <button
              key={tp.value}
              onClick={() => setFilterType(tp.value)}
              className={cn(
                "rounded-xl border-2 px-4 py-3 text-center transition-all hover:shadow-md hover:-translate-y-0.5",
                isActive ? "ring-2 shadow-md" : "hover:border-opacity-80"
              )}
              style={{
                backgroundColor: tp.printBg,
                borderColor: isActive ? tp.printColor : `${tp.printColor}40`,
                ['--tw-ring-color' as any]: tp.printColor,
              }}
            >
              <div className="text-[11px] font-semibold mb-1" style={{ color: tp.printColor }}>{tp.label}</div>
              <div className="text-2xl font-extrabold" style={{ color: tp.printColor }}>{cnt}</div>
            </button>
          );
        })}
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
              <SearchCombobox
                items={parentItems}
                value={form.parentId}
                onValueChange={v => setForm((p: any) => ({ ...p, parentId: v }))}
                placeholder={t("chartOfAccounts.noParent")}
                searchPlaceholder={t("chartOfAccounts.searchParent")}
              />
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
            <Field label="مركز التكلفة (اختياري)" className="md:col-span-2">
              <SearchCombobox
                items={[
                  { value: "", label: "بدون مركز تكلفة" },
                  ...costCenters.map((c: any) => ({
                    value: String(c.id),
                    code: c.code,
                    label: isRtl ? c.nameAr : (c.nameEn || c.nameAr),
                  })),
                ]}
                value={form.costCenterId ?? ""}
                onValueChange={v => setForm((p: any) => ({ ...p, costCenterId: v }))}
                placeholder="اختياري — اختر مركز تكلفة افتراضي للحساب"
                searchPlaceholder="ابحث عن مركز التكلفة..."
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

      {viewMode === "tree" && (() => {
        const visibleSet = new Set<number>();
        for (const a of filtered) {
          let cur: any = a;
          while (cur) {
            visibleSet.add(cur.id);
            cur = cur.parentId ? accounts.find((x: any) => x.id === cur.parentId) : null;
          }
        }
        const childrenIdx = new Map<number | null, any[]>();
        for (const a of accounts) {
          const k = a.parentId ?? null;
          if (!childrenIdx.has(k)) childrenIdx.set(k, []);
          childrenIdx.get(k)!.push(a);
        }
        for (const arr of childrenIdx.values()) {
          arr.sort((x, y) => String(x.code).localeCompare(String(y.code), undefined, { numeric: true }));
        }
        const isExpanded = (id: number) =>
          allExpanded ? !expandedIds.has(id) : expandedIds.has(id);
        const expandAll = () => { setAllExpanded(true); setExpandedIds(new Set()); };
        const collapseAll = () => { setAllExpanded(false); setExpandedIds(new Set()); };

        const renderNode = (a: any, depth: number): any => {
          if (!visibleSet.has(a.id)) return null;
          const typeInfo = TYPE_MAP[a.accountType];
          const kids = (childrenIdx.get(a.id) || []).filter(c => visibleSet.has(c.id));
          const hasKids = kids.length > 0;
          const expanded = isExpanded(a.id);
          const displayName = isRtl ? a.nameAr : (a.nameEn || a.nameAr);
          const altName = isRtl ? (a.nameEn || "") : a.nameAr;
          const bal = computeBalance(a.id);
          const Chev = isRtl ? ChevronLeft : ChevronRight;
          return (
            <div key={a.id}>
              <div
                className="group flex items-center gap-2 py-2 px-2 rounded-md hover:bg-muted/40 transition-colors border-r-4"
                style={{
                  borderColor: typeInfo?.printColor || "#94a3b8",
                  backgroundColor: depth === 0 ? `${typeInfo?.printBg || "#f8fafc"}80` : undefined,
                  marginInlineStart: `${depth * 22}px`,
                }}
              >
                <button
                  onClick={() => hasKids && toggleNode(a.id)}
                  className={cn("h-5 w-5 flex items-center justify-center rounded text-muted-foreground", hasKids ? "hover:bg-muted cursor-pointer" : "opacity-30 cursor-default")}
                  title={hasKids ? (expanded ? "طي" : "توسيع") : ""}
                >
                  {hasKids ? (expanded ? <ChevronDown className="h-4 w-4" /> : <Chev className="h-4 w-4" />) : <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30" />}
                </button>
                <span className="font-mono text-[11px] bg-white border px-2 py-0.5 rounded shadow-sm tabular-nums">{a.code}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={cn("font-medium truncate", depth === 0 ? "text-base" : "text-sm")}>{displayName}</span>
                    {altName && <span className="text-[10px] text-muted-foreground truncate" dir={isRtl ? "ltr" : "rtl"}>{altName}</span>}
                  </div>
                </div>
                {typeInfo && (
                  <span
                    className="text-[10px] font-semibold rounded-full px-2 py-0.5 border whitespace-nowrap"
                    style={{ color: typeInfo.printColor, backgroundColor: typeInfo.printBg, borderColor: `${typeInfo.printColor}40` }}
                  >
                    {typeInfo.label}
                  </span>
                )}
                <span
                  className={cn(
                    "text-[10px] rounded-full px-2 py-0.5 border whitespace-nowrap",
                    a.isPosting ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-amber-50 text-amber-700 border-amber-200"
                  )}
                  title={a.isPosting ? t("chartOfAccounts.posting") : t("chartOfAccounts.header")}
                >
                  {a.isPosting ? t("chartOfAccounts.posting") : t("chartOfAccounts.header")}
                </span>
                {a.isActive
                  ? <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-label={t("chartOfAccounts.active")} />
                  : <XCircle className="h-4 w-4 text-red-500" aria-label={t("chartOfAccounts.inactive")} />}
                <span className="hidden md:inline-block min-w-[110px] text-end font-mono text-xs tabular-nums" dir="ltr">
                  {Math.abs(bal) < 0.005
                    ? <span className="text-muted-foreground">0.00</span>
                    : <span className={cn("font-medium", bal < 0 ? "text-red-600" : "text-foreground")}>
                        {fmt(Math.abs(bal))} {bal < 0 ? t("accountingReports.creditShort") : t("accountingReports.debitShort")}
                      </span>}
                </span>
                <div className="flex gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
                  <Button variant="outline" size="icon" className="h-7 w-7 bg-blue-50 hover:bg-blue-100 border-blue-200 text-blue-700" onClick={() => handleEdit(a)} title={t("chartOfAccounts.editAccount")}>
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button variant="outline" size="icon" className="h-7 w-7 bg-amber-50 hover:bg-amber-100 border-amber-200 text-amber-700" onClick={() => handleCopy(a)} title={t("chartOfAccounts.copyAccount")}>
                    <Copy className="h-3 w-3" />
                  </Button>
                  <Button variant="outline" size="icon" className="h-7 w-7 bg-red-50 hover:bg-red-100 border-red-200 text-red-700" onClick={() => { if (confirm(t("chartOfAccounts.confirmDelete"))) deleteMut.mutate(a.id); }} title={t("common.delete")}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
              {hasKids && expanded && (
                <div className="mt-1 space-y-1">
                  {kids.map((c: any) => renderNode(c, depth + 1))}
                </div>
              )}
            </div>
          );
        };

        const roots = (childrenIdx.get(null) || []).filter(r => visibleSet.has(r.id));
        // Orphans: items in visibleSet whose parent isn't in accounts list
        const orphanRoots = filtered.filter((a: any) => a.parentId && !accounts.find((x: any) => x.id === a.parentId));

        return (
          <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
            <div className="bg-gradient-to-l from-emerald-700 to-green-600 text-white px-4 py-2.5 flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <FolderTree className="h-4 w-4" />
                <span>عرض شجري للحسابات</span>
                <span className="text-[11px] opacity-90 font-normal">({filtered.length} حساب{filtered.length !== accounts.length ? ` من ${accounts.length}` : ""})</span>
              </div>
              <div className="flex gap-1.5">
                <button onClick={expandAll} className="text-[11px] bg-white/15 hover:bg-white/25 px-2.5 py-1 rounded font-medium transition-colors">توسيع الكل</button>
                <button onClick={collapseAll} className="text-[11px] bg-white/15 hover:bg-white/25 px-2.5 py-1 rounded font-medium transition-colors">طي الكل</button>
              </div>
            </div>
            <div className="p-3 space-y-1 max-h-[70vh] overflow-y-auto">
              {isLoading ? (
                [...Array(6)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)
              ) : filtered.length === 0 ? (
                <div className="px-4 py-12 text-center text-muted-foreground">
                  <BookOpen className="h-10 w-10 mx-auto mb-2 opacity-20" />
                  <p className="font-medium">{t("chartOfAccounts.noAccounts")}</p>
                  <p className="text-xs mt-1">{t("chartOfAccounts.addFirstHint")}</p>
                </div>
              ) : (
                <>
                  {roots.map((r: any) => renderNode(r, 0))}
                  {orphanRoots.map((r: any) => renderNode(r, 0))}
                </>
              )}
            </div>
          </div>
        );
      })()}

      {viewMode === "table" && (<div className="rounded-xl border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground w-32 bg-primary/5 border-l-2 border-primary/20">{t("chartOfAccounts.actions")}</th>
              <th className="px-4 py-3 text-start font-semibold text-muted-foreground w-28">{t("chartOfAccounts.accountCode")}</th>
              <th className="px-4 py-3 text-start font-semibold text-muted-foreground">{t("accountingReports.accountName")}</th>
              <th className="px-4 py-3 text-start font-semibold text-muted-foreground hidden md:table-cell">{t("chartOfAccounts.nameEnHeader")}</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground w-28">{t("chartOfAccounts.accountType")}</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground w-32 hidden md:table-cell">{t("chartOfAccounts.reportDirectionHeader")}</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground w-20 hidden sm:table-cell">{t("chartOfAccounts.level")}</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground w-20 hidden sm:table-cell">{t("chartOfAccounts.posting")}</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground w-20">{t("common.status")}</th>
              <th className="px-4 py-3 text-end font-semibold text-muted-foreground w-32">{t("accountingReports.balance")}</th>
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
              : pager.pagedItems.map((a: any) => {
                  const typeInfo  = TYPE_MAP[a.accountType];
                  const parentAcc = a.parentId ? accounts.find((x: any) => x.id === a.parentId) : null;
                  const displayName = isRtl ? a.nameAr : (a.nameEn || a.nameAr);
                  const parentDisplay = parentAcc ? (isRtl ? parentAcc.nameAr : (parentAcc.nameEn || parentAcc.nameAr)) : "";
                  return (
                    <tr key={a.id} className="hover:bg-muted/30">
                      <td className="px-3 py-3 bg-primary/[0.03] border-l-2 border-primary/10">
                        <div className="flex gap-1.5 justify-center">
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-8 w-8 bg-blue-50 hover:bg-blue-100 border-blue-200 text-blue-700 hover:text-blue-800 shadow-sm"
                            onClick={() => handleEdit(a)}
                            title={t("chartOfAccounts.editAccount")}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-8 w-8 bg-amber-50 hover:bg-amber-100 border-amber-200 text-amber-700 hover:text-amber-800 shadow-sm"
                            onClick={() => handleCopy(a)}
                            title={t("chartOfAccounts.copyAccount")}
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-8 w-8 bg-red-50 hover:bg-red-100 border-red-200 text-red-700 hover:text-red-800 shadow-sm"
                            onClick={() => { if (confirm(t("chartOfAccounts.confirmDelete"))) deleteMut.mutate(a.id); }}
                            title={t("common.delete")}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </td>
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
                    </tr>
                  );
                })}
          </tbody>
        </table>
        {!isLoading && (
          <TablePagination
            page={pager.page}
            pageSize={pager.pageSize}
            pageCount={pager.pageCount}
            total={pager.total}
            onPageChange={pager.setPage}
            onPageSizeChange={pager.setPageSize}
            itemLabel={t("chartOfAccounts.itemLabel", { defaultValue: "حساب" })}
          />
        )}
      </div>)}

      <AccountsImportPanel />

    </div>
  );
}
