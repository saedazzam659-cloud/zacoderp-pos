import { useListCustomers, useDeleteCustomer } from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Plus, Users, Search, Phone, Mail, MapPin,
  BadgeCheck, Building2, UserCheck, FileText, Pencil, Trash2,
  FileSpreadsheet, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useState, useMemo, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import ExportButtons from "@/components/ExportButtons";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useTranslation } from "react-i18next";
import { Trans } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  rowToneFor, SEL_TONE, DocColorLegend, buildToneTooltip, DICT_TONES, type LegendItem,
} from "@/lib/docRowTone";
import { downloadCsv, matchCol, useAuditGridLayout, useColumnResize } from "@/lib/auditGridLayout";
import {
  AuditGridBulkBar, AuditGridPagination, ColumnReorderPopover,
  FooterColorPicker, HeaderColorPicker, HeaderSelectCheckbox, RowSelectCheckbox,
} from "@/components/auditGrid/AuditGridControls";

const API = import.meta.env.VITE_API_URL || "";

export default function Customers() {
  const { t, i18n } = useTranslation();
  const [search, setSearch]       = useState("");
  const [activeTab, setActiveTab] = useState("all");
  const { user, token } = useAuth() as any;
  const cid = user?.role === "superadmin" ? undefined : user?.companyId;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<any>(null);

  const CUSTOMER_EXPORT_COLS = [
    { key: "nameAr",     header: t("pages.customers.nameAr"),        width: 28 },
    { key: "nameEn",     header: t("pages.customers.nameEn"),        width: 28 },
    { key: "vatNumber",  header: t("pages.customers.vatNumber"),       width: 20 },
    { key: "crNumber",   header: t("pages.customers.crNumber"),       width: 18 },
    { key: "phone",      header: t("pages.customers.phone"),              width: 18 },
    { key: "email",      header: t("pages.customers.email"),  width: 28 },
    { key: "city",       header: t("pages.customers.city"),             width: 16 },
    { key: "district",   header: t("pages.customers.district"),               width: 16 },
    { key: "postalCode", header: t("pages.customers.postalCode"),      width: 14 },
  ];

  const TABS = [
    { key: "all",        label: t("pages.customers.allCustomers"),    icon: Users },
    { key: "withVat",    label: t("pages.customers.companiesB2b"),      icon: Building2 },
    { key: "individual", label: t("pages.customers.individualsB2c"),       icon: UserCheck },
  ];

  const deleteMut = useDeleteCustomer({
    mutation: {
      onSuccess: () => {
        toast({ title: `✓ ${t("pages.customers.deleteSuccess")}`, description: t("pages.customers.deleteSuccessDesc") });
        queryClient.invalidateQueries({ queryKey: ["customers"] });
        setDeleteTarget(null);
      },
      onError: (e: any) => toast({
        title: t("pages.customers.deleteError"),
        description: e?.message?.includes("foreign") || e?.status === 409
          ? t("pages.customers.deleteErrorLinked")
          : t("pages.customers.deleteErrorGeneric"),
        variant: "destructive",
      }),
    },
  } as any);

  const { data: customers = [], isLoading } = useListCustomers(undefined, {
    query: { queryKey: ["customers", user?.companyId] },
  }) as any;

  const { data: balances = [] } = useQuery<any[]>({
    queryKey: ["customer-balances", cid],
    queryFn: async () => {
      const r = await fetch(cid ? `${API}/api/customers/balances?companyId=${cid}` : `${API}/api/customers/balances`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return r.json();
    },
    enabled: !!user && !!token,
  });
  const balMap: Record<number, number> = Object.fromEntries(
    (balances as any[]).map((b: any) => [b.customerId, b.balance])
  );

  const withVat = (customers as any[]).filter(c => c.vatNumber).length;
  const individuals = (customers as any[]).length - withVat;

  const counts: Record<string, number> = {
    all:        (customers as any[]).length,
    withVat,
    individual: individuals,
  };

  const filteredBySearch = (customers as any[]).filter(c => {
    const q = search.toLowerCase();
    const matchSearch =
      !search ||
      c.nameAr?.includes(search) ||
      c.nameEn?.toLowerCase().includes(q) ||
      c.vatNumber?.includes(search) ||
      c.city?.includes(search) ||
      c.email?.toLowerCase().includes(q) ||
      c.phone?.includes(search);
    const matchTab =
      activeTab === "all" ||
      (activeTab === "withVat"    && c.vatNumber) ||
      (activeTab === "individual" && !c.vatNumber);
    return matchSearch && matchTab;
  });

  const isRtl = i18n.language === "ar";

  // ── Audit-grid layout ──
  type ColType = "text" | "num" | "none";
  interface ColDef { key: string; label: string; type: ColType; valueOf: (r: any) => string | number }
  const COLUMNS: ColDef[] = useMemo(() => [
    { key: "_sel",     label: "",                             type: "none", valueOf: () => "" },
    { key: "_idx",     label: "#",                            type: "none", valueOf: () => "" },
    { key: "name",     label: t("pages.customers.customer"),  type: "text", valueOf: (c) => `${c.nameAr ?? ""} ${c.nameEn ?? ""}`.trim() },
    { key: "vat",      label: t("pages.customers.vatNumber"), type: "text", valueOf: (c) => c.vatNumber ?? "" },
    { key: "cr",       label: t("pages.customers.crNumber"),  type: "text", valueOf: (c) => c.crNumber ?? "" },
    { key: "city",     label: t("pages.customers.city"),      type: "text", valueOf: (c) => c.city ?? "" },
    { key: "phone",    label: t("pages.customers.phone"),     type: "text", valueOf: (c) => c.phone ?? "" },
    { key: "email",    label: t("pages.customers.email"),     type: "text", valueOf: (c) => c.email ?? "" },
    { key: "type",     label: t("pages.customers.type"),      type: "text", valueOf: (c) => c.vatNumber ? "B2B" : "B2C" },
    { key: "balance",  label: t("pages.customers.balance"),   type: "num",  valueOf: (c) => Number(balMap[c.id] ?? 0) },
    { key: "_act",     label: t("common.actions"),            type: "none", valueOf: () => "" },
  ], [t, balMap]);
  const dataKeys = useMemo(() => COLUMNS.filter(c => !["_sel","_idx","_act"].includes(c.key)).map(c => c.key), [COLUMNS]);
  const allColKeys = useMemo(() => COLUMNS.map(c => c.key), [COLUMNS]);
  const layout = useAuditGridLayout({ screenSlug: "customers", cid, dataKeys, allColKeys });
  const { tableRef, gripProps } = useColumnResize(layout.setColWidths);
  const { theme, colWidths, colFilters, setColFilter, clearColFilters,
          isSelected, toggleRow, toggleAll, isAllSelected, isSomeSelected, clearSelection,
          pageSize, page, setPage } = layout;

  const filtered = useMemo(() => filteredBySearch.filter((c) => {
    for (const col of COLUMNS) {
      const f = colFilters[col.key];
      if (!f) continue;
      if (!matchCol(col.valueOf(c), f, col.type)) return false;
    }
    return true;
  }), [filteredBySearch, colFilters, COLUMNS]);

  const totalPages = pageSize === 0 ? 1 : Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  useEffect(() => { if (safePage !== page) setPage(safePage); }, [safePage, page, setPage]);
  const paged = useMemo(() => pageSize === 0 ? filtered : filtered.slice((safePage - 1) * pageSize, safePage * pageSize), [filtered, pageSize, safePage]);
  const pageStart = filtered.length === 0 ? 0 : pageSize === 0 ? 1 : (safePage - 1) * pageSize + 1;
  const pageEnd = pageSize === 0 ? filtered.length : Math.min(safePage * pageSize, filtered.length);

  const visibleColumns = useMemo(() => {
    const dataCols = layout.dataOrder.map(k => COLUMNS.find(c => c.key === k)).filter((c): c is ColDef => !!c);
    const sel = COLUMNS.find(c => c.key === "_sel")!;
    const idx = COLUMNS.find(c => c.key === "_idx")!;
    const act = COLUMNS.find(c => c.key === "_act")!;
    return [sel, idx, ...dataCols, act];
  }, [layout.dataOrder, COLUMNS]);
  const reorderableCols = useMemo(() => layout.dataOrder
    .map(k => COLUMNS.find(c => c.key === k)!)
    .map(c => ({ key: c.key, label: c.label })), [layout.dataOrder, COLUMNS]);
  const allFilteredIds = useMemo(() => filtered.map((c: any) => c.id as number), [filtered]);

  function exportCsv() {
    if (filtered.length === 0) {
      toast({ title: t("pages.customers.noResultsMatch"), variant: "destructive" });
      return;
    }
    const exportable = visibleColumns.filter(c => !["_sel","_idx","_act"].includes(c.key));
    const header = ["#", ...exportable.map(c => c.label)];
    const rows = filtered.map((c: any, i: number) => [
      i + 1,
      ...exportable.map(col => {
        const v = col.valueOf(c);
        return col.type === "num" ? Number(v).toFixed(2) : String(v ?? "");
      }),
    ]);
    downloadCsv(`customers-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
  }

  return (
    <div className="space-y-0" dir={isRtl ? "rtl" : "ltr"}>

      {/* ── Header strip ── */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users className="h-6 w-6 text-primary" />
            {t("pages.customers.customers")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t("pages.customers.subtitle")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ExportButtons
            rows={filtered.map((c: any) => ({
              nameAr:     c.nameAr     ?? "",
              nameEn:     c.nameEn     ?? "",
              vatNumber:  c.vatNumber  ?? "",
              crNumber:   c.crNumber   ?? "",
              phone:      c.phone      ?? "",
              email:      c.email      ?? "",
              city:       c.city       ?? "",
              district:   c.district   ?? "",
              postalCode: c.postalCode ?? "",
            }))}
            columns={CUSTOMER_EXPORT_COLS}
            filename={`${t("pages.customers.filenamePrefix")}-${new Date().toISOString().slice(0, 10)}`}
            title={t("pages.customers.exportTitle")}
            subtitle={`${t("pages.customers.exportSubtitle")} — ${new Date().toLocaleDateString(isRtl ? "ar-SA-u-nu-latn" : "en-US")}`}
          />
          <Button asChild className="gap-2 shrink-0">
            <Link href="/customers/new">
              <Plus className="h-4 w-4" />{t("pages.customers.addCustomer")}
            </Link>
          </Button>
        </div>
      </div>

      {/* ── 3 TABS — أعلى اليسار ── */}
      <div className="flex items-center gap-1 mb-6 bg-muted/50 p-1 rounded-xl w-fit border">
        {TABS.map(tab => {
          const Icon = tab.icon;
          const count = isLoading ? null : counts[tab.key];
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-150 whitespace-nowrap ${
                active
                  ? "bg-background text-primary shadow-sm border border-border/60"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
              }`}
            >
              <Icon className={`h-3.5 w-3.5 ${active ? "text-primary" : ""}`} />
              {tab.label}
              {count !== null && (
                <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${
                  active
                    ? "bg-primary/10 text-primary"
                    : "bg-muted text-muted-foreground"
                }`}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Stats cards (3 mini) ── */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        {[
          {
            label: t("pages.customers.totalCustomers"),
            value: isLoading ? null : (customers as any[]).length,
            icon: Users,
            color: "text-primary",
            bg:    "bg-primary/10",
          },
          {
            label: t("pages.customers.vatRegistered"),
            value: isLoading ? null : withVat,
            icon: BadgeCheck,
            color: "text-emerald-600",
            bg:    "bg-emerald-50",
            sub:   "B2B",
          },
          {
            label: t("pages.customers.individuals"),
            value: isLoading ? null : individuals,
            icon: UserCheck,
            color: "text-blue-600",
            bg:    "bg-blue-50",
            sub:   "B2C",
          },
        ].map(stat => {
          const Icon = stat.icon;
          return (
            <div key={stat.label} className="rounded-xl border bg-card p-4 flex items-center gap-3">
              <div className={`h-9 w-9 rounded-lg ${stat.bg} flex items-center justify-center shrink-0`}>
                <Icon className={`h-4.5 w-4.5 ${stat.color}`} style={{ width: 18, height: 18 }} />
              </div>
              <div>
                {stat.value === null
                  ? <Skeleton className="h-6 w-12 mb-1" />
                  : <p className="text-xl font-bold leading-none">{stat.value}</p>
                }
                <p className="text-xs text-muted-foreground mt-0.5">
                  {stat.label}
                  {stat.sub && <span className="text-[10px] mx-1 opacity-60">{stat.sub}</span>}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Main card ── */}
      <div className="rounded-xl border bg-card overflow-hidden">

        {(() => {
          // overLimit takes precedence over debit so a row is counted once.
          const isOver = (c: any) => {
            const lim = Number(c.creditLimit ?? 0);
            return lim > 0 && Number(balMap[c.id] ?? 0) > lim;
          };
          const items: LegendItem[] = [
            { kind: "active",    count: filtered.filter((c: any) => (Number(balMap[c.id] ?? 0) === 0) && c.vatNumber).length,
              labelOverride: "مسجَّل ضريبياً بدون رصيد",
              hintOverride: "عميل لديه رقم تسجيل ضريبي ورصيده صفر — جاهز للتعامل" },
            { kind: "inactive",  count: filtered.filter((c: any) => (Number(balMap[c.id] ?? 0) === 0) && !c.vatNumber).length,
              labelOverride: "غير مسجَّل بدون رصيد",
              hintOverride: "عميل بدون تسجيل ضريبي ورصيده صفر — لا يصدر له فاتورة ضريبية" },
            { kind: "debit",     count: filtered.filter((c: any) => Number(balMap[c.id] ?? 0) > 0 && !isOver(c)).length,
              labelOverride: "مدين (له علينا)",
              hintOverride: "عملاء عليهم رصيد مدين ضمن الحد الائتماني" },
            { kind: "credit",    count: filtered.filter((c: any) => Number(balMap[c.id] ?? 0) < 0).length,
              labelOverride: "دائن (له عليهم)",
              hintOverride: "عملاء لهم رصيد دائن — دفعوا أكثر من المستحق" },
            { kind: "overLimit", count: filtered.filter(isOver).length,
              labelOverride: "تجاوز الائتمان",
              hintOverride: "تجاوز رصيدهم المدين الحدَّ الائتماني المحدد لهم — يُمنع إصدار فواتير جديدة" },
          ];
          return <div className="px-4 pt-2"><DocColorLegend items={items} separatorAfter={[3]} /></div>;
        })()}

        {/* Audit-grid toolbar */}
        <div className={cn("border-t shadow-sm transition-colors", theme.border)}>
          <div className={cn("px-3 py-2 flex items-center gap-2 flex-wrap transition-colors", theme.bar, theme.text)} dir={isRtl ? "rtl" : "ltr"}>
            <div className={cn("flex-1 text-sm font-bold tracking-wide flex items-center gap-2", theme.text)}>
              <Users className="h-4 w-4 opacity-90" />
              {t("pages.customers.customers")}
            </div>
            <div className="flex items-center gap-1.5">
              <HeaderColorPicker layout={layout} isRtl={isRtl} />
              <FooterColorPicker layout={layout} isRtl={isRtl} />
              <ColumnReorderPopover layout={layout} isRtl={isRtl} columns={reorderableCols} />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className={cn("h-7 px-2 text-xs gap-1", theme.btn)}
                onClick={exportCsv}
                data-testid="btn-export-csv-customers"
              >
                <FileSpreadsheet className="h-3.5 w-3.5" />
                CSV
              </Button>
            </div>
          </div>
          <div className="bg-slate-50 border-t border-slate-200 px-3 py-2 flex items-center gap-2 flex-wrap text-xs" dir={isRtl ? "rtl" : "ltr"}>
            <div className="relative">
              <Search className="absolute end-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder={t("pages.customers.searchPlaceholder")}
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pe-7 h-7 text-xs w-64"
              />
            </div>
            {Object.values(colFilters).some(v => v) && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs text-rose-700 hover:bg-rose-50"
                onClick={clearColFilters}
              >
                <X className="h-3.5 w-3.5 me-1" />
                مسح فلاتر الأعمدة
              </Button>
            )}
            <div className="flex-1" />
            <span className="text-slate-700 font-medium">
              {isLoading ? t("common.loading") : t("pages.customers.resultsCount", { count: filtered.length })}
            </span>
          </div>
          <AuditGridBulkBar count={layout.selected.size} onClear={clearSelection}>
            <span className="text-emerald-800">تم تحديد {layout.selected.size} عميل</span>
          </AuditGridBulkBar>
        </div>

        {/* Audit-grid table */}
        <div className="overflow-x-auto bg-white">
          <table ref={tableRef} className="w-full text-[11px] border-collapse" dir={isRtl ? "rtl" : "ltr"}>
            <colgroup>
              {visibleColumns.map((col) => (
                <col
                  key={col.key}
                  data-col-key={col.key}
                  style={colWidths[col.key] ? { width: `${colWidths[col.key]}px` } : undefined}
                />
              ))}
            </colgroup>
            <thead className="sticky top-0 z-10">
              <tr className="bg-gradient-to-b from-slate-100 to-slate-200 text-slate-700">
                {visibleColumns.map((col, idx) => (
                  <th
                    key={col.key}
                    data-col-key={col.key}
                    className={cn(
                      "relative px-2 py-1.5 text-right font-semibold border-e border-slate-300 select-none",
                      col.key === "_sel" && "w-9 text-center px-1",
                      col.key === "_idx" && "w-10 text-center px-1",
                      col.key === "_act" && "w-44 text-center",
                      col.type === "num" && "text-end",
                    )}
                  >
                    {col.key === "_sel" ? (
                      <HeaderSelectCheckbox
                        allSelected={isAllSelected(allFilteredIds)}
                        someSelected={isSomeSelected(allFilteredIds)}
                        onToggle={() => toggleAll(allFilteredIds)}
                        disabled={allFilteredIds.length === 0}
                      />
                    ) : (
                      <span className="inline-block truncate">{col.label}</span>
                    )}
                    {col.key !== "_sel" && (
                      <span
                        {...gripProps(col.key, idx)}
                        className="absolute inset-y-0 start-0 w-1 cursor-col-resize hover:bg-blue-400/40 active:bg-blue-500/60"
                      />
                    )}
                  </th>
                ))}
              </tr>
              <tr className="bg-amber-50/80 border-b border-amber-200">
                {visibleColumns.map((col) => (
                  <th key={col.key} className="px-1 py-1 border-e border-amber-200/60">
                    {col.type === "none" ? null : (
                      <Input
                        value={colFilters[col.key] ?? ""}
                        onChange={(e) => setColFilter(col.key, e.target.value)}
                        placeholder={col.type === "num" ? ">=N" : "فلتر…"}
                        className="h-6 text-[10px] px-1.5 bg-white"
                      />
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>
                    <td colSpan={visibleColumns.length} className="px-3 py-2">
                      <Skeleton className="h-5 w-full" />
                    </td>
                  </tr>
                ))
              ) : paged.length === 0 ? (
                <tr>
                  <td colSpan={visibleColumns.length} className="py-16 text-center">
                    <div className="flex flex-col items-center gap-3 text-muted-foreground">
                      <div className="h-12 w-12 rounded-full bg-muted/60 flex items-center justify-center">
                        <Users className="h-6 w-6 opacity-40" />
                      </div>
                      <p className="text-sm">
                        {search ? t("pages.customers.noResultsMatch") : t("pages.customers.noCustomersInCategory")}
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                paged.map((customer: any, rowIdx: number) => {
                  const bal = Number(balMap[customer.id] ?? 0);
                  const limit = Number(customer.creditLimit ?? 0);
                  const overLimit = limit > 0 && bal > limit;
                  const dictStatus = overLimit
                    ? "overLimit"
                    : bal > 0 ? "debit"
                    : bal < 0 ? "credit"
                    : customer.vatNumber ? "active" : "inactive";
                  const overTooltip = overLimit
                    ? `تجاوز حد الائتمان (${bal.toLocaleString()} > ${limit.toLocaleString()})`
                    : "";
                  const sel = isSelected(customer.id);
                  return (
                    <tr
                      key={customer.id}
                      data-status={dictStatus}
                      data-over-limit={overLimit ? "true" : undefined}
                      className={cn(
                        "border-b border-slate-200 transition-colors group",
                        sel ? SEL_TONE : rowToneFor({ status: dictStatus, statusMap: DICT_TONES }),
                      )}
                      title={overTooltip || buildToneTooltip({ status: dictStatus, statusMap: DICT_TONES })}
                    >
                      {visibleColumns.map((col) => {
                        if (col.key === "_sel") {
                          return (
                            <td key={col.key} className="px-1 py-1 text-center border-e border-slate-200/60">
                              <RowSelectCheckbox
                                checked={sel}
                                onToggle={() => toggleRow(customer.id)}
                                ariaLabel={`تحديد ${customer.nameAr ?? ""}`}
                              />
                            </td>
                          );
                        }
                        if (col.key === "_idx") {
                          return (
                            <td key={col.key} className="px-1 py-1 text-center text-slate-500 font-mono border-e border-slate-200/60">
                              {pageStart + rowIdx}
                            </td>
                          );
                        }
                        if (col.key === "name") {
                          return (
                            <td key={col.key} className="px-2 py-1 border-e border-slate-200/60">
                              <div className="flex items-center gap-2">
                                <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-primary/20 to-primary/10 text-primary font-bold text-xs flex items-center justify-center shrink-0 border border-primary/10">
                                  {customer.nameAr?.[0] ?? "ع"}
                                </div>
                                <div className="min-w-0">
                                  <p className="font-semibold text-foreground leading-tight truncate">{customer.nameAr}</p>
                                  {customer.nameEn && <p className="text-[10px] text-muted-foreground truncate">{customer.nameEn}</p>}
                                </div>
                              </div>
                            </td>
                          );
                        }
                        if (col.key === "vat") {
                          return (
                            <td key={col.key} className="px-2 py-1 border-e border-slate-200/60">
                              {customer.vatNumber ? (
                                <span className="inline-flex items-center gap-1 font-mono text-[10px] bg-green-50 text-green-700 border border-green-200 px-1.5 py-0.5 rounded-full">
                                  <BadgeCheck className="h-3 w-3" />{customer.vatNumber}
                                </span>
                              ) : <span className="text-muted-foreground/40">—</span>}
                            </td>
                          );
                        }
                        if (col.key === "cr") {
                          return (
                            <td key={col.key} className="px-2 py-1 font-mono text-[10px] text-muted-foreground border-e border-slate-200/60">
                              {customer.crNumber || "—"}
                            </td>
                          );
                        }
                        if (col.key === "city") {
                          return (
                            <td key={col.key} className="px-2 py-1 text-muted-foreground border-e border-slate-200/60">
                              {customer.city ? (
                                <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{customer.city}</span>
                              ) : <span className="text-muted-foreground/40">—</span>}
                            </td>
                          );
                        }
                        if (col.key === "phone") {
                          return (
                            <td key={col.key} className="px-2 py-1 text-muted-foreground border-e border-slate-200/60" dir="ltr">
                              {customer.phone ? (
                                <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{customer.phone}</span>
                              ) : <span className="text-muted-foreground/40">—</span>}
                            </td>
                          );
                        }
                        if (col.key === "email") {
                          return (
                            <td key={col.key} className="px-2 py-1 text-muted-foreground border-e border-slate-200/60">
                              {customer.email ? (
                                <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" />{customer.email}</span>
                              ) : <span className="text-muted-foreground/40">—</span>}
                            </td>
                          );
                        }
                        if (col.key === "type") {
                          return (
                            <td key={col.key} className="px-2 py-1 border-e border-slate-200/60">
                              {customer.vatNumber ? (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                                  <Building2 className="h-3 w-3" />B2B
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-blue-50 text-blue-700 border border-blue-200">
                                  <UserCheck className="h-3 w-3" />B2C
                                </span>
                              )}
                            </td>
                          );
                        }
                        if (col.key === "balance") {
                          const abs = Math.abs(bal);
                          const fmt = abs.toLocaleString(isRtl ? "ar-SA-u-nu-latn" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                          return (
                            <td key={col.key} className="px-2 py-1 tabular-nums text-end border-e border-slate-200/60">
                              {Math.abs(bal) < 0.005 ? (
                                <span className="text-[10px] text-muted-foreground/60">{t("pages.customers.balanced")}</span>
                              ) : bal > 0 ? (
                                <span className="inline-flex items-center gap-1">
                                  <span className="font-semibold text-rose-700">{fmt}</span>
                                  <span className="px-1 py-0 rounded-full text-[9px] bg-rose-50 text-rose-700 border border-rose-200">{t("pages.customers.debit")}</span>
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1">
                                  <span className="font-semibold text-emerald-700">{fmt}</span>
                                  <span className="px-1 py-0 rounded-full text-[9px] bg-emerald-50 text-emerald-700 border border-emerald-200">{t("pages.customers.credit")}</span>
                                </span>
                              )}
                            </td>
                          );
                        }
                        if (col.key === "_act") {
                          return (
                            <td key={col.key} className="px-1 py-1">
                              <div className="flex items-center justify-center gap-0.5">
                                <Button variant="ghost" size="icon" asChild className="h-7 w-7" title={t("pages.customers.invoice")}>
                                  <Link href={`/invoices/new?customerId=${customer.id}`}><FileText className="h-3.5 w-3.5" /></Link>
                                </Button>
                                <Button variant="ghost" size="icon" asChild className="h-7 w-7 text-blue-700" title={t("common.edit")}>
                                  <Link href={`/customers/${customer.id}`}><Pencil className="h-3.5 w-3.5" /></Link>
                                </Button>
                                <Button variant="ghost" size="icon" className="h-7 w-7 text-red-700" title={t("common.delete")}
                                  onClick={() => setDeleteTarget(customer)}>
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </td>
                          );
                        }
                        return null;
                      })}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <AuditGridPagination
          layout={layout}
          totalRows={filtered.length}
          pageStart={pageStart}
          pageEnd={pageEnd}
          totalPages={totalPages}
          unitLabel={t("pages.customers.itemLabel", { defaultValue: "عميل" })}
        />
      </div>

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent dir={isRtl ? "rtl" : "ltr"}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("pages.customers.deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              <Trans
                i18nKey="pages.customers.deleteConfirmDesc"
                values={{ name: deleteTarget?.nameAr }}
                components={{ strong: <strong /> }}
              />
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              disabled={deleteMut.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (deleteTarget?.id) deleteMut.mutate({ id: deleteTarget.id });
              }}
            >
              {deleteMut.isPending ? t("pages.customers.deleting") : t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
