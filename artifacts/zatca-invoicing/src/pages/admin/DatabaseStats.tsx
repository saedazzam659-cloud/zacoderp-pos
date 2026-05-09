// SuperAdmin-only page showing live database storage usage so the operator
// can plan plan upgrades before hitting Replit/Neon storage limits.
//
// Data sources:
//  - GET /api/admin/db-stats           — total DB size + 15 heaviest tables
//  - GET /api/admin/db-stats/by-company — per-company estimated storage
// We refresh once per minute via React Query.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import {
  Database, HardDrive, Table2, Loader2, RefreshCcw, AlertCircle,
  TrendingUp, Building2, Crown, Users, BarChart3, Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

interface DbStats {
  database: { name: string; sizeBytes: number; sizePretty: string };
  topTables: {
    name: string; totalBytes: number; totalPretty: string;
    tablePretty: string; indexPretty: string; rowEstimate: number;
  }[];
  counts: Record<string, number | null>;
  capturedAt: string;
}

interface CompanyUsage {
  companyId: number;
  companyName: string;
  isDeleted: boolean;
  totalRows: number;
  estimatedBytes: number;
  byTable: Record<string, { rows: number; bytes: number }>;
}

interface ByCompanyResp {
  tables: string[];
  companies: CompanyUsage[];
  summary: {
    totalCompanies: number;
    totalBytes: number;
    totalRows: number;
    avgBytes: number;
    avgRows: number;
    topCompany:    { id: number; name: string; bytes: number; rows: number } | null;
    bottomCompany: { id: number; name: string; bytes: number; rows: number } | null;
  };
  capturedAt: string;
}

const ENTITY_LABELS: Record<string, string> = {
  companies: "الشركات", users: "المستخدمون", customers: "العملاء",
  suppliers: "الموردون", items: "الأصناف", sales_invoices: "فواتير المبيعات",
  purchase_invoices: "فواتير المشتريات", journal_entries: "القيود المحاسبية",
  stock_ledger: "حركات المخزون", audit_log: "سجل التدقيق",
};

function formatNumber(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("ar-SA").format(n);
}

function formatBytes(n: number): string {
  if (!n || n < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

export default function DatabaseStats() {
  const { token } = useAuth() as any;
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>("");

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<DbStats>({
    queryKey: ["admin-db-stats"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/db-stats`, {
        headers: { Authorization: `Bearer ${token}` }, credentials: "include",
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error ?? "تعذر جلب الإحصاءات");
      }
      return r.json();
    },
    refetchInterval: 60_000, refetchOnWindowFocus: false,
  });

  const byCompanyQ = useQuery<ByCompanyResp>({
    queryKey: ["admin-db-stats-by-company"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/db-stats/by-company`, {
        headers: { Authorization: `Bearer ${token}` }, credentials: "include",
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error ?? "تعذر جلب استهلاك الشركات");
      }
      return r.json();
    },
    refetchInterval: 60_000, refetchOnWindowFocus: false,
  });

  const maxBytes = data?.topTables[0]?.totalBytes ?? 1;
  const companies = byCompanyQ.data?.companies ?? [];
  const summary = byCompanyQ.data?.summary;
  const topMaxBytes = companies[0]?.estimatedBytes || 1;

  const comboItems = useMemo(() => companies.map((c) => ({
    value: String(c.companyId),
    label: `${c.companyName}${c.isDeleted ? " (محذوفة)" : ""}`,
    description: `${formatBytes(c.estimatedBytes)} • ${formatNumber(c.totalRows)} سجل`,
    badge: c.isDeleted ? "محذوفة" : undefined,
    badgeClass: c.isDeleted ? "bg-red-100 text-red-700" : undefined,
  })), [companies]);

  const selectedCompany = useMemo(() => {
    if (!selectedCompanyId) return null;
    return companies.find((c) => String(c.companyId) === selectedCompanyId) ?? null;
  }, [selectedCompanyId, companies]);

  const refreshAll = () => { refetch(); byCompanyQ.refetch(); };

  return (
    <div className="space-y-6 p-6">
      {/* ─── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Database className="h-6 w-6 text-primary" />
            إحصاءات قاعدة البيانات
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            مراقبة حجم التخزين، عدد السجلات، واستهلاك كل شركة لتخطيط ترقية الباقة عند الحاجة.
          </p>
        </div>
        <Button variant="outline" onClick={refreshAll} disabled={isFetching || byCompanyQ.isFetching} className="gap-2">
          <RefreshCcw className={cn("h-4 w-4", (isFetching || byCompanyQ.isFetching) && "animate-spin")} />
          تحديث
        </Button>
      </div>

      {isLoading && (
        <div className="rounded-xl border bg-card p-8 flex items-center justify-center text-muted-foreground gap-2">
          <Loader2 className="h-5 w-5 animate-spin" />
          جارِ تحميل الإحصاءات...
        </div>
      )}

      {isError && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-5 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-destructive">تعذر جلب الإحصاءات</p>
            <p className="text-sm text-muted-foreground mt-1">{(error as Error)?.message}</p>
          </div>
        </div>
      )}

      {data && (
        <>
          {/* ─── Hero size card ──────────────────────────────────────────── */}
          <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-6 shadow-sm">
            <div className="flex items-start gap-4 flex-wrap">
              <div className="h-14 w-14 rounded-xl bg-primary/15 text-primary flex items-center justify-center shadow-inner">
                <HardDrive className="h-7 w-7" />
              </div>
              <div className="flex-1 min-w-[200px]">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">الحجم الكلي لقاعدة البيانات</p>
                <p className="text-4xl font-bold mt-1">{data.database.sizePretty}</p>
                <p className="text-xs text-muted-foreground mt-1 font-mono">
                  {data.database.name} • {formatNumber(data.database.sizeBytes)} bytes
                </p>
              </div>
              <div className="text-end">
                <p className="text-xs text-muted-foreground">آخر تحديث</p>
                <p className="text-sm font-medium mt-1">{new Date(data.capturedAt).toLocaleString("ar-SA")}</p>
              </div>
            </div>
          </div>

          {/* ─── Per-company dashboard ──────────────────────────────────── */}
          {byCompanyQ.isError && (
            <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
              تعذر جلب استهلاك الشركات: {(byCompanyQ.error as Error)?.message}
            </div>
          )}

          {summary && (
            <div className="space-y-4">
              <h2 className="font-semibold text-base flex items-center gap-2">
                <Building2 className="h-4 w-4 text-muted-foreground" />
                استهلاك قاعدة البيانات حسب الشركة
              </h2>

              {/* KPI cards */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <KpiCard
                  icon={<Users className="h-5 w-5" />}
                  label="عدد الشركات النشطة"
                  value={formatNumber(summary.totalCompanies)}
                  tone="violet"
                />
                <KpiCard
                  icon={<Crown className="h-5 w-5" />}
                  label="أكبر مستهلك"
                  value={summary.topCompany?.name ?? "—"}
                  sub={summary.topCompany ? formatBytes(summary.topCompany.bytes) : ""}
                  tone="amber"
                />
                <KpiCard
                  icon={<BarChart3 className="h-5 w-5" />}
                  label="متوسط الاستهلاك / شركة"
                  value={formatBytes(summary.avgBytes)}
                  sub={`${formatNumber(summary.avgRows)} سجل`}
                  tone="emerald"
                />
                <KpiCard
                  icon={<HardDrive className="h-5 w-5" />}
                  label="الإجمالي المنسوب للشركات"
                  value={formatBytes(summary.totalBytes)}
                  sub={`${formatNumber(summary.totalRows)} سجل`}
                  tone="primary"
                />
              </div>

              {/* Combobox + selected company breakdown */}
              <div className="rounded-xl border bg-card p-5 space-y-4">
                <div className="flex items-end gap-3 flex-wrap">
                  <div className="flex-1 min-w-[260px]">
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">
                      ابحث عن شركة لعرض تفاصيل استهلاكها
                    </label>
                    <SearchCombobox
                      items={[{ value: "", label: "— كل الشركات —" }, ...comboItems]}
                      value={selectedCompanyId}
                      onValueChange={setSelectedCompanyId}
                      placeholder="اختر شركة..."
                      searchPlaceholder="ابحث بالاسم..."
                    />
                  </div>
                  {selectedCompany && (
                    <Button variant="ghost" size="sm" onClick={() => setSelectedCompanyId("")}>
                      مسح الاختيار
                    </Button>
                  )}
                </div>

                {selectedCompany && (
                  <div className="rounded-lg border-2 border-primary/30 bg-primary/5 p-4 space-y-3">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="flex items-center gap-2">
                        <Building2 className="h-5 w-5 text-primary" />
                        <span className="font-semibold text-lg">{selectedCompany.companyName}</span>
                        {selectedCompany.isDeleted && (
                          <span className="inline-flex items-center gap-1 text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded">
                            <Trash2 className="h-3 w-3" /> محذوفة
                          </span>
                        )}
                      </div>
                      <div className="text-end">
                        <p className="text-xs text-muted-foreground">الحجم التقديري</p>
                        <p className="text-2xl font-bold text-primary">{formatBytes(selectedCompany.estimatedBytes)}</p>
                        <p className="text-xs text-muted-foreground">{formatNumber(selectedCompany.totalRows)} سجل</p>
                      </div>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-2">أكبر 10 جداول لهذه الشركة</p>
                      <div className="space-y-1.5">
                        {Object.entries(selectedCompany.byTable)
                          .sort((a, b) => b[1].bytes - a[1].bytes)
                          .slice(0, 10)
                          .map(([t, info]) => {
                            const pct = Math.max(2, Math.round((info.bytes / Math.max(1, selectedCompany.estimatedBytes)) * 100));
                            return (
                              <div key={t} className="space-y-0.5">
                                <div className="flex items-center justify-between text-xs">
                                  <span className="font-mono truncate max-w-[60%]">{t}</span>
                                  <span className="text-muted-foreground tabular-nums">
                                    {formatNumber(info.rows)} سجل • <span className="font-semibold text-foreground">{formatBytes(info.bytes)}</span>
                                  </span>
                                </div>
                                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                                  <div className="h-full bg-primary/70 rounded-full" style={{ width: `${pct}%` }} />
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Top consumers leaderboard */}
              <div className="rounded-xl border bg-card p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-sm flex items-center gap-2">
                    <Crown className="h-4 w-4 text-amber-500" />
                    أكبر 10 شركات استهلاكاً للقاعدة
                  </h3>
                  <span className="text-xs text-muted-foreground">{summary.totalCompanies} شركة إجمالاً</span>
                </div>
                <div className="space-y-2">
                  {companies.slice(0, 10).map((c, idx) => {
                    const pct = Math.max(2, Math.round((c.estimatedBytes / topMaxBytes) * 100));
                    const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : null;
                    return (
                      <div
                        key={c.companyId}
                        className={cn(
                          "rounded-lg border p-3 cursor-pointer hover:bg-muted/40 transition-colors",
                          String(c.companyId) === selectedCompanyId && "border-primary bg-primary/5",
                        )}
                        onClick={() => setSelectedCompanyId(String(c.companyId))}
                      >
                        <div className="flex items-center justify-between gap-3 mb-1.5">
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <span className="text-base w-6 text-center">{medal ?? <span className="text-xs text-muted-foreground">{idx + 1}.</span>}</span>
                            <span className="font-medium truncate">{c.companyName}</span>
                            {c.isDeleted && <span className="text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded">محذوفة</span>}
                          </div>
                          <div className="text-end shrink-0">
                            <span className="font-bold tabular-nums">{formatBytes(c.estimatedBytes)}</span>
                            <span className="text-xs text-muted-foreground block">{formatNumber(c.totalRows)} سجل</span>
                          </div>
                        </div>
                        <div className="h-2 rounded-full bg-muted overflow-hidden">
                          <div
                            className={cn(
                              "h-full rounded-full transition-all",
                              idx === 0 ? "bg-amber-500" :
                              idx === 1 ? "bg-slate-400" :
                              idx === 2 ? "bg-orange-400" :
                                          "bg-primary/50",
                            )}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                  {companies.length === 0 && (
                    <p className="text-center text-sm text-muted-foreground py-6">لا توجد بيانات استهلاك بعد.</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ─── Quick entity counts ─────────────────────────────────────── */}
          <div className="rounded-xl border bg-card p-5 space-y-4">
            <h2 className="font-semibold text-base flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              عدد السجلات الرئيسية
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {Object.entries(data.counts).map(([key, value]) => (
                <div key={key} className="rounded-lg border bg-background p-3 hover:shadow-sm transition-shadow">
                  <p className="text-xs text-muted-foreground truncate">{ENTITY_LABELS[key] ?? key}</p>
                  <p className="text-xl font-bold mt-1 tabular-nums">{formatNumber(value)}</p>
                </div>
              ))}
            </div>
          </div>

          {/* ─── Top tables by size ──────────────────────────────────────── */}
          <div className="rounded-xl border bg-card p-5 space-y-4">
            <h2 className="font-semibold text-base flex items-center gap-2">
              <Table2 className="h-4 w-4 text-muted-foreground" />
              أكبر 15 جدولاً من حيث الحجم
            </h2>
            <div className="space-y-2">
              {data.topTables.map((t, idx) => {
                const pct = Math.max(2, Math.round((t.totalBytes / maxBytes) * 100));
                return (
                  <div key={t.name} className="space-y-1">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <span className="text-xs text-muted-foreground tabular-nums w-6">{idx + 1}.</span>
                        <span className="font-mono text-xs truncate">{t.name}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                        <span title="عدد السجلات (تقديري)">{formatNumber(t.rowEstimate)} سجل</span>
                        <span className="font-semibold text-foreground tabular-nums w-20 text-end">{t.totalPretty}</span>
                      </div>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div
                        className={cn(
                          "h-full rounded-full transition-all",
                          idx === 0 ? "bg-primary" :
                          idx < 3   ? "bg-primary/70" :
                          idx < 6   ? "bg-primary/50" :
                                      "bg-primary/30",
                        )}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-[10px] text-muted-foreground/70 px-1">
                      <span>بيانات: {t.tablePretty}</span>
                      <span>فهارس: {t.indexPretty}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ─── Capacity-planning footnote ──────────────────────────────── */}
          <div className="rounded-lg bg-muted/40 border border-dashed p-4 text-xs text-muted-foreground space-y-1">
            <p>• قاعدة البيانات الحالية مبنية على Neon Postgres المُدار عبر Replit. الحد الأقصى للحجم يعتمد على باقة الاشتراك.</p>
            <p>• استهلاك الشركات تقديري — يحسب بناءً على متوسط حجم الصف لكل جدول مضروباً في عدد صفوف الشركة.</p>
            <p>• ينصح بترقية الباقة عند تجاوز 70-80% من الحد المسموح للحفاظ على أداء سريع وتجنب أي توقف.</p>
            <p>• الملفات الكبيرة (شعارات، مرفقات، نسخ احتياطية) تُخزَّن في Object Storage منفصل ولا تظهر هنا.</p>
          </div>
        </>
      )}
    </div>
  );
}

function KpiCard({
  icon, label, value, sub, tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone: "violet" | "amber" | "emerald" | "primary";
}) {
  const tones: Record<string, string> = {
    violet:  "from-violet-500/15 to-violet-500/5 text-violet-600 border-violet-200/60",
    amber:   "from-amber-500/15 to-amber-500/5 text-amber-700 border-amber-200/60",
    emerald: "from-emerald-500/15 to-emerald-500/5 text-emerald-700 border-emerald-200/60",
    primary: "from-primary/15 to-primary/5 text-primary border-primary/20",
  };
  return (
    <div className={cn("rounded-xl border bg-gradient-to-br p-4 shadow-sm", tones[tone])}>
      <div className="flex items-center gap-2 mb-2 opacity-90">{icon}<span className="text-xs font-medium">{label}</span></div>
      <p className="text-xl font-bold truncate text-foreground" title={typeof value === "string" ? value : undefined}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5 truncate">{sub}</p>}
    </div>
  );
}
