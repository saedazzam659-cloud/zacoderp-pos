import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { CheckCircle2, Clock } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const NUM = "ar-EG-u-ca-gregory-nu-latn";
const MONTHS_AR = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];

type ScheduleRow = {
  year: number; month: number; days: number;
  amount: number; cumulative: number; posted: boolean;
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
  /** projection = no posted overlay even if some months already ran */
  projection?: boolean;
  title?: string;
};

export default function DepreciationScheduleTimeline(props: TimelineProps) {
  const { token } = useAuth() as any;
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
        <div className="text-sm font-semibold text-violet-800 mb-2">{props.title}</div>
      )}
      {isLoading && (
        <div className="text-xs text-muted-foreground text-center py-6">جاري حساب الجدول…</div>
      )}
      {!isLoading && rows.length === 0 && (
        <div className="text-xs text-muted-foreground text-center py-6">لا يوجد جدول إهلاك لهذا الأصل.</div>
      )}
      {!isLoading && rows.length > 0 && (
        <>
          <div className="flex flex-wrap gap-2">
            {rows.map((r) => {
              const done = showPosted && r.posted;
              return (
                <div
                  key={`${r.year}-${r.month}`}
                  className={[
                    "relative rounded-lg border px-3 py-2 min-w-[7.5rem] shadow-sm transition-colors",
                    done
                      ? "bg-emerald-50 border-emerald-300"
                      : "bg-white border-slate-200",
                  ].join(" ")}
                  title={`${r.days} يوم — متراكم ${r.cumulative.toLocaleString(NUM, { maximumFractionDigits: 2 })}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold text-slate-700">
                      {MONTHS_AR[r.month - 1]} {r.year}
                    </span>
                    {done ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                    ) : (
                      <Clock className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                    )}
                  </div>
                  <div className="text-sm font-bold font-mono text-violet-800 mt-0.5">
                    {r.amount.toLocaleString(NUM, { maximumFractionDigits: 2 })}
                  </div>
                  <div className="text-[10px] mt-0.5">
                    {showPosted ? (
                      done ? (
                        <span className="text-emerald-700 font-semibold">تم ترحيلها ✅</span>
                      ) : (
                        <span className="text-amber-600 font-semibold">لم تُرحَّل بعد ⏳</span>
                      )
                    ) : (
                      <span className="text-slate-500">{r.days} يوم</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="text-[11px] text-muted-foreground mt-2">
            إجمالي {data?.totalMonths ?? rows.length} شهر — إجمالي الإهلاك{" "}
            <span className="font-mono font-semibold text-violet-700">
              {(data?.totalDepreciation ?? 0).toLocaleString(NUM, { maximumFractionDigits: 2 })} ر.س
            </span>
          </div>
        </>
      )}
    </div>
  );
}
