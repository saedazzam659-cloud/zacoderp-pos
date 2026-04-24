import { useState, useMemo, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import {
  HardDrive, Search, RefreshCw, CheckCircle2, AlertTriangle, XCircle,
  ChevronDown, ChevronUp, PlayCircle, Download, Trash2, Settings as SettingsIcon,
  Database, Activity, Zap, Calendar, Clock,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─── Types matching the /api/admin/backups/overview payload ──────────────
interface OverviewLatest {
  id: number;
  createdAt: string;
  reason: string;
  sizeBytes: number;
  counts: Record<string, number> | null;
}
interface OverviewRow {
  id: number;
  nameAr: string;
  vatNumber: string;
  status: string;
  autoBackupEnabled: boolean;
  autoBackupFrequencyHours: number;
  autoBackupRetention: number;
  lastAutoBackupAt: string | null;
  snapshotsLast30d: number;
  totalSizeBytes30d: number;
  latest: OverviewLatest | null;
  bucket: "green" | "amber" | "red" | "disabled";
  ageHours: number | null;
}
interface OverviewKpis {
  total: number; green: number; amber: number; red: number; disabled: number;
  snapshots30d: number; totalSize30d: number; totalSizeAll: number; missing: number;
}
interface OverviewResponse {
  kpis: OverviewKpis;
  rows: OverviewRow[];
  generatedAt: string;
}

interface SnapshotMeta {
  id: number;
  createdAt: string;
  reason: string;
  sizeBytes: number;
  counts: Record<string, number> | null;
}

interface BulkRunItem {
  companyId: number;
  companyName: string;
  status: "pending" | "running" | "ok" | "error";
  snapshotId?: number;
  error?: string;
}
interface BulkRunJob {
  id: string;
  total: number;
  completed: number;
  failed: number;
  items: BulkRunItem[];
  status: "running" | "done";
  startedAt: number;
  finishedAt?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────
function formatBytes(n: number): string {
  if (n === 0) return "0 B";
  const k = 1024;
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(k)));
  return `${(n / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
function formatAge(hours: number | null): string {
  if (hours == null) return "—";
  if (hours < 1) return `${Math.round(hours * 60)} د`;
  if (hours < 24) return `${Math.round(hours)} س`;
  return `${Math.round(hours / 24)} يوم`;
}
function formatDate(iso?: string | null): string {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString("ar-SA", { dateStyle: "short", timeStyle: "short" }); }
  catch { return iso; }
}

// ─── UI atoms ────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, icon: Icon, iconBg, iconColor, border }: {
  label: string; value: string | number; sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  iconBg: string; iconColor: string; border?: string;
}) {
  return (
    <div className={cn("rounded-xl border bg-card p-4 flex items-center gap-3", border)}>
      <div className={cn("h-10 w-10 rounded-lg flex items-center justify-center shrink-0", iconBg)}>
        <Icon className={cn("h-5 w-5", iconColor)} />
      </div>
      <div className="min-w-0">
        <p className="text-2xl font-bold tabular-nums">{value ?? "—"}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
        {sub && <p className="text-[11px] text-muted-foreground/70 mt-0.5 truncate">{sub}</p>}
      </div>
    </div>
  );
}

function BucketBadge({ bucket, ageHours }: { bucket: OverviewRow["bucket"]; ageHours: number | null }) {
  if (bucket === "disabled") return (
    <span className="inline-flex items-center gap-1 text-xs border rounded-full px-2 py-0.5 font-medium w-fit bg-zinc-100 text-zinc-700 border-zinc-300">
      <XCircle className="h-3 w-3" />معطّل
    </span>
  );
  if (bucket === "red") return (
    <span className="inline-flex items-center gap-1 text-xs border rounded-full px-2 py-0.5 font-medium w-fit bg-red-50 text-red-700 border-red-200">
      <AlertTriangle className="h-3 w-3" />
      {ageHours == null ? "بدون نسخ" : `متأخّر ${formatAge(ageHours)}`}
    </span>
  );
  if (bucket === "amber") return (
    <span className="inline-flex items-center gap-1 text-xs border rounded-full px-2 py-0.5 font-medium w-fit bg-amber-50 text-amber-800 border-amber-200">
      <Clock className="h-3 w-3" />متأخّر بسيط · {formatAge(ageHours)}
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 text-xs border rounded-full px-2 py-0.5 font-medium w-fit bg-green-50 text-green-700 border-green-200">
      <CheckCircle2 className="h-3 w-3" />نشط · {formatAge(ageHours)}
    </span>
  );
}

const BUCKET_TABS = [
  { key: "all",      label: "الكل" },
  { key: "green",    label: "نشطة" },
  { key: "amber",    label: "متأخّر بسيط" },
  { key: "red",      label: "متأخّر / مفقود" },
  { key: "disabled", label: "معطّل" },
] as const;
type BucketTab = typeof BUCKET_TABS[number]["key"];

// ─── Page ────────────────────────────────────────────────────────────────
export default function BackupOperations() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const headers = useMemo(
    () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" }),
    [token],
  );

  const [search, setSearch]           = useState("");
  const [tab, setTab]                 = useState<BucketTab>("all");
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  // Per-row settings draft (so user edits are local until "save")
  const [settingsDraft, setSettingsDraft] = useState<Record<number, {
    enabled: boolean; frequencyHours: number; retention: number;
  }>>({});
  // Bulk run job tracking
  const [bulkJobId, setBulkJobId] = useState<string | null>(null);
  const [bulkScope, setBulkScope] = useState<"enabled" | "all">("enabled");

  // ── Overview query ───────────────────────────────────────────────────
  const { data, isLoading, refetch } = useQuery<OverviewResponse>({
    queryKey: ["admin-backups-overview"],
    queryFn: async () => {
      const res = await fetch(`${API}/api/admin/backups/overview`, { headers });
      if (!res.ok) throw new Error("فشل تحميل البيانات");
      return res.json();
    },
    refetchInterval: 30_000,
  });
  const rows = data?.rows ?? [];
  const k = data?.kpis;

  // ── Per-company history (only when a row is expanded) ───────────────
  const { data: historyData, isFetching: historyLoading } = useQuery<{ snapshots: SnapshotMeta[] }>({
    queryKey: ["admin-backups-history", expandedRow],
    enabled: expandedRow != null,
    queryFn: async () => {
      const res = await fetch(`${API}/api/admin/backups/auto/list/${expandedRow}`, { headers });
      if (!res.ok) throw new Error("فشل تحميل السجل");
      return res.json();
    },
  });

  // ── Bulk run polling ────────────────────────────────────────────────
  const { data: bulkJob } = useQuery<BulkRunJob>({
    queryKey: ["admin-backups-bulk", bulkJobId],
    enabled: !!bulkJobId,
    queryFn: async () => {
      const res = await fetch(`${API}/api/admin/backups/run-all/${bulkJobId}`, { headers });
      if (!res.ok) throw new Error("المهمة غير موجودة");
      return res.json();
    },
    refetchInterval: (q) => (q.state.data?.status === "running" ? 1500 : false),
  });
  // When bulk job finishes, refresh overview + clear after a brief delay so
  // the user can still see the final results panel.
  useEffect(() => {
    if (bulkJob?.status === "done") {
      qc.invalidateQueries({ queryKey: ["admin-backups-overview"] });
      toast({
        title: bulkJob.failed > 0
          ? `✓ ${bulkJob.completed} نسخة • ⚠ ${bulkJob.failed} فشل`
          : `✓ تم أخذ ${bulkJob.completed} نسخة بنجاح`,
        variant: bulkJob.failed > 0 ? "destructive" : undefined,
      });
    }
  }, [bulkJob?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mutations ───────────────────────────────────────────────────────
  const saveSettingsMutation = useMutation({
    mutationFn: async ({ companyId, body }: { companyId: number; body: { enabled?: boolean; frequencyHours?: number; retention?: number } }) => {
      const res = await fetch(`${API}/api/admin/backups/auto/settings/${companyId}`, {
        method: "POST", headers, body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "فشل الحفظ");
      return j;
    },
    onSuccess: () => {
      toast({ title: "✓ تم حفظ الإعدادات" });
      qc.invalidateQueries({ queryKey: ["admin-backups-overview"] });
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  const runNowMutation = useMutation({
    mutationFn: async (companyId: number) => {
      const res = await fetch(`${API}/api/admin/backups/run-now/${companyId}`, {
        method: "POST", headers,
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "فشل أخذ النسخة");
      return j;
    },
    onSuccess: (_, cid) => {
      toast({ title: "✓ تم أخذ النسخة" });
      qc.invalidateQueries({ queryKey: ["admin-backups-overview"] });
      qc.invalidateQueries({ queryKey: ["admin-backups-history", cid] });
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteSnapshotMutation = useMutation({
    mutationFn: async ({ snapshotId }: { snapshotId: number; companyId: number }) => {
      const res = await fetch(`${API}/api/admin/backups/auto/${snapshotId}`, {
        method: "DELETE", headers,
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "فشل الحذف");
      return j;
    },
    onSuccess: (_, vars) => {
      toast({ title: "✓ تم حذف النسخة" });
      qc.invalidateQueries({ queryKey: ["admin-backups-overview"] });
      qc.invalidateQueries({ queryKey: ["admin-backups-history", vars.companyId] });
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  const startBulkMutation = useMutation({
    mutationFn: async (scope: "enabled" | "all") => {
      const res = await fetch(`${API}/api/admin/backups/run-all`, {
        method: "POST", headers, body: JSON.stringify({ scope }),
      });
      const j = await res.json();
      if (!res.ok) {
        // 409 = already running; surface the running jobId so polling resumes.
        if (res.status === 409 && j.runningJobId) {
          setBulkJobId(j.runningJobId);
        }
        throw new Error(j.error ?? "فشل بدء التشغيل");
      }
      return j;
    },
    onSuccess: (data: { jobId: string; total: number }) => {
      setBulkJobId(data.jobId);
      toast({ title: `بدأ تشغيل ${data.total} شركة...` });
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  // ── Filtering ───────────────────────────────────────────────────────
  const filtered = useMemo(() => rows.filter(r => {
    const q = search.trim();
    const matchSearch = q === "" || r.nameAr.includes(q) || r.vatNumber.includes(q);
    const matchTab    = tab === "all" || r.bucket === tab;
    return matchSearch && matchTab;
  }), [rows, search, tab]);

  // Get-or-init draft for a company row
  const getDraft = (r: OverviewRow) => settingsDraft[r.id] ?? {
    enabled: r.autoBackupEnabled,
    frequencyHours: r.autoBackupFrequencyHours,
    retention: r.autoBackupRetention,
  };
  const updateDraft = (id: number, patch: Partial<{ enabled: boolean; frequencyHours: number; retention: number }>) => {
    setSettingsDraft(s => {
      const cur = s[id] ?? { enabled: true, frequencyHours: 24, retention: 7 };
      const row = rows.find(r => r.id === id);
      const base = row ? { enabled: row.autoBackupEnabled, frequencyHours: row.autoBackupFrequencyHours, retention: row.autoBackupRetention } : cur;
      return { ...s, [id]: { ...base, ...cur, ...patch } };
    });
  };

  const downloadSnapshot = async (snapshotId: number) => {
    try {
      const res = await fetch(`${API}/api/admin/backups/auto/${snapshotId}/download`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error("فشل التنزيل");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `backup-${snapshotId}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "فشل التنزيل", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6" dir="rtl">

      {/* ─── Header ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <HardDrive className="h-6 w-6 text-primary" />مركز عمليات النسخ الاحتياطي
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            نظرة شاملة على صحة النسخ الاحتياطي لكل الشركات — عرض السجلات، الإعدادات، والتشغيل الفوري والجماعي.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data?.generatedAt && (
            <span className="text-[11px] text-muted-foreground">
              آخر تحديث: {formatDate(data.generatedAt)}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2">
            <RefreshCw className="h-3.5 w-3.5" />تحديث
          </Button>
        </div>
      </div>

      {/* ─── KPI tiles ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <KpiCard label="إجمالي الشركات" value={k?.total ?? "—"}
          icon={Database} iconBg="bg-primary/10" iconColor="text-primary" />
        <KpiCard label="نشطة" value={k?.green ?? "—"}
          sub="ضمن الجدولة المعتمدة"
          icon={CheckCircle2} iconBg="bg-green-100" iconColor="text-green-600" />
        <KpiCard label="متأخّرة" value={(k?.amber ?? 0) + (k?.red ?? 0)}
          sub={`${k?.red ?? 0} مفقودة • ${k?.amber ?? 0} متأخّر بسيط`}
          icon={AlertTriangle} iconBg="bg-amber-100" iconColor="text-amber-600"
          border={(k?.red ?? 0) > 0 ? "border-red-300" : undefined} />
        <KpiCard label="نسخ آخر 30 يوم" value={k?.snapshots30d ?? "—"}
          sub={k ? formatBytes(k.totalSize30d) : undefined}
          icon={Activity} iconBg="bg-blue-100" iconColor="text-blue-600" />
        <KpiCard label="إجمالي الحجم المخزّن" value={k ? formatBytes(k.totalSizeAll) : "—"}
          sub="كل النسخ المحفوظة"
          icon={HardDrive} iconBg="bg-violet-100" iconColor="text-violet-600" />
      </div>

      {/* ─── Bulk run-all card ──────────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="font-semibold text-sm flex items-center gap-2">
              <Zap className="h-4 w-4 text-amber-600" />تشغيل جماعي للنسخ الاحتياطي
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              يأخذ نسخة فورية لكل الشركات. المهمة تعمل في الخلفية وتُحدَّث الحالة كل بضع ثوانٍ.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              className="h-9 rounded-md border bg-background px-2 text-xs"
              value={bulkScope}
              onChange={e => setBulkScope(e.target.value as "enabled" | "all")}
              disabled={!!bulkJobId && bulkJob?.status === "running"}
            >
              <option value="enabled">الشركات المُفعَّل لها النسخ التلقائي فقط</option>
              <option value="all">كل الشركات النشطة</option>
            </select>
            <Button
              size="sm" className="gap-2 h-9"
              disabled={startBulkMutation.isPending || (bulkJob?.status === "running")}
              onClick={() => startBulkMutation.mutate(bulkScope)}
            >
              <PlayCircle className="h-4 w-4" />
              {bulkJob?.status === "running" ? "جارٍ التشغيل..." : "تشغيل الكل"}
            </Button>
            {bulkJobId && bulkJob?.status === "done" && (
              <Button variant="ghost" size="sm" className="h-9" onClick={() => setBulkJobId(null)}>
                إخفاء النتيجة
              </Button>
            )}
          </div>
        </div>

        {/* Progress panel */}
        {bulkJob && (
          <div className="mt-3 border-t pt-3 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium">
                التقدم: {bulkJob.completed + bulkJob.failed} / {bulkJob.total}
                {bulkJob.failed > 0 && <span className="text-red-700 mr-2">• فشل: {bulkJob.failed}</span>}
              </span>
              <span className={cn("font-semibold",
                bulkJob.status === "done" ? "text-green-700" : "text-amber-700")}>
                {bulkJob.status === "done" ? "اكتمل" : "قيد التشغيل"}
              </span>
            </div>
            <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
              <div
                className={cn("h-full transition-all",
                  bulkJob.failed > 0 ? "bg-amber-500" : "bg-green-500")}
                style={{ width: `${Math.min(100, ((bulkJob.completed + bulkJob.failed) / Math.max(1, bulkJob.total)) * 100)}%` }}
              />
            </div>
            {/* Per-company list — only show failed + running rows + last few done */}
            {(bulkJob.failed > 0 || bulkJob.status === "running") && (
              <div className="max-h-40 overflow-y-auto border rounded-md divide-y bg-background">
                {bulkJob.items
                  .filter(it => it.status !== "ok" || bulkJob.failed > 0)
                  .slice(0, 80)
                  .map(it => (
                    <div key={it.companyId} className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs">
                      <span className="truncate font-medium">{it.companyName}</span>
                      {it.status === "pending" && <span className="text-muted-foreground">في الانتظار</span>}
                      {it.status === "running" && <span className="text-amber-700 flex items-center gap-1"><RefreshCw className="h-3 w-3 animate-spin" />جارٍ...</span>}
                      {it.status === "ok"      && <span className="text-green-700 flex items-center gap-1"><CheckCircle2 className="h-3 w-3" />تم</span>}
                      {it.status === "error"   && <span className="text-red-700 truncate max-w-[50%] text-left" title={it.error}>{it.error ?? "فشل"}</span>}
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ─── Filters ─────────────────────────────────────────────────── */}
      <div className="flex gap-3 flex-col sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="ابحث باسم الشركة أو الرقم الضريبي..."
            className="pr-10 h-9 text-sm"
          />
        </div>
        <div className="flex rounded-lg border overflow-hidden bg-background text-sm">
          {BUCKET_TABS.map((t, i) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "px-3 py-1.5 font-medium transition-colors whitespace-nowrap",
                i > 0 && "border-r",
                tab === t.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              {t.label}
              {t.key !== "all" && k && <span className="text-[10px] opacity-70 mr-1">({k[t.key]})</span>}
            </button>
          ))}
        </div>
      </div>

      {/* ─── Table ──────────────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
        <div
          className="grid items-center gap-4 border-b bg-muted/40 px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide select-none"
          style={{ gridTemplateColumns: "2fr 1.4fr 1.2fr 1fr 1fr 1fr auto" }}
        >
          <span>الشركة</span>
          <span>الحالة</span>
          <span>آخر نسخة</span>
          <span>الحجم (30 يوم)</span>
          <span>التكرار</span>
          <span>الاحتفاظ</span>
          <span className="text-center w-8">—</span>
        </div>

        {isLoading && (
          <div className="divide-y">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="flex items-center gap-4 px-4 py-4 animate-pulse">
                <Skeleton className="h-4 w-40 flex-1" />
                <Skeleton className="h-6 w-24 rounded-full" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-4 w-16" />
              </div>
            ))}
          </div>
        )}

        {!isLoading && filtered.length === 0 && (
          <div className="py-20 text-center">
            <HardDrive className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-muted-foreground font-medium">لا توجد شركات{search ? " مطابقة" : ""}</p>
          </div>
        )}

        <div className="divide-y">
          {filtered.map(r => {
            const isExp = expandedRow === r.id;
            const draft = getDraft(r);
            const draftDirty =
              draft.enabled !== r.autoBackupEnabled ||
              draft.frequencyHours !== r.autoBackupFrequencyHours ||
              draft.retention !== r.autoBackupRetention;

            return (
              <div key={r.id} className={cn("transition-colors", r.bucket === "red" && "bg-red-50/30")}>
                <div
                  className="grid items-center gap-4 px-4 py-3.5 cursor-pointer hover:bg-muted/20 transition-colors"
                  style={{ gridTemplateColumns: "2fr 1.4fr 1.2fr 1fr 1fr 1fr auto" }}
                  onClick={() => setExpandedRow(isExp ? null : r.id)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={cn(
                      "h-8 w-8 rounded-lg font-bold text-sm flex items-center justify-center shrink-0",
                      r.bucket === "red"      ? "bg-red-100 text-red-700" :
                      r.bucket === "amber"    ? "bg-amber-100 text-amber-700" :
                      r.bucket === "disabled" ? "bg-zinc-100 text-zinc-700" :
                                                "bg-green-100 text-green-700",
                    )}>
                      {r.nameAr?.[0] ?? "ش"}
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-sm text-foreground truncate flex items-center gap-1.5">
                        {r.nameAr}
                        {r.status === "suspended" && (
                          <span className="text-[10px] bg-red-100 text-red-700 border border-red-200 rounded px-1">شركة موقوفة</span>
                        )}
                      </p>
                      <p className="text-[11px] font-mono text-muted-foreground truncate">{r.vatNumber}</p>
                    </div>
                  </div>

                  <BucketBadge bucket={r.bucket} ageHours={r.ageHours} />

                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Calendar className="h-3.5 w-3.5 shrink-0" />
                    {formatDate(r.lastAutoBackupAt)}
                  </div>

                  <div className="text-xs text-muted-foreground tabular-nums">
                    {formatBytes(r.totalSizeBytes30d)}
                    <div className="text-[10px] text-muted-foreground/70">{r.snapshotsLast30d} نسخة</div>
                  </div>

                  <div className="text-xs text-muted-foreground">
                    كل {r.autoBackupFrequencyHours} س
                  </div>

                  <div className="text-xs text-muted-foreground">
                    {r.autoBackupRetention} نسخ
                  </div>

                  <button
                    className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-muted transition-colors text-muted-foreground"
                    onClick={e => { e.stopPropagation(); setExpandedRow(isExp ? null : r.id); }}
                    aria-label={isExp ? "طي" : "توسيع"}
                  >
                    {isExp ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </button>
                </div>

                {/* ─── Inline expand panel: history + settings ─────── */}
                {isExp && (
                  <div className="border-t bg-muted/20 px-4 pb-4 pt-3 space-y-4">
                    {/* Action bar */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <Button
                        size="sm" className="gap-1.5 h-8"
                        disabled={runNowMutation.isPending}
                        onClick={() => runNowMutation.mutate(r.id)}
                      >
                        <PlayCircle className="h-3.5 w-3.5" />تشغيل نسخة الآن
                      </Button>
                      <span className="text-xs text-muted-foreground">يأخذ نسخة فورية وتُحفظ مع نسخ هذه الشركة.</span>
                    </div>

                    <div className="grid lg:grid-cols-2 gap-3">
                      {/* ─── History panel ──────────────────────── */}
                      <div className="rounded-lg border bg-background p-3 space-y-2">
                        <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                          <Clock className="h-3.5 w-3.5 text-primary" />سجل النسخ
                          {historyData?.snapshots && (
                            <span className="text-[10px] font-normal text-muted-foreground">
                              ({historyData.snapshots.length})
                            </span>
                          )}
                        </div>
                        {historyLoading && !historyData && (
                          <div className="space-y-1.5">
                            {[1, 2, 3].map(i => <Skeleton key={i} className="h-8 w-full" />)}
                          </div>
                        )}
                        {historyData?.snapshots?.length === 0 && (
                          <p className="text-xs text-muted-foreground py-3 text-center">لا توجد نسخ محفوظة بعد.</p>
                        )}
                        {historyData && historyData.snapshots.length > 0 && (
                          <div className="max-h-64 overflow-y-auto -mx-1 divide-y">
                            {historyData.snapshots.map(s => (
                              <div key={s.id} className="px-1 py-1.5 flex items-center gap-2 text-xs">
                                <span className={cn(
                                  "text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0",
                                  s.reason === "manual" ? "bg-blue-100 text-blue-700" : "bg-zinc-100 text-zinc-700",
                                )}>
                                  {s.reason === "manual" ? "يدوي" : "تلقائي"}
                                </span>
                                <span className="flex-1 truncate">{formatDate(s.createdAt)}</span>
                                <span className="text-muted-foreground shrink-0 tabular-nums">{formatBytes(s.sizeBytes)}</span>
                                <button
                                  className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted text-primary"
                                  title="تنزيل"
                                  onClick={() => downloadSnapshot(s.id)}
                                >
                                  <Download className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  className="h-6 w-6 flex items-center justify-center rounded hover:bg-red-50 text-red-600"
                                  title="حذف"
                                  disabled={deleteSnapshotMutation.isPending}
                                  onClick={() => {
                                    if (confirm(`هل تريد حذف هذه النسخة (${formatDate(s.createdAt)})؟`)) {
                                      deleteSnapshotMutation.mutate({ snapshotId: s.id, companyId: r.id });
                                    }
                                  }}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* ─── Settings panel ─────────────────────── */}
                      <div className="rounded-lg border bg-background p-3 space-y-3">
                        <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                          <SettingsIcon className="h-3.5 w-3.5 text-primary" />إعدادات النسخ التلقائي
                        </div>

                        <label className="flex items-center gap-2 text-xs cursor-pointer">
                          <Checkbox
                            checked={draft.enabled}
                            onCheckedChange={(v) => updateDraft(r.id, { enabled: !!v })}
                          />
                          <span className="font-medium">تفعيل النسخ التلقائي</span>
                        </label>

                        <div className="grid grid-cols-2 gap-2">
                          <div className="space-y-1">
                            <Label className="text-[11px] text-muted-foreground">التكرار (ساعات)</Label>
                            <Input
                              type="number" min={1} max={168}
                              className="h-8 text-xs"
                              value={draft.frequencyHours}
                              onChange={e => updateDraft(r.id, { frequencyHours: Math.max(1, Math.min(168, parseInt(e.target.value) || 1)) })}
                              disabled={!draft.enabled}
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-[11px] text-muted-foreground">عدد النسخ المحتفظ بها</Label>
                            <Input
                              type="number" min={1} max={30}
                              className="h-8 text-xs"
                              value={draft.retention}
                              onChange={e => updateDraft(r.id, { retention: Math.max(1, Math.min(30, parseInt(e.target.value) || 1)) })}
                            />
                          </div>
                        </div>

                        <div className="flex items-center justify-between gap-2 pt-1">
                          <p className="text-[11px] text-muted-foreground">
                            مرة كل {draft.frequencyHours} س • يحتفظ بآخر {draft.retention} نسخ
                          </p>
                          <div className="flex gap-1.5">
                            {draftDirty && (
                              <Button
                                size="sm" variant="ghost" className="h-7 text-xs"
                                onClick={() => setSettingsDraft(s => { const n = { ...s }; delete n[r.id]; return n; })}
                              >
                                إلغاء
                              </Button>
                            )}
                            <Button
                              size="sm" className="h-7 gap-1 text-xs"
                              disabled={!draftDirty || saveSettingsMutation.isPending}
                              onClick={() => saveSettingsMutation.mutate({
                                companyId: r.id,
                                body: {
                                  enabled: draft.enabled,
                                  frequencyHours: draft.frequencyHours,
                                  retention: draft.retention,
                                },
                              })}
                            >
                              حفظ الإعدادات
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {!isLoading && filtered.length > 0 && (
          <div className="border-t bg-muted/20 px-4 py-2.5 text-xs text-muted-foreground flex items-center justify-between">
            <span>عدد الشركات المعروضة: <strong>{filtered.length}</strong> من <strong>{rows.length}</strong></span>
            <span className="text-muted-foreground/60">انقر على أي صف لعرض السجل والإعدادات</span>
          </div>
        )}
      </div>
    </div>
  );
}
