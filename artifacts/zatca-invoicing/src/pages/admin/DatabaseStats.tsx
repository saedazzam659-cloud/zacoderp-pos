// SuperAdmin-only page showing live database storage usage so the operator
// can plan plan upgrades before hitting Replit/Neon storage limits.
//
// Data source: GET /api/admin/db-stats (returns total DB size, the 15
// heaviest tables, and quick counts of the headline business entities).
// We refresh once per minute via React Query — no aggressive polling so
// this page stays well under the deployment's request budget.

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Database, HardDrive, Table2, Loader2, RefreshCcw, AlertCircle, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

interface DbStats {
  database: { name: string; sizeBytes: number; sizePretty: string };
  topTables: {
    name: string;
    totalBytes: number;
    totalPretty: string;
    tablePretty: string;
    indexPretty: string;
    rowEstimate: number;
  }[];
  counts: Record<string, number | null>;
  capturedAt: string;
}

const ENTITY_LABELS: Record<string, string> = {
  companies:         "الشركات",
  users:             "المستخدمون",
  customers:         "العملاء",
  suppliers:         "الموردون",
  items:             "الأصناف",
  sales_invoices:    "فواتير المبيعات",
  purchase_invoices: "فواتير المشتريات",
  journal_entries:   "القيود المحاسبية",
  stock_ledger:      "حركات المخزون",
  audit_log:         "سجل التدقيق",
};

function formatNumber(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("ar-SA").format(n);
}

export default function DatabaseStats() {
  const { token } = useAuth() as any;

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<DbStats>({
    queryKey: ["admin-db-stats"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/db-stats`, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: "include",
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error ?? "تعذر جلب الإحصاءات");
      }
      return r.json();
    },
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });

  // Compute the largest table's share so we can render proportional bars.
  const maxBytes = data?.topTables[0]?.totalBytes ?? 1;

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
            مراقبة حجم التخزين وعدد السجلات لتخطيط ترقية الباقة عند الحاجة.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => refetch()}
          disabled={isFetching}
          className="gap-2"
        >
          <RefreshCcw className={cn("h-4 w-4", isFetching && "animate-spin")} />
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
                <p className="text-sm font-medium mt-1">
                  {new Date(data.capturedAt).toLocaleString("ar-SA")}
                </p>
              </div>
            </div>
          </div>

          {/* ─── Quick entity counts ─────────────────────────────────────── */}
          <div className="rounded-xl border bg-card p-5 space-y-4">
            <h2 className="font-semibold text-base flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              عدد السجلات الرئيسية
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {Object.entries(data.counts).map(([key, value]) => (
                <div
                  key={key}
                  className="rounded-lg border bg-background p-3 hover:shadow-sm transition-shadow"
                >
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
                        <span className="font-semibold text-foreground tabular-nums w-20 text-end">
                          {t.totalPretty}
                        </span>
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
            <p>• ينصح بترقية الباقة عند تجاوز 70-80% من الحد المسموح للحفاظ على أداء سريع وتجنب أي توقف.</p>
            <p>• الملفات الكبيرة (شعارات، مرفقات، نسخ احتياطية) تُخزَّن في Object Storage منفصل ولا تظهر هنا.</p>
          </div>
        </>
      )}
    </div>
  );
}
