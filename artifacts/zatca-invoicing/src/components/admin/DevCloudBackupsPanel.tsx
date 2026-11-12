import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  downloadDevCloudBackup,
  getListDevCloudBackupsQueryKey,
  useCreateDevCloudBackup,
  useListDevCloudBackups,
  useRestoreDevCloudBackupToAgent,
  useUploadDevCloudBackupToAgent,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Archive,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Clock3,
  Cloud,
  Database,
  HardDrive,
  LoaderCircle,
  LockKeyhole,
  RotateCcw,
  Server,
  ShieldCheck,
  X,
} from "lucide-react";

const statusText: Record<string, string> = {
  creating: "جارٍ الإنشاء",
  ready: "مكتمل",
  failed: "فشل",
  queued: "في قائمة الانتظار",
  running: "قيد التنفيذ",
  completed: "مكتملة",
};

const statusStyle: Record<string, string> = {
  creating: "border-amber-200 bg-amber-50 text-amber-800",
  queued: "border-amber-200 bg-amber-50 text-amber-800",
  running: "border-sky-200 bg-sky-50 text-sky-800",
  ready: "border-emerald-200 bg-emerald-50 text-emerald-800",
  completed: "border-emerald-200 bg-emerald-50 text-emerald-800",
  failed: "border-rose-200 bg-rose-50 text-rose-800",
};

const actionText: Record<string, string> = {
  create: "إنشاء نسخة احتياطية",
  upload: "رفع نسخة إلى وكيل",
  restore: "استعادة كود التطبيق",
};

function StatusBadge({ status, testId }: { status: string; testId: string }) {
  return (
    <span
      data-testid={testId}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold",
        statusStyle[status] ?? "border-slate-200 bg-slate-50 text-slate-600",
      )}
    >
      {status === "running" || status === "creating" ? (
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
      ) : status === "ready" || status === "completed" ? (
        <Check className="h-3.5 w-3.5" />
      ) : status === "failed" ? (
        <AlertTriangle className="h-3.5 w-3.5" />
      ) : (
        <Clock3 className="h-3.5 w-3.5" />
      )}
      {statusText[status] ?? status}
    </span>
  );
}

function formatDate(value: string) {
  return new Date(value).toLocaleString("ar-SA-u-ca-gregory-nu-latn", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatBytes(bytes: number) {
  if (!bytes) return "—";
  const units = ["بايت", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toLocaleString("ar-SA-u-nu-latn", { maximumFractionDigits: 1 })} ${units[unit]}`;
}

export default function DevCloudBackupsPanel() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [label, setLabel] = useState("");
  const [sourceType, setSourceType] = useState<"central" | "agent">("central");
  const [sourceAgentId, setSourceAgentId] = useState("");
  const [activeDialog, setActiveDialog] = useState<"upload" | "restore" | null>(null);
  const [selectedBackupId, setSelectedBackupId] = useState<number | null>(null);
  const [targetAgentId, setTargetAgentId] = useState("");
  const [uploadConfirmed, setUploadConfirmed] = useState(false);
  const [restoreConfirmed, setRestoreConfirmed] = useState(false);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);

  const list = useListDevCloudBackups({
    query: {
      queryKey: getListDevCloudBackupsQueryKey(),
      refetchInterval: 3000,
      refetchOnWindowFocus: true,
    },
  });
  const createBackup = useCreateDevCloudBackup();
  const uploadBackup = useUploadDevCloudBackupToAgent();
  const restoreBackup = useRestoreDevCloudBackupToAgent();
  const data = list.data;
  const backups = data?.backups ?? [];
  const operations = data?.operations ?? [];
  const eligibleSourceAgents = useMemo(
    () =>
      (data?.agentTargets ?? []).filter(
        (agent) => agent.status === "active" && agent.databaseReady,
      ),
    [data?.agentTargets],
  );
  const eligibleTargets = useMemo(
    () =>
      (data?.agentTargets ?? []).filter(
        (agent) => agent.status === "active" && agent.sshReady,
      ),
    [data?.agentTargets],
  );
  const selectedBackup = backups.find((backup) => backup.id === selectedBackupId);
  const busy =
    createBackup.isPending || uploadBackup.isPending || restoreBackup.isPending;

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListDevCloudBackupsQueryKey() });

  const openAction = (action: "upload" | "restore", backupId: number) => {
    setSelectedBackupId(backupId);
    setTargetAgentId("");
    setUploadConfirmed(false);
    setRestoreConfirmed(false);
    setActiveDialog(action);
  };

  const create = () => {
    const cleanLabel = label.trim();
    if (!cleanLabel || (sourceType === "agent" && !sourceAgentId)) return;
    createBackup.mutate(
      {
        data: {
          label: cleanLabel,
          sourceType,
          ...(sourceType === "agent" ? { sourceAgentId: Number(sourceAgentId) } : {}),
        },
      },
      {
        onSuccess: () => {
          setLabel("");
          toast({ title: "تمت إضافة النسخة إلى قائمة الإنشاء" });
          void invalidate();
        },
        onError: (error) =>
          toast({
            title: "تعذر إنشاء النسخة",
            description: error instanceof Error ? error.message : "حدث خطأ غير متوقع",
            variant: "destructive",
          }),
      },
    );
  };

  const submitAction = () => {
    if (!selectedBackupId || !targetAgentId) return;
    const targetId = Number(targetAgentId);
    if (activeDialog === "upload" && uploadConfirmed) {
      uploadBackup.mutate(
        { backupId: selectedBackupId, data: { targetAgentId: targetId } },
        {
          onSuccess: () => {
            setActiveDialog(null);
            toast({ title: "تمت إضافة عملية الرفع" });
            void invalidate();
          },
          onError: (error) =>
            toast({
              title: "تعذر رفع النسخة",
              description: error instanceof Error ? error.message : "حدث خطأ غير متوقع",
              variant: "destructive",
            }),
        },
      );
    }
    if (activeDialog === "restore" && restoreConfirmed) {
      restoreBackup.mutate(
        {
          backupId: selectedBackupId,
          data: { targetAgentId: targetId, confirm: true },
        },
        {
          onSuccess: () => {
            setActiveDialog(null);
            toast({ title: "تمت إضافة عملية الاستعادة" });
            void invalidate();
          },
          onError: (error) =>
            toast({
              title: "تعذر بدء الاستعادة",
              description: error instanceof Error ? error.message : "حدث خطأ غير متوقع",
              variant: "destructive",
            }),
        },
      );
    }
  };

  const download = async (id: number, name: string) => {
    setDownloadingId(id);
    try {
      const blob = await downloadDevCloudBackup(id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${name.replace(/[\\/:*?"<>|]/g, "-")}.tar.gz`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      toast({
        title: "تعذر تنزيل الحزمة",
        description: error instanceof Error ? error.message : "حاول مرة أخرى",
        variant: "destructive",
      });
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <section
      dir="rtl"
      aria-labelledby="dev-cloud-backups-title"
      data-testid="panel-dev-cloud-backups"
      className="mt-7 overflow-hidden rounded-2xl border border-teal-200/80 bg-[#f7fbfa] shadow-sm"
    >
      <header className="flex flex-col gap-4 border-b border-teal-100 bg-gradient-to-l from-teal-50/90 to-[#f7fbfa] px-4 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-teal-200 bg-white text-teal-800">
            <Archive className="h-5 w-5" />
          </div>
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <h2 id="dev-cloud-backups-title" className="text-lg font-bold text-slate-800">
                نسخ استرداد Developer Cloud
              </h2>
              <span className="rounded-full border border-teal-200 bg-white px-2 py-0.5 text-[10px] font-bold tracking-wide text-teal-800">
                SUPERADMIN
              </span>
            </div>
            <p data-testid="text-backups-description" className="max-w-2xl text-sm leading-6 text-slate-600">
              حزم استرداد لتشغيل ERP وقاعدة البيانات، وقد تتضمن سجلات أعمال الشركات. هذه اللوحة منفصلة عن أدوات خادم الوكيل.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 rounded-lg border border-teal-100 bg-white/80 px-3 py-2 text-xs text-teal-900">
          <LockKeyhole className="h-4 w-4" />
          بيانات استرداد حساسة
        </div>
      </header>

      <div className="grid gap-4 p-4 sm:p-5 lg:grid-cols-[minmax(280px,0.75fr)_minmax(0,1.25fr)]">
        <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
          <div className="mb-4 flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-50 text-teal-800">
              <HardDrive className="h-4 w-4" />
            </div>
            <div>
              <h3 className="font-bold text-slate-800">إنشاء نسخة احتياطية</h3>
              <p className="text-xs text-slate-500">اختر قاعدة البيانات وسمّ الحزمة</p>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <Label htmlFor="backup-label">اسم النسخة</Label>
              <Input
                id="backup-label"
                data-testid="input-backup-label"
                className="mt-1.5"
                maxLength={120}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="مثال: إصدار ما قبل التحديث"
              />
            </div>
            <div>
              <Label htmlFor="backup-source">مصدر قاعدة البيانات</Label>
              <select
                id="backup-source"
                data-testid="select-backup-source"
                className="mt-1.5 min-h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-teal-600/30"
                value={sourceType}
                onChange={(event) => {
                  setSourceType(event.target.value as "central" | "agent");
                  setSourceAgentId("");
                }}
              >
                <option value="central">قاعدة بيانات المركزي — Replit</option>
                <option value="agent">قاعدة بيانات وكيل كامل</option>
              </select>
            </div>
            <p data-testid="notice-central-code-source" className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-700">
              تتضمن كل حزمة نسخة تشغيل مطابقة للإصدار المركزي الحالي؛ هذا الاختيار يحدد قاعدة البيانات المرفقة فقط.
            </p>
            {sourceType === "agent" && (
              <div>
                <Label htmlFor="backup-source-agent">الوكيل المصدر</Label>
                <select
                  id="backup-source-agent"
                  data-testid="select-backup-source-agent"
                  className="mt-1.5 min-h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                  value={sourceAgentId}
                  onChange={(event) => setSourceAgentId(event.target.value)}
                >
                  <option value="">اختر وكيلاً</option>
                  {eligibleSourceAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}{agent.domain ? ` — ${agent.domain}` : ""}
                    </option>
                  ))}
                </select>
                {eligibleSourceAgents.length === 0 && (
                  <p data-testid="text-no-eligible-source" className="mt-1.5 text-xs text-amber-800">
                    لا توجد وكلاء مؤهلون حالياً. يلزم أن يكون الوكيل نشطاً وجاهزاً لقاعدة البيانات.
                  </p>
                )}
                <div data-testid="notice-agent-source" className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
                  هذا المصدر لقطة كاملة لقاعدة بيانات الوكيل، وقد يتضمن سجلات وبيانات أعمال الشركات.
                </div>
              </div>
            )}
            {sourceType === "central" && (
              <div data-testid="notice-central-source" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
                لقطة كاملة تتضمن قاعدة البيانات؛ قد تحتوي على سجلات وبيانات أعمال الشركات.
              </div>
            )}
            <Button
              data-testid="button-create-backup"
              className="w-full"
              disabled={!label.trim() || (sourceType === "agent" && !sourceAgentId) || createBackup.isPending}
              onClick={create}
            >
              {createBackup.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
              إنشاء نسخة
            </Button>
          </div>

          <div className="mt-4 flex gap-2 border-t border-slate-100 pt-4 text-xs leading-5 text-slate-500">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-teal-700" />
            <span>يظهر تقدم الإنشاء والرفع والاستعادة في سجل العمليات أدناه.</span>
          </div>
        </div>

        <div className="min-w-0">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <h3 className="font-bold text-slate-800">حزم الاسترداد</h3>
              <p className="text-xs text-slate-500">التحديث تلقائي كل 3 ثوانٍ</p>
            </div>
            <span data-testid="text-backup-count" className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
              {list.isLoading ? "…" : `${backups.length} حزمة`}
            </span>
          </div>
          <div data-testid="notice-sensitive-download" className="mb-3 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-950">
            <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-amber-800" />
            <span>التنزيل ينتج أرشيف استرداد مفكوك التشفير بامتداد .tar.gz وقد يحتوي على بيانات أعمال الشركات. خزّنه في مكان آمن ومقيّد الوصول.</span>
          </div>

          {list.isLoading ? (
            <div data-testid="loading-backups" className="space-y-2">
              {[0, 1, 2].map((item) => <Skeleton key={item} className="h-[90px] w-full rounded-xl" />)}
            </div>
          ) : list.isError ? (
            <div data-testid="error-backups" className="rounded-xl border border-rose-200 bg-rose-50 p-5 text-center">
              <p className="mb-3 text-sm font-semibold text-rose-800">تعذر تحميل حزم الاسترداد</p>
              <Button data-testid="button-retry-backups" variant="outline" size="sm" onClick={() => void list.refetch()}>
                إعادة المحاولة
              </Button>
            </div>
          ) : backups.length === 0 ? (
            <div data-testid="empty-backups" className="rounded-xl border border-dashed border-slate-300 bg-white px-5 py-9 text-center">
              <Cloud className="mx-auto mb-2 h-7 w-7 text-slate-400" />
              <p className="text-sm font-semibold text-slate-700">لا توجد حزم استرداد بعد</p>
              <p className="mt-1 text-xs text-slate-500">أنشئ حزمة من المركزي أو من وكيل كامل مؤهل.</p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {backups.map((backup) => (
                <article
                  key={backup.id}
                  data-testid={`card-backup-${backup.id}`}
                  className="rounded-xl border border-slate-200 bg-white p-3.5 transition-colors hover:border-teal-200 sm:p-4"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 data-testid={`text-backup-label-${backup.id}`} className="break-words font-bold text-slate-800">{backup.label}</h4>
                        <StatusBadge status={backup.status} testId={`backup-status-${backup.id}`} />
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
                        <span data-testid={`text-backup-source-${backup.id}`} className="inline-flex items-center gap-1">
                          {backup.sourceType === "central" ? <Cloud className="h-3.5 w-3.5" /> : <Server className="h-3.5 w-3.5" />}
                          {backup.sourceLabel} · لقطة قاعدة بيانات كاملة
                        </span>
                        <span data-testid={`text-backup-created-${backup.id}`}>{formatDate(backup.createdAt)}</span>
                        <span data-testid={`text-backup-version-${backup.id}`}>إصدار التطبيق {backup.releaseVersion}</span>
                        <span data-testid={`text-backup-size-${backup.id}`} className="inline-flex items-center gap-1">
                          <Database className="h-3.5 w-3.5" />{formatBytes(backup.bundleSizeBytes)}
                        </span>
                      </div>
                      {backup.error && <p data-testid={`text-backup-error-${backup.id}`} className="mt-2 text-xs text-rose-700">{backup.error}</p>}
                    </div>
                    <div className="flex flex-wrap gap-1.5 sm:justify-end">
                      {backup.status === "ready" && (
                        <>
                          <Button
                            data-testid={`button-download-backup-${backup.id}`}
                            size="sm"
                            variant="outline"
                            disabled={downloadingId === backup.id}
                            onClick={() => void download(backup.id, backup.label)}
                          >
                            {downloadingId === backup.id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ArrowDownToLine className="h-4 w-4" />}
                            تنزيل الأرشيف الحساس
                          </Button>
                          <Button
                            data-testid={`button-upload-backup-${backup.id}`}
                            size="sm"
                            variant="outline"
                            disabled={eligibleTargets.length === 0 || busy}
                            onClick={() => openAction("upload", backup.id)}
                          >
                            <ArrowUpFromLine className="h-4 w-4" /> رفع إلى وكيل
                          </Button>
                          <Button
                            data-testid={`button-restore-backup-${backup.id}`}
                            size="sm"
                            variant="outline"
                            disabled={eligibleTargets.length === 0 || busy}
                            onClick={() => openAction("restore", backup.id)}
                          >
                            <RotateCcw className="h-4 w-4" /> استعادة الكود
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-4 border-t border-teal-100 bg-white/60 p-4 sm:p-5 lg:grid-cols-2">
        <div data-testid="notice-replit-restore" className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50/80 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-800" />
          <div>
            <h3 className="text-sm font-bold text-amber-950">استرداد المركزي عبر Replit يدوي</h3>
            <p className="mt-1 text-xs leading-5 text-amber-900">
              لا توجد استعادة مركزية من داخل هذه اللوحة. لاستعادة المركزي، ارجع إلى نقطة فحص المشروع (Project checkpoint) في Replit ثم أعد النشر (republish) يدوياً.
            </p>
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-3 flex items-center gap-2">
            <Clock3 className="h-4 w-4 text-teal-800" />
            <h3 className="text-sm font-bold text-slate-800">العمليات الأخيرة</h3>
          </div>
          {list.isLoading ? (
            <div data-testid="loading-backup-operations" className="space-y-2">
              <Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" />
            </div>
          ) : list.isError ? (
            <p data-testid="error-backup-operations" className="text-xs text-rose-700">تعذر تحميل سجل العمليات.</p>
          ) : operations.length === 0 ? (
            <p data-testid="empty-backup-operations" className="py-2 text-center text-xs text-slate-500">لا توجد عمليات بعد.</p>
          ) : (
            <div className="max-h-56 space-y-2 overflow-y-auto">
              {operations.map((operation) => (
                <div
                  key={operation.id}
                  data-testid={`row-backup-operation-${operation.id}`}
                  className="flex flex-col gap-1.5 rounded-lg border border-slate-100 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p data-testid={`text-operation-action-${operation.id}`} className="text-xs font-semibold text-slate-700">
                      {actionText[operation.action] ?? operation.action}
                      <span className="font-normal text-slate-500"> · {operation.targetLabel}</span>
                    </p>
                    {(operation.message || operation.error) && (
                      <p data-testid={`text-operation-message-${operation.id}`} className={cn("mt-0.5 break-words text-[11px]", operation.error ? "text-rose-700" : "text-slate-500")}>
                        {operation.error ?? operation.message}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center justify-between gap-2">
                    <span data-testid={`text-operation-created-${operation.id}`} className="text-[10px] text-slate-400">{formatDate(operation.createdAt)}</span>
                    <StatusBadge status={operation.status} testId={`operation-status-${operation.id}`} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {activeDialog && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/45 p-4"
          data-testid="dialog-backup-agent-action"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setActiveDialog(null);
          }}
        >
          <div role="dialog" aria-modal="true" aria-labelledby="backup-action-title" className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl sm:p-6">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 id="backup-action-title" className="text-lg font-bold text-slate-800">
                  {activeDialog === "upload" ? "رفع الحزمة إلى وكيل" : "استعادة كود التطبيق"}
                </h2>
                <p data-testid="text-selected-backup" className="mt-1 text-sm text-slate-500">{selectedBackup?.label}</p>
              </div>
              <button
                type="button"
                data-testid="button-close-agent-action"
                aria-label="إغلاق"
                disabled={busy}
                onClick={() => setActiveDialog(null)}
                className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div>
              <Label htmlFor="backup-target-agent">الوكيل الهدف</Label>
              <select
                id="backup-target-agent"
                data-testid="select-backup-target-agent"
                className="mt-1.5 min-h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                value={targetAgentId}
                onChange={(event) => {
                  setTargetAgentId(event.target.value);
                  setUploadConfirmed(false);
                  setRestoreConfirmed(false);
                }}
              >
                <option value="">اختر وكيلاً</option>
                {eligibleTargets.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}{agent.domain ? ` — ${agent.domain}` : ""}
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-xs text-slate-500">تُعرض الوكلاء النشطة ذات اتصال SSH مختبر فقط.</p>
            </div>

            {activeDialog === "upload" ? (
              <div data-testid="notice-agent-upload" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3.5">
                <p className="text-xs leading-5 text-amber-950">
                  الحزمة تتضمن لقطة كاملة لقاعدة البيانات وقد تحتوي على بيانات أعمال الشركات. سيرسل الملف المشفّر إلى مساحة النسخ الاحتياطي للوكيل، ولن يستورده.
                </p>
                <label className="mt-3 flex cursor-pointer items-start gap-2 border-t border-amber-200 pt-3 text-xs font-medium leading-5 text-amber-950">
                  <input
                    type="checkbox"
                    data-testid="checkbox-confirm-sensitive-upload"
                    checked={uploadConfirmed}
                    onChange={(event) => setUploadConfirmed(event.target.checked)}
                    className="mt-1 h-4 w-4 accent-amber-800"
                  />
                  أوافق على إرسال الأرشيف المشفّر الذي قد يحتوي على بيانات أعمال إلى هذا الوكيل.
                </label>
              </div>
            ) : (
              <div data-testid="notice-agent-restore" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3.5">
                <div className="flex gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-800" />
                  <div className="text-xs leading-5 text-amber-950">
                    <p className="font-bold">سيتم استبدال كود التطبيق على الوكيل المحدد.</p>
                    <p>لن تُرسل لقطة قاعدة البيانات إلى الوكيل، ولن تُستورد أو تُعدّل بيانات الشركة.</p>
                  </div>
                </div>
                <label className="mt-3 flex cursor-pointer items-start gap-2 border-t border-amber-200 pt-3 text-xs font-medium leading-5 text-amber-950">
                  <input
                    type="checkbox"
                    data-testid="checkbox-confirm-code-restore"
                    checked={restoreConfirmed}
                    onChange={(event) => setRestoreConfirmed(event.target.checked)}
                    className="mt-1 h-4 w-4 accent-amber-800"
                  />
                  أؤكد استعادة كود التطبيق على هذا الوكيل فقط.
                </label>
              </div>
            )}
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button data-testid="button-cancel-agent-action" variant="outline" disabled={busy} onClick={() => setActiveDialog(null)}>إلغاء</Button>
              <Button
                data-testid="button-confirm-agent-action"
                disabled={!targetAgentId || busy || (activeDialog === "upload" && !uploadConfirmed) || (activeDialog === "restore" && !restoreConfirmed)}
                onClick={submitAction}
              >
                {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : activeDialog === "upload" ? <ArrowUpFromLine className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
                {activeDialog === "upload" ? "رفع الحزمة" : "تأكيد استعادة الكود"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
