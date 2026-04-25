import { useState } from "react";
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
  AlertTriangle, AlertCircle, Clock,
} from "lucide-react";

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
};

export default function MaintenanceTool(props: MaintenanceToolProps) {
  const {
    toolKey, label, description, icon: Icon, checkEndpoint, fixEndpoint,
    destructive, confirmTitle, confirmDescription, buildFixBody, fixActions,
    renderDetails, externalCta, companyId, onFixed, latestScan,
  } = props;
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [open, setOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Array<string | number>>([]);
  const [pendingAction, setPendingAction] = useState<null | { key: string; body: any; destructive?: boolean; title?: string; desc?: string }>(null);

  const queryKey = ["maintenance-tool", toolKey, companyId];
  const checkQ = useQuery({
    queryKey,
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/${checkEndpoint}?companyId=${companyId}`, { headers });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "فشل الفحص");
      return r.json() as Promise<{ count: number; items?: any[]; [k: string]: any }>;
    },
    enabled: !!companyId,
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
        {checkQ.isError && (
          <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-1.5">
            {(checkQ.error as any)?.message || "فشل الفحص"}
          </p>
        )}
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
