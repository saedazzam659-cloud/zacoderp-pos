import { useListCustomers, useDeleteCustomer } from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Plus, Users, Search, Phone, Mail, MapPin,
  BadgeCheck, Building2, UserCheck, FileText, Pencil, Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import ExportButtons from "@/components/ExportButtons";
import { TablePagination, usePagination } from "@/components/TablePagination";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useTranslation } from "react-i18next";
import { Trans } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  rowToneFor, DocColorLegend, buildToneTooltip, DICT_TONES, type LegendItem,
} from "@/lib/docRowTone";

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

  const filtered = (customers as any[]).filter(c => {
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

  const pager = usePagination(filtered);

  const isRtl = i18n.language === "ar";

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
          // overLimit takes precedence over debit (so the same customer is not
          // double-counted): a row with bal>0 AND limit>0 AND bal>limit shows
          // up only in the "تجاوز الائتمان" chip.
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

        {/* Search bar */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b bg-muted/10">
          <p className="text-xs text-muted-foreground">
            {isLoading ? t("common.loading") : t("pages.customers.resultsCount", { count: filtered.length })}
          </p>
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder={t("pages.customers.searchPlaceholder")}
              className="pr-9 h-8 w-64 text-sm"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/20">
                <th className="h-9 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide">{t("pages.customers.customer")}</th>
                <th className="h-9 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide hidden sm:table-cell">{t("pages.customers.vatNumber")}</th>
                <th className="h-9 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide hidden md:table-cell">{t("pages.customers.city")}</th>
                <th className="h-9 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide hidden lg:table-cell">{t("pages.customers.contact")}</th>
                <th className="h-9 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide">{t("pages.customers.type")}</th>
                <th className="h-9 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide">{t("pages.customers.balance")}</th>
                <th className="h-9 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b">
                    {Array.from({ length: 7 }).map((_, j) => (
                      <td key={j} className="px-5 py-3.5">
                        <Skeleton className="h-4 w-full max-w-32" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-20 text-center">
                    <div className="flex flex-col items-center gap-3 text-muted-foreground">
                      <div className="h-14 w-14 rounded-full bg-muted/60 flex items-center justify-center">
                        <Users className="h-7 w-7 opacity-40" />
                      </div>
                      <div>
                        <p className="font-medium text-sm">
                          {search ? t("pages.customers.noResultsMatch") : t("pages.customers.noCustomersInCategory")}
                        </p>
                        <p className="text-xs mt-0.5 opacity-70">
                          {search ? t("pages.customers.tryDifferentSearch") : t("pages.customers.startByAdding")}
                        </p>
                      </div>
                      {!search && (
                        <Button asChild variant="outline" size="sm" className="gap-2 mt-1">
                          <Link href="/customers/new">
                            <Plus className="h-3.5 w-3.5" />{t("pages.customers.addCustomer")}
                          </Link>
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                pager.pagedItems.map((customer: any) => {
                  const bal = Number(balMap[customer.id] ?? 0);
                  // Credit limit: 0/null means "no limit set" — only flag when
                  // a positive limit exists AND the receivable balance exceeds it.
                  const limit = Number(customer.creditLimit ?? 0);
                  const overLimit = limit > 0 && bal > limit;
                  // Over-limit beats every other dictionary status — it's a
                  // collection-risk warning the user should not be able to miss.
                  const dictStatus = overLimit
                    ? "overLimit"
                    : bal > 0
                      ? "debit"
                      : bal < 0
                        ? "credit"
                        : customer.vatNumber
                          ? "active"
                          : "inactive";
                  const overTooltip = overLimit
                    ? `تجاوز حد الائتمان (${bal.toLocaleString()} > ${limit.toLocaleString()})`
                    : "";
                  return (
                  <tr
                    key={customer.id}
                    data-status={dictStatus}
                    data-over-limit={overLimit ? "true" : undefined}
                    className={cn("border-b transition-colors group", rowToneFor({ status: dictStatus, statusMap: DICT_TONES }))}
                    title={overTooltip || buildToneTooltip({ status: dictStatus, statusMap: DICT_TONES })}
                  >
                    {/* Customer name */}
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-primary/20 to-primary/10 text-primary font-bold text-sm flex items-center justify-center shrink-0 border border-primary/10">
                          {customer.nameAr?.[0] ?? "ع"}
                        </div>
                        <div>
                          <p className="font-semibold text-foreground leading-tight">{customer.nameAr}</p>
                          {customer.nameEn && (
                            <p className="text-xs text-muted-foreground">{customer.nameEn}</p>
                          )}
                        </div>
                      </div>
                    </td>

                    {/* VAT */}
                    <td className="px-5 py-3 hidden sm:table-cell">
                      {customer.vatNumber ? (
                        <span className="inline-flex items-center gap-1 font-mono text-xs bg-green-50 text-green-700 border border-green-200 px-2 py-0.5 rounded-full">
                          <BadgeCheck className="h-3 w-3" />{customer.vatNumber}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40 text-xs">—</span>
                      )}
                    </td>

                    {/* City */}
                    <td className="px-5 py-3 hidden md:table-cell text-sm text-muted-foreground">
                      {customer.city ? (
                        <span className="flex items-center gap-1">
                          <MapPin className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                          {customer.city}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>

                    {/* Contact */}
                    <td className="px-5 py-3 hidden lg:table-cell">
                      <div className="space-y-0.5">
                        {customer.phone && (
                          <p className="text-xs text-muted-foreground flex items-center gap-1" dir="ltr">
                            <Phone className="h-3 w-3 shrink-0" />{customer.phone}
                          </p>
                        )}
                        {customer.email && (
                          <p className="text-xs text-muted-foreground flex items-center gap-1">
                            <Mail className="h-3 w-3 shrink-0" />{customer.email}
                          </p>
                        )}
                        {!customer.phone && !customer.email && (
                          <span className="text-muted-foreground/40 text-xs">—</span>
                        )}
                      </div>
                    </td>

                    {/* Type badge */}
                    <td className="px-5 py-3">
                      {customer.vatNumber ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                          <Building2 className="h-3 w-3" />{t("pages.customers.companiesB2b")}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">
                          <UserCheck className="h-3 w-3" />{t("pages.customers.individualsB2c")}
                        </span>
                      )}
                    </td>

                    {/* Balance */}
                    <td className="px-5 py-3">
                      {(() => {
                        const bal = balMap[customer.id] ?? 0;
                        const abs = Math.abs(bal);
                        const fmt = abs.toLocaleString(isRtl ? "ar-SA-u-nu-latn" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                        if (Math.abs(bal) < 0.005) {
                          return <span className="text-xs text-muted-foreground/60">{t("pages.customers.balanced")}</span>;
                        }
                        if (bal > 0) {
                          return (
                            <span className="inline-flex items-center gap-1.5">
                              <span className="font-semibold tabular-nums text-rose-700">{fmt}</span>
                              <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-rose-50 text-rose-700 border border-rose-200">{t("pages.customers.debit")}</span>
                            </span>
                          );
                        }
                        return (
                          <span className="inline-flex items-center gap-1.5">
                            <span className="font-semibold tabular-nums text-emerald-700">{fmt}</span>
                            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">{t("pages.customers.credit")}</span>
                          </span>
                        );
                      })()}
                    </td>

                    {/* Actions */}
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" asChild className="h-7 px-2.5 text-xs gap-1">
                          <Link href={`/invoices/new?customerId=${customer.id}`}>
                            <FileText className="h-3 w-3" />{t("pages.customers.invoice")}
                          </Link>
                        </Button>
                        <Button variant="outline" size="sm" asChild className="h-7 px-2.5 text-xs gap-1 border-blue-200 text-blue-700 hover:bg-blue-50">
                          <Link href={`/customers/${customer.id}`}>
                            <Pencil className="h-3 w-3" />{t("common.edit")}
                          </Link>
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2.5 text-xs gap-1 border-red-200 text-red-700 hover:bg-red-50"
                          onClick={() => setDeleteTarget(customer)}
                        >
                          <Trash2 className="h-3 w-3" />{t("common.delete")}
                        </Button>
                      </div>
                    </td>
                  </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        {!isLoading && filtered.length > 0 && (
          <TablePagination
            page={pager.page}
            pageSize={pager.pageSize}
            pageCount={pager.pageCount}
            total={pager.total}
            onPageChange={pager.setPage}
            onPageSizeChange={pager.setPageSize}
            itemLabel={t("pages.customers.itemLabel", { defaultValue: "عميل" })}
          />
        )}
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
