import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Loader2, RefreshCw, ChevronDown, ChevronUp, CheckCircle2,
  AlertTriangle, AlertCircle, Clock, Download, Save, CalendarClock,
  History,
} from "lucide-react";
import { Input } from "@/components/ui/input";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// Render-prop signature for the inline detail panel. Receives the loaded
// check payload and a `selectedIds` getter/setter so the caller can control
// which rows the "إصلاح" action will operate on.
export type DetailRenderer = (args: {
  data: any;
  selectedIds: Array<string | number>;
  toggle: (id: string | number) => void;
  toggleAll: (ids: Array<string | number>) => void;
  allSelected: boolean;
}) => React.ReactNode;

export type MaintenanceToolProps = {
  toolKey: string;
  label: string;
  description?: string;
  icon: React.ComponentType<{ className?: string }>;
  /** GET endpoint path beneath /api/admin (e.g. "maintenance/journal-pending"). */
  checkEndpoint: string;
  /** Optional POST endpoint for the fix action. Omit for read-only checkers. */
  fixEndpoint?: string;
  /** Required when fix is destructive (delete / deactivate). */
  destructive?: boolean;
  /** Confirmation copy shown in AlertDialog. */
  confirmTitle?: string;
  confirmDescription?: (count: number) => string;
  /** Builds the POST body. Receives selected ids when caller passes them. */
  buildFixBody?: (companyId: number, selectedIds: Array<string | number>) => Record<string, any>;
  /** Optional list of additional fix actions (for split-action tools). */
  fixActions?: Array<{
    key: string;
    label: string;
    destructive?: boolean;
    confirmTitle?: string;
    confirmDescription?: (count: number) => string;
    buildBody: (companyId: number, selectedIds: Array<string | number>) => Record<string, any>;
  }>;
  /** Inline detail panel renderer (no Dialog). */
  renderDetails?: DetailRenderer;
  /** Optional CTA shown instead of fix buttons (e.g. external link). */
  externalCta?: { label: string; href: string };
  companyId: number | null;
  /** Notifies the parent that a fix completed so it can refresh siblings. */
  onFixed?: () => void;
  /** Latest scheduled/manual scan result for this tool — drives the badge. */
  latestScan?: {
    status: "ok" | "warn" | "critical" | "error";
    count: number;
    runAt: string;
    trigger: "scheduled" | "manual";
  } | null;
  /**
   * Optional 14-day trend (one entry per KSA day with data) used to render a
   * compact sparkline below the "آخر فحص" line so SuperAdmins can spot
   * recurring issues. Days without a run are simply omitted by the server.
   */
  trend?: {
    days: number;
    points: Array<{
      day: string;        // "YYYY-MM-DD" (Asia/Riyadh)
      count: number;
      status: "ok" | "warn" | "critical" | "error";
    }>;
  } | null;
  /**
   * When provided, the card surfaces a "retention (days)" editor (input +
   * Save button). The persisted value is fetched from
   * /api/admin/maintenance/retention-settings and used as the default for
   * BOTH the GET preview (`?days=…`) and the POST fix body. Falls back to
   * `defaultDays` (= the original UI hardcode) until the fetch resolves so
   * the first render matches pre-task behaviour.
   *
   * The label / description copy is NOT rendered here so each card can keep
   * its existing wording — this prop is purely the editor + plumbing.
   */
  retentionConfig?: {
    defaultDays: number;
    min: number;
    max: number;
  };
  /**
   * When supplied, the per-day drill-down panel renders an extra "view full
   * tool history" button in its header so SuperAdmins can jump from a single
   * trend bar to the broader (last 20 runs) modal owned by the parent.
   * Receives this card's toolKey so the parent can re-use one handler across
   * every card. Passing `undefined` (default) hides the button entirely.
   */
  onShowToolHistory?: (toolKey: string) => void;
};

export default function MaintenanceTool(props: MaintenanceToolProps) {
  const {
    toolKey, label, description, icon: Icon, checkEndpoint, fixEndpoint,
    destructive, confirmTitle, confirmDescription, buildFixBody, fixActions,
    renderDetails, externalCta, companyId, onFixed, latestScan, trend,
    retentionConfig, onShowToolHistory,
  } = props;
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [open, setOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Array<string | number>>([]);
  const [pendingAction, setPendingAction] = useState<null | { key: string; body: any; destructive?: boolean; title?: string; desc?: string }>(null);
  // Sparkline drill-down: which (KSA-day) bar is currently expanded. Null
  // when no day is selected. Clicking the same day again collapses it.
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  // Reset the drill-down when the company changes — a day from one tenant
  // is meaningless for another.
  useEffect(() => { setSelectedDay(null); }, [companyId]);

  // Per-day run list, fetched on demand. Disabled until a bar is clicked so
  // the request only fires when the panel is actually visible.
  const dayRunsQ = useQuery({
    queryKey: ["maintenance-tool-runs", toolKey, companyId, selectedDay],
    queryFn: async () => {
      const r = await fetch(
        `${API}/api/admin/maintenance/runs?companyId=${companyId}&toolKey=${encodeURIComponent(toolKey)}&day=${selectedDay}`,
        { headers },
      );
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "فشل جلب تفاصيل اليوم");
      return r.json() as Promise<{
        companyId: number; toolKey: string; day: string;
        items: Array<{
          id: number;
          runAt: string;
          trigger: "scheduled" | "manual";
          status: "ok" | "warn" | "critical" | "error";
          count: number;
          durationMs: number;
          error: string | null;
          details: any;
        }>;
      }>;
    },
    enabled: !!companyId && !!selectedDay,
    refetchOnWindowFocus: false,
  });

  // ─── Retention settings (only when retentionConfig is supplied) ──────────
  // Shared across every retention-aware card so a single GET hydrates them
  // all. The response is a map keyed by toolKey.
  const retentionQ = useQuery({
    queryKey: ["maintenance-retention-settings"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/maintenance/retention-settings`, { headers });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "فشل قراءة إعدادات الاحتفاظ");
      return r.json() as Promise<{
        settings: Record<string, {
          days: number; defaultDays: number; min: number; max: number;
          persisted: boolean; updatedAt: string | null;
        }>;
      }>;
    },
    enabled: !!retentionConfig,
    refetchOnWindowFocus: false,
    staleTime: 5 * 60 * 1000,
  });
  const persistedRetention = retentionQ.data?.settings?.[toolKey];
  // Effective retention: persisted value when loaded, otherwise the static
  // default. Used by BOTH the GET preview URL and the POST fix body so the
  // operator's saved value wins everywhere — including the CSV export.
  const effectiveDays = retentionConfig
    ? (persistedRetention?.days ?? retentionConfig.defaultDays)
    : null;
  // Draft (unsaved) value held in the input. Resets to null when the
  // persisted value changes (e.g. after a save round-trips).
  const [draftDays, setDraftDays] = useState<string>("");
  useEffect(() => {
    if (effectiveDays != null) setDraftDays(String(effectiveDays));
  }, [effectiveDays]);

  const saveRetentionMut = useMutation({
    mutationFn: async (days: number) => {
      const r = await fetch(`${API}/api/admin/maintenance/retention-settings/${encodeURIComponent(toolKey)}`, {
        method: "PUT", headers, body: JSON.stringify({ days }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "فشل حفظ مدة الاحتفاظ");
      return r.json() as Promise<{ ok: boolean; toolKey: string; days: number }>;
    },
    onSuccess: () => {
      toast({ title: "تم حفظ مدة الاحتفاظ" });
      qc.invalidateQueries({ queryKey: ["maintenance-retention-settings"] });
      qc.invalidateQueries({ queryKey: ["maintenance-tool", toolKey, companyId] });
      qc.invalidateQueries({ queryKey: ["maintenance-history"] });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // Build the URL query string used by both the JSON check and the CSV
  // export. When a retention is configured, anchor on the effective value so
  // the preview / count matches what the fix action will actually delete.
  const checkUrlQuery = (extra: Record<string, string> = {}) => {
    const params = new URLSearchParams({ companyId: String(companyId ?? "") });
    if (retentionConfig && effectiveDays != null) params.set("days", String(effectiveDays));
    for (const [k, v] of Object.entries(extra)) params.set(k, v);
    return params.toString();
  };

  // queryKey includes effectiveDays so changing the retention triggers an
  // automatic re-fetch (keeps the on-screen count in sync with the saved
  // value without forcing the operator to click "فحص").
  const queryKey = ["maintenance-tool", toolKey, companyId, effectiveDays];
  const checkQ = useQuery({
    queryKey,
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/${checkEndpoint}?${checkUrlQuery()}`, { headers });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "فشل الفحص");
      return r.json() as Promise<{ count: number; items?: any[]; [k: string]: any }>;
    },
    enabled: !!companyId && (!retentionConfig || effectiveDays != null),
    refetchOnWindowFocus: false,
  });

  const fixMut = useMutation({
    mutationFn: async ({ endpoint, body }: { endpoint: string; body: any }) => {
      const r = await fetch(`${API}/api/admin/${endpoint}`, {
        method: "POST", headers, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "فشل التنفيذ");
      return r.json();
    },
    onSuccess: (data) => {
      toast({
        title: "تم التنفيذ",
        description: `تمت معالجة ${data.processed ?? 0} عنصر${data.skipped ? ` (تم تخطي ${data.skipped})` : ""}.`,
      });
      setSelectedIds([]);
      qc.invalidateQueries({ queryKey });
      qc.invalidateQueries({ queryKey: ["maintenance-history"] });
      onFixed?.();
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // CSV export — calls the same check endpoint with `?format=csv`. The server
  // streams a UTF-8 BOM CSV with Arabic headers and writes a maintenance
  // audit-log row so the export action shows up in "سجل الإصلاحات".
  const csvMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/${checkEndpoint}?${checkUrlQuery({ format: "csv" })}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        const msg = await r.json().catch(() => ({} as any));
        throw new Error(msg?.error || "فشل تصدير الملف");
      }
      const blob = await r.blob();
      // Pull filename from Content-Disposition (server sets it per-tool with
      // companyId + timestamp). Falls back to <toolKey>.csv if header missing.
      const cd = r.headers.get("Content-Disposition") ?? "";
      const m = cd.match(/filename="?([^";]+)"?/i);
      const filename = m?.[1] ? decodeURIComponent(m[1]) : `${toolKey}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    onSuccess: () => {
      toast({ title: "تم تنزيل ملف CSV" });
      // Refresh the "سجل الإصلاحات" panel so the export entry shows up.
      qc.invalidateQueries({ queryKey: ["maintenance-history"] });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const toggle = (id: string | number) => setSelectedIds((cur) =>
    cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]
  );
  const toggleAll = (ids: Array<string | number>) => setSelectedIds((cur) =>
    cur.length === ids.length ? [] : [...ids]
  );

  const count = checkQ.data?.count ?? 0;
  const status: "ok" | "warn" | "critical" = count === 0 ? "ok" : count >= 50 ? "critical" : "warn";
  const STATUS = {
    ok:       { bg: "bg-green-100",  text: "text-green-800",  border: "border-green-200",  icon: CheckCircle2, label: "سليم" },
    warn:     { bg: "bg-amber-100",  text: "text-amber-900",  border: "border-amber-200",  icon: AlertTriangle, label: `موجود ${count}` },
    critical: { bg: "bg-red-100",    text: "text-red-800",    border: "border-red-200",    icon: AlertCircle,   label: `حرج ${count}+` },
  }[status];

  const StatusIcon = STATUS.icon;
  const data = checkQ.data;
  const ready = !!companyId && !checkQ.isFetching;

  // Build a defaulted "primary" fix action when caller passed `fixEndpoint`.
  const primaryAction = fixEndpoint && buildFixBody ? {
    key: "primary",
    label: destructive ? "إصلاح / حذف" : "إصلاح",
    destructive: destructive,
    confirmTitle: confirmTitle ?? "تأكيد التنفيذ",
    confirmDescription: confirmDescription ?? ((n: number) => `سيتم تنفيذ هذا الإجراء على ${n} عنصر. هل تريد المتابعة؟`),
    buildBody: buildFixBody,
  } : null;
  const allActions = [
    ...(primaryAction ? [primaryAction] : []),
    ...(fixActions ?? []),
  ];

  const triggerFix = (action: typeof allActions[number]) => {
    if (!companyId) return;
    const targetIds = selectedIds.length > 0 ? selectedIds : (data?.items ?? []).map((it: any) => it.id ?? it.sequenceId ?? it.accountId).filter((v: any) => v != null);
    const body = action.buildBody(companyId, targetIds);
    // Inject the saved retention into the POST body so the prune always
    // honors the persisted value — even if the parent's buildFixBody still
    // hardcodes a default. Server re-validates regardless.
    if (retentionConfig && effectiveDays != null) body.days = effectiveDays;
    setPendingAction({
      key: `${toolKey}:${action.key}`,
      body,
      destructive: action.destructive,
      title: action.confirmTitle,
      desc: action.confirmDescription?.(targetIds.length),
    });
  };

  const confirm = () => {
    if (!pendingAction || !fixEndpoint) { setPendingAction(null); return; }
    // Use the action-specific endpoint if it's the same fixEndpoint, otherwise
    // stay on the configured one (all actions in this toolbox post to same path).
    fixMut.mutate({ endpoint: fixEndpoint, body: pendingAction.body });
    setPendingAction(null);
  };

  return (
    <Card className={`${STATUS.border} ${count > 0 ? "shadow-sm" : ""}`}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 min-w-0">
            <Icon className="h-4 w-4 shrink-0 text-violet-700" />
            <span className="truncate">{label}</span>
          </span>
          <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full ${STATUS.bg} ${STATUS.text}`}>
            <StatusIcon className="h-3 w-3" />
            {checkQ.isFetching ? "جارٍ..." : STATUS.label}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-1 space-y-2">
        {description && <p className="text-[11px] text-muted-foreground leading-5">{description}</p>}
        {latestScan && (() => {
          const tone =
            latestScan.status === "critical" ? "text-red-700"   :
            latestScan.status === "warn"     ? "text-amber-800" :
            latestScan.status === "error"    ? "text-rose-700"  :
                                               "text-emerald-700";
          const when = (() => {
            const diffMs = Date.now() - new Date(latestScan.runAt).getTime();
            const mins = Math.round(diffMs / 60_000);
            if (mins < 60)         return `قبل ${mins} دقيقة`;
            const hrs = Math.round(mins / 60);
            if (hrs < 24)          return `قبل ${hrs} ساعة`;
            const days = Math.round(hrs / 24);
            return `قبل ${days} يوم`;
          })();
          const label =
            latestScan.status === "ok"       ? "سليم" :
            latestScan.status === "warn"     ? `موجود ${latestScan.count}` :
            latestScan.status === "critical" ? `حرج ${latestScan.count}` :
                                               "خطأ";
          return (
            <p className={`text-[11px] flex items-center gap-1 ${tone}`}
               title={new Date(latestScan.runAt).toLocaleString("ar-SA")}>
              <Clock className="h-3 w-3" />
              <span>آخر فحص {latestScan.trigger === "manual" ? "يدوي" : "تلقائي"}: {label} — {when}</span>
            </p>
          );
        })()}
        {trend && (
          <Sparkline
            days={trend.days}
            points={trend.points}
            selectedDay={selectedDay}
            onSelectDay={(day) => setSelectedDay((cur) => (cur === day ? null : day))}
          />
        )}
        {selectedDay && (
          <DayRunsPanel
            day={selectedDay}
            isFetching={dayRunsQ.isFetching}
            isError={dayRunsQ.isError}
            errorMessage={(dayRunsQ.error as any)?.message}
            items={dayRunsQ.data?.items ?? []}
            onClose={() => setSelectedDay(null)}
            // Surfaces the broader (last 20 runs) tool-history modal alongside
            // the per-day list so a SuperAdmin who clicked a single trend bar
            // can pivot to the full history without leaving the card.
            onShowToolHistory={
              onShowToolHistory ? () => onShowToolHistory(toolKey) : undefined
            }
          />
        )}
        {checkQ.isError && (
          <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-1.5">
            {(checkQ.error as any)?.message || "فشل الفحص"}
          </p>
        )}
        {retentionConfig && (() => {
          const draftNum = Number(draftDays);
          const draftValid = Number.isFinite(draftNum)
            && Math.floor(draftNum) === draftNum
            && draftNum >= retentionConfig.min
            && draftNum <= retentionConfig.max;
          const dirty = effectiveDays != null && draftValid && draftNum !== effectiveDays;
          const isCustom = !!persistedRetention?.persisted;
          return (
            <div className="rounded border border-violet-100 bg-violet-50/40 p-2 space-y-1">
              <div className="flex items-center gap-1.5 text-[11px] text-violet-900">
                <CalendarClock className="h-3 w-3" />
                <span className="font-medium">مدة الاحتفاظ (بالأيام)</span>
                <span className="text-muted-foreground">
                  — السجلات الأقدم تُحذف عند تشغيل الإصلاح. الافتراضي {retentionConfig.defaultDays}.
                </span>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <Input
                  type="number"
                  min={retentionConfig.min}
                  max={retentionConfig.max}
                  step={1}
                  value={draftDays}
                  onChange={(e) => setDraftDays(e.target.value)}
                  disabled={retentionQ.isFetching || saveRetentionMut.isPending}
                  className="h-7 w-24 text-xs tabular-nums"
                  aria-label={`مدة الاحتفاظ لـ ${label}`}
                />
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  ({retentionConfig.min}–{retentionConfig.max})
                </span>
                <Button
                  size="sm" variant="outline" className="h-7 text-xs gap-1"
                  onClick={() => saveRetentionMut.mutate(Math.floor(draftNum))}
                  disabled={!draftValid || !dirty || saveRetentionMut.isPending}
                  title={
                    !draftValid
                      ? `الرجاء إدخال رقم صحيح بين ${retentionConfig.min} و ${retentionConfig.max}`
                      : !dirty
                        ? "لم يتغيّر شيء"
                        : "حفظ مدة الاحتفاظ"
                  }
                >
                  {saveRetentionMut.isPending
                    ? <Loader2 className="h-3 w-3 animate-spin" />
                    : <Save className="h-3 w-3" />}
                  حفظ
                </Button>
                {isCustom && effectiveDays !== retentionConfig.defaultDays && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-800 border border-violet-200">
                    مخصّص
                  </span>
                )}
                {retentionQ.isFetching && (
                  <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                )}
              </div>
            </div>
          );
        })()}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm" variant="outline" className="h-7 text-xs gap-1"
            onClick={() => checkQ.refetch()}
            disabled={!companyId || checkQ.isFetching}
          >
            {checkQ.isFetching ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            فحص
          </Button>
          {renderDetails && data && (
            <Button
              size="sm" variant="ghost" className="h-7 text-xs gap-1"
              onClick={() => setOpen(o => !o)}
              disabled={count === 0}
            >
              {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              {open ? "إخفاء التفاصيل" : "عرض التفاصيل"}
            </Button>
          )}
          {renderDetails && data && (
            <Button
              size="sm" variant="ghost" className="h-7 text-xs gap-1"
              onClick={() => csvMut.mutate()}
              disabled={count === 0 || csvMut.isPending || !companyId}
              title="تنزيل القائمة الكاملة كملف CSV"
            >
              {csvMut.isPending
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : <Download className="h-3 w-3" />}
              تصدير CSV
            </Button>
          )}
          {externalCta && (
            <Button asChild size="sm" variant="outline" className="h-7 text-xs">
              <a href={externalCta.href}>{externalCta.label}</a>
            </Button>
          )}
          {ready && count > 0 && allActions.map((action) => (
            <Button
              key={action.key} size="sm"
              variant={action.destructive ? "destructive" : "default"}
              className={`h-7 text-xs gap-1 ${action.destructive ? "" : "bg-violet-600 hover:bg-violet-700"}`}
              onClick={() => triggerFix(action)}
              disabled={fixMut.isPending}
            >
              {fixMut.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
              {action.label}
              {selectedIds.length > 0 && ` (${selectedIds.length})`}
            </Button>
          ))}
        </div>
        {open && renderDetails && data && (
          <div className="mt-2 border-t pt-2">
            {renderDetails({
              data,
              selectedIds,
              toggle,
              toggleAll,
              allSelected: selectedIds.length > 0 && selectedIds.length === (data.items?.length ?? 0),
            })}
          </div>
        )}
      </CardContent>

      <AlertDialog open={!!pendingAction} onOpenChange={(o) => !o && setPendingAction(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingAction?.title ?? "تأكيد التنفيذ"}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAction?.desc ?? "هل أنت متأكد من تنفيذ هذا الإجراء؟"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirm}
              className={pendingAction?.destructive ? "bg-red-600 hover:bg-red-700 focus:ring-red-600" : ""}
            >
              تأكيد
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// ─── Sparkline ───────────────────────────────────────────────────────────────
// Compact mini bar-chart: one bar per KSA day in the requested window. Days
// without a run are rendered as faint placeholders so the chart width stays
// stable when results are sparse. Bar height encodes the issue count
// (log-scaled so a single 500-row outlier doesn't flatten the rest), color
// encodes the worst status of the day. Hover shows the exact day + count.
//
// When `onSelectDay` is supplied, days that actually had a run become
// clickable buttons so SuperAdmins can drill into the underlying runs for
// that day. The currently-selected bar is outlined.
function Sparkline(props: {
  days: number;
  points: Array<{ day: string; count: number; status: "ok" | "warn" | "critical" | "error" }>;
  selectedDay?: string | null;
  onSelectDay?: (day: string) => void;
}) {
  const { days, points, selectedDay, onSelectDay } = props;
  // Build the full day window (oldest → newest) so missing days appear as
  // empty slots. We work in Asia/Riyadh-style YYYY-MM-DD strings.
  const today = new Date();
  // Anchor to UTC midnight of "today" — the server already grouped by KSA day
  // and labels are simple strings, so a naive walk-back is good enough here.
  const window: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    window.push(d.toISOString().slice(0, 10));
  }
  const byDay = new Map(points.map(p => [p.day, p]));
  const max = Math.max(1, ...points.map(p => p.count));
  // Log-ish scale so one giant day doesn't flatten the rest.
  const scale = (n: number) => (n <= 0 ? 0 : Math.max(0.12, Math.log10(1 + n) / Math.log10(1 + max)));
  const COLOR: Record<string, string> = {
    ok:       "bg-emerald-400",
    warn:     "bg-amber-400",
    critical: "bg-red-500",
    error:    "bg-rose-500",
  };
  const nonZero = points.filter(p => p.count > 0).length;
  return (
    <div className="flex items-end gap-[2px] h-7" role="img"
         aria-label={`اتجاه آخر ${days} يوم — ${nonZero} يوم بنتائج`}
         title={`اتجاه آخر ${days} يوم — ${nonZero} يوم بنتائج`}>
      {window.map((day) => {
        const p = byDay.get(day);
        const h = p ? `${Math.round(scale(p.count) * 100)}%` : "8%";
        const cls = p ? COLOR[p.status] ?? "bg-slate-300" : "bg-slate-200";
        const lbl = p
          ? `${day} — ${p.status === "ok" ? "سليم" : p.count}`
          : `${day} — لا فحص`;
        // Bars without data are inert placeholders; bars with data become
        // clickable when the parent supplied an `onSelectDay` handler.
        const interactive = !!p && !!onSelectDay;
        const isSelected = !!p && selectedDay === day;
        const wrapperBase = "flex-1 min-w-[3px] bg-muted/40 rounded-sm overflow-hidden flex items-end";
        const wrapperCls = isSelected
          ? `${wrapperBase} ring-2 ring-violet-500 ring-offset-1 ring-offset-background`
          : wrapperBase;
        if (interactive) {
          return (
            <button key={day} type="button"
                    className={`${wrapperCls} cursor-pointer hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-violet-500`}
                    title={`${lbl} — اضغط لعرض التشغيلات`}
                    aria-pressed={isSelected}
                    aria-label={`${lbl} — عرض تفاصيل التشغيلات`}
                    onClick={() => onSelectDay?.(day)}>
              <div className={`w-full rounded-sm ${cls}`} style={{ height: h }} />
            </button>
          );
        }
        return (
          <div key={day} className={wrapperCls} title={lbl}>
            <div className={`w-full rounded-sm ${cls}`} style={{ height: h }} />
          </div>
        );
      })}
    </div>
  );
}

// ─── DayRunsPanel ────────────────────────────────────────────────────────────
// Inline drill-down panel: shows up to 50 maintenance_runs rows for the
// (tool, KSA-day) bar the operator just clicked. Mirrors the existing
// "details" panel pattern (border-t separator, compact rows, RTL-friendly).
function DayRunsPanel(props: {
  day: string;
  isFetching: boolean;
  isError: boolean;
  errorMessage?: string;
  items: Array<{
    id: number;
    runAt: string;
    trigger: "scheduled" | "manual";
    status: "ok" | "warn" | "critical" | "error";
    count: number;
    durationMs: number;
    error: string | null;
    details: any;
  }>;
  onClose: () => void;
  /** When set, renders a "view full tool history" button in the header. */
  onShowToolHistory?: () => void;
}) {
  const { day, isFetching, isError, errorMessage, items, onClose, onShowToolHistory } = props;
  const STATUS_BADGE: Record<string, string> = {
    ok:       "bg-emerald-100 text-emerald-800 border border-emerald-200",
    warn:     "bg-amber-100   text-amber-900   border border-amber-200",
    critical: "bg-red-100     text-red-800     border border-red-200",
    error:    "bg-rose-100    text-rose-800    border border-rose-200",
  };
  const STATUS_LBL: Record<string, string> = {
    ok: "سليم", warn: "تحذير", critical: "حرج", error: "خطأ",
  };
  const TRIGGER_LBL: Record<string, string> = {
    scheduled: "تلقائي", manual: "يدوي",
  };
  return (
    <div className="mt-2 border-t pt-2 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium text-violet-900">
          تشغيلات يوم {day} {items.length > 0 && (
            <span className="text-muted-foreground font-normal">({items.length})</span>
          )}
        </p>
        <div className="flex items-center gap-1">
          {onShowToolHistory && (
            <Button
              size="sm" variant="outline"
              className="h-6 text-[11px] px-2 gap-1"
              onClick={onShowToolHistory}
              title="عرض آخر 20 تشغيلاً لهذه الأداة"
            >
              <History className="h-3 w-3" />
              سجل الأداة
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-6 text-[11px] px-2" onClick={onClose}>
            إغلاق
          </Button>
        </div>
      </div>
      {isFetching && (
        <p className="text-[11px] text-muted-foreground flex items-center gap-1">
          <Loader2 className="h-3 w-3 animate-spin" />
          جارٍ التحميل...
        </p>
      )}
      {isError && !isFetching && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-1.5">
          {errorMessage || "فشل جلب تفاصيل اليوم"}
        </p>
      )}
      {!isFetching && !isError && items.length === 0 && (
        <p className="text-[11px] text-muted-foreground">
          لا توجد تشغيلات مسجّلة لهذا اليوم.
        </p>
      )}
      {!isFetching && !isError && items.length > 0 && (
        <div className="overflow-x-auto rounded border border-violet-100">
          <table className="w-full text-[11px]">
            <thead className="bg-violet-50/60 text-violet-900">
              <tr>
                <th className="text-right px-2 py-1 font-medium whitespace-nowrap">الوقت</th>
                <th className="text-right px-2 py-1 font-medium whitespace-nowrap">المُشغِّل</th>
                <th className="text-right px-2 py-1 font-medium whitespace-nowrap">الحالة</th>
                <th className="text-right px-2 py-1 font-medium whitespace-nowrap">العدد</th>
                <th className="text-right px-2 py-1 font-medium whitespace-nowrap">المدة</th>
                <th className="text-right px-2 py-1 font-medium">تفاصيل</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => {
                const time = (() => {
                  try {
                    return new Date(row.runAt).toLocaleTimeString("ar-SA", {
                      hour: "2-digit", minute: "2-digit", second: "2-digit",
                      timeZone: "Asia/Riyadh",
                    });
                  } catch { return row.runAt; }
                })();
                // Error and details can coexist (a check that partially failed
                // may surface both an error message *and* the partial findings
                // in `details`). Render them stacked so operators don't lose
                // half the context.
                const detailsJson = row.details != null
                  ? (() => { try { return JSON.stringify(row.details); } catch { return String(row.details); } })()
                  : "";
                const hasError = !!row.error;
                const hasDetails = detailsJson.length > 0;
                return (
                  <tr key={row.id} className="border-t border-violet-100 align-top">
                    <td className="px-2 py-1 whitespace-nowrap font-mono">{time}</td>
                    <td className="px-2 py-1 whitespace-nowrap">{TRIGGER_LBL[row.trigger] ?? row.trigger}</td>
                    <td className="px-2 py-1 whitespace-nowrap">
                      <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] ${STATUS_BADGE[row.status] ?? ""}`}>
                        {STATUS_LBL[row.status] ?? row.status}
                      </span>
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap tabular-nums">{row.count}</td>
                    <td className="px-2 py-1 whitespace-nowrap tabular-nums text-muted-foreground">
                      {row.durationMs} مث
                    </td>
                    <td className="px-2 py-1 space-y-1">
                      {hasError && (
                        <code className="block max-w-[28rem] truncate font-mono text-[10px] text-rose-700"
                              title={row.error!}>
                          {row.error}
                        </code>
                      )}
                      {hasDetails && (
                        <code className="block max-w-[28rem] truncate font-mono text-[10px] text-muted-foreground"
                              title={detailsJson}>
                          {detailsJson}
                        </code>
                      )}
                      {!hasError && !hasDetails && (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
