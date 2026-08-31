import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { CheckCircle2, Clock, ChevronRight, ChevronLeft, ChevronsRight, ChevronsLeft, Loader2, RotateCcw } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const NUM = "en-US";
const PAGE_SIZES = [10, 20, 50, 100, 500, 1000];
const MONTHS_AR = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];

type ScheduleRow = {
  year?: number; month?: number; days?: number;
  amount?: number; cumulative?: number; posted?: boolean;
  runId?: number | null; runStatus?: string | null;
};
type ScheduleResp = {
  schedule: ScheduleRow[]; totalMonths: number; totalDepreciation: number;
};

// Either drive from a saved asset (assetId → real posted flags) or a raw
// projection (purchaseValue/scrapValue/lifeYears/… before the asset is saved).
export type TimelineProps = {
  assetId?: number | null;
  purchaseValue?: number | string;
  scrapValue?: number | string;
  lifeYears?: number | string;
  depreciationMethod?: string;
  depreciationStart?: string | null;
  purchaseDate?: string | null;
  /** "المجمع حتى تاريخ" resume mode (projection only; saved assets read from the row) */
  accumulatedDepreciation?: number | string;
  accumAsOf?: string | null;
  /** projection = no posted overlay even if some months already ran */
  projection?: boolean;
  title?: string;
};

const fmt = (n?: number) => Number(n || 0).toLocaleString(NUM, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function DepreciationScheduleTimeline(props: TimelineProps) {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };

  const body: Record<string, unknown> = props.assetId
    ? { assetId: props.assetId }
    : {
        purchaseValue: props.purchaseValue,
        scrapValue: props.scrapValue,
        lifeYears: props.lifeYears,
        depreciationMethod: props.depreciationMethod,
        depreciationStart: props.depreciationStart,
        purchaseDate: props.purchaseDate,
        accumulatedDepreciation: props.accumulatedDepreciation,
        accumAsOf: props.accumAsOf || null,
      };

  // A projection needs enough inputs to be meaningful.
  const hasProjectionInputs =
    Number(props.purchaseValue || 0) - Number(props.scrapValue || 0) > 0 &&
    Number(props.lifeYears || 0) > 0 &&
    !!(props.depreciationStart || props.purchaseDate);
  const enabled = !!token && (props.assetId ? true : hasProjectionInputs);

  const { data, isLoading } = useQuery<ScheduleResp>({
    queryKey: ["fa/dep-schedule", props.assetId ?? "projection", JSON.stringify(body)],
    queryFn: async () => {
      const r = await fetch(`${API}/api/fixed-assets/depreciation/schedule`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "فشل حساب الجدول"); }
      return r.json();
    },
    enabled,
  });

  const rows = data?.schedule ?? [];
  const showPosted = !props.projection;
  const showActions = showPosted && !!props.assetId;

  const unpostMutation = useMutation({
    mutationFn: async (runId: number) => {
      const response = await fetch(`${API}/api/fixed-assets/depreciation/${runId}/unpost`, {
        method: "POST",
        headers,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "فشل إلغاء الترحيل");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["fa/dep-schedule"] });
      queryClient.invalidateQueries({ queryKey: ["fa/dep-runs"] });
      queryClient.invalidateQueries({ queryKey: ["fa/assets"] });
      toast({ title: "تم إلغاء الترحيل" });
    },
    onError: (error: Error) => {
      toast({
        title: "تعذّر إلغاء الترحيل",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const confirmUnpost = (runId: number) => {
    if (window.confirm("هل أنت متأكد من إلغاء ترحيل إهلاك هذا الشهر؟")) {
      unpostMutation.mutate(runId);
    }
  };

  const [pageSize, setPageSize] = useState<number>(10);
  const [page, setPage] = useState<number>(1);
  const [statusFilter, setStatusFilter] = useState<"all" | "posted" | "unposted">("all");

  const postedCount = rows.filter((r) => r.posted).length;
  const unpostedCount = rows.length - postedCount;
  const filteredRows = showPosted && statusFilter !== "all"
    ? rows.filter((r) => (statusFilter === "posted" ? r.posted : !r.posted))
    : rows;

  const totalRows = filteredRows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  const pageRows = filteredRows.slice(start, start + pageSize);

  if (!enabled) {
    return (
      <div className="text-xs text-muted-foreground text-center py-6">
        أدخل قيمة الشراء والعمر الإنتاجي وتاريخ بدء الإهلاك لعرض الجدول المتوقع.
      </div>
    );
  }

  return (
    <div dir="rtl">
      {props.title && (
        <div className="text-sm font-semibold text-violet-800 mb-2 flex items-center justify-between gap-2 flex-wrap">
          <span>{props.title}</span>
          {showPosted && totalRows > 0 && (
            <span className="text-[11px] font-normal text-muted-foreground">
              المُرحَّل <span className="font-semibold text-emerald-700">{postedCount.toLocaleString(NUM)}</span> من{" "}
              <span className="font-semibold">{totalRows.toLocaleString(NUM)}</span> شهر
            </span>
          )}
        </div>
      )}
      {isLoading && (
        <div className="text-xs text-muted-foreground text-center py-6">جاري حساب الجدول…</div>
      )}
      {!isLoading && rows.length === 0 && (
        <div className="text-xs text-muted-foreground text-center py-6">لا يوجد جدول إهلاك لهذا الأصل.</div>
      )}
      {!isLoading && rows.length > 0 && (
        <>
          {showPosted && (
            <div className="flex items-center gap-1 mb-2 flex-wrap">
              {([
                ["all", "الكل", rows.length],
                ["posted", "المُرحَّلة", postedCount],
                ["unposted", "غير المُرحَّلة", unpostedCount],
              ] as const).map(([val, label, count]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => { setStatusFilter(val); setPage(1); }}
                  className={[
                    "h-7 px-3 rounded-md border text-[11px] font-semibold transition-colors",
                    statusFilter === val
                      ? val === "posted"
                        ? "bg-emerald-600 border-emerald-600 text-white"
                        : val === "unposted"
                          ? "bg-amber-500 border-amber-500 text-white"
                          : "bg-violet-600 border-violet-600 text-white"
                      : "bg-background border-input text-slate-600 hover:bg-slate-50",
                  ].join(" ")}
                >
                  {label} ({count.toLocaleString(NUM)})
                </button>
              ))}
            </div>
          )}
          {totalRows === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-6 border border-dashed border-slate-200 rounded-lg">
              لا توجد أسطر مطابقة لهذا الفلتر.
            </div>
          ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-violet-50 text-violet-800">
                  <th className="px-2 py-2 text-center font-semibold border-b border-slate-200 w-12">#</th>
                  <th className="px-3 py-2 text-right font-semibold border-b border-slate-200">الشهر</th>
                  <th className="px-3 py-2 text-center font-semibold border-b border-slate-200">عدد الأيام</th>
                  <th className="px-3 py-2 text-left font-semibold border-b border-slate-200">قيمة الإهلاك</th>
                  <th className="px-3 py-2 text-left font-semibold border-b border-slate-200">المتراكم</th>
                  {showPosted && (
                    <th className="px-3 py-2 text-center font-semibold border-b border-slate-200">الحالة</th>
                  )}
                  {showActions && (
                    <th className="px-3 py-2 text-center font-semibold border-b border-slate-200">الإجراءات</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r, i) => {
                  const done = showPosted && r.posted;
                  return (
                    <tr
                      key={`${r.year}-${r.month}`}
                      className={done ? "bg-emerald-50/60" : i % 2 ? "bg-slate-50/50" : "bg-white"}
                    >
                      <td className="px-2 py-1.5 text-center text-slate-500 border-b border-slate-100">
                        {(start + i + 1).toLocaleString(NUM)}
                      </td>
                      <td className="px-3 py-1.5 text-right font-medium text-slate-700 border-b border-slate-100 whitespace-nowrap">
                        {MONTHS_AR[(r.month ?? 0) - 1] ?? ""} {r.year ?? ""}
                      </td>
                      <td className="px-3 py-1.5 text-center text-slate-600 border-b border-slate-100">
                        {Number(r.days ?? 0).toLocaleString(NUM)}
                      </td>
                      <td className="px-3 py-1.5 text-left font-mono font-bold text-violet-800 border-b border-slate-100">
                        {fmt(r.amount)}
                      </td>
                      <td className="px-3 py-1.5 text-left font-mono text-slate-600 border-b border-slate-100">
                        {fmt(r.cumulative)}
                      </td>
                      {showPosted && (
                        <td className="px-3 py-1.5 text-center border-b border-slate-100 whitespace-nowrap">
                          {done ? (
                            <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
                              <CheckCircle2 className="h-3.5 w-3.5" /> تم ترحيلها
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-amber-600 font-semibold">
                              <Clock className="h-3.5 w-3.5" /> لم تُرحَّل بعد
                            </span>
                          )}
                        </td>
                      )}
                      {showActions && (
                        <td className="px-3 py-1.5 text-center border-b border-slate-100 whitespace-nowrap">
                          {r.runStatus === "posted" && r.runId != null && (
                            <button
                              type="button"
                              data-testid={`depreciation-schedule-unpost-${r.runId}`}
                              onClick={() => confirmUnpost(r.runId!)}
                              disabled={unpostMutation.isPending && unpostMutation.variables === r.runId}
                              className="inline-flex h-7 items-center gap-1 rounded-md border border-amber-300 bg-white px-2 font-semibold text-amber-700 transition-colors hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {unpostMutation.isPending && unpostMutation.variables === r.runId ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <RotateCcw className="h-3.5 w-3.5" />
                              )}
                              {unpostMutation.isPending && unpostMutation.variables === r.runId
                                ? "جاري الإلغاء…"
                                : "إلغاء الترحيل"}
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          )}

          {/* pagination + totals */}
          <div className="flex items-center justify-between gap-3 mt-2 flex-wrap">
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>عدد الأسطر:</span>
              <select
                className="h-7 px-2 rounded-md border border-input bg-background text-xs"
                value={pageSize}
                onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
              >
                {PAGE_SIZES.map((s) => (
                  <option key={s} value={s}>{s.toLocaleString(NUM)}</option>
                ))}
              </select>
              <span className="mr-1">
                عرض {(start + 1).toLocaleString(NUM)}–{Math.min(start + pageSize, totalRows).toLocaleString(NUM)} من{" "}
                {totalRows.toLocaleString(NUM)}
              </span>
            </div>

            <div className="flex items-center gap-1">
              <button type="button" disabled={safePage <= 1} onClick={() => setPage(1)}
                className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-input bg-background disabled:opacity-40 hover:bg-slate-50">
                <ChevronsRight className="h-4 w-4" />
              </button>
              <button type="button" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}
                className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-input bg-background disabled:opacity-40 hover:bg-slate-50">
                <ChevronRight className="h-4 w-4" />
              </button>
              <span className="text-[11px] text-slate-600 px-2 whitespace-nowrap">
                صفحة {safePage.toLocaleString(NUM)} من {totalPages.toLocaleString(NUM)}
              </span>
              <button type="button" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}
                className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-input bg-background disabled:opacity-40 hover:bg-slate-50">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button type="button" disabled={safePage >= totalPages} onClick={() => setPage(totalPages)}
                className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-input bg-background disabled:opacity-40 hover:bg-slate-50">
                <ChevronsLeft className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="text-[11px] text-muted-foreground mt-2">
            إجمالي {(data?.totalMonths ?? rows.length).toLocaleString(NUM)} شهر — إجمالي الإهلاك{" "}
            <span className="font-mono font-semibold text-violet-700">
              {fmt(data?.totalDepreciation ?? 0)} ر.س
            </span>
          </div>
        </>
      )}
    </div>
  );
}
