import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  ServerCog,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type OperationState =
  | "idle"
  | "queued"
  | "downloading"
  | "verifying"
  | "installing"
  | "restarting"
  | "rolling_back"
  | "completed"
  | "rolled_back"
  | "failed";

type UpdateStatus = {
  currentVersion: string;
  availableVersion: string;
  sizeBytes: number;
  publishedAt: string | null;
  updateAvailable: boolean;
  operation: {
    state: OperationState;
    message: string;
    targetVersion?: string;
    updatedAt: string;
  };
};

const BUSY = new Set<OperationState>([
  "queued",
  "downloading",
  "verifying",
  "installing",
  "restarting",
  "rolling_back",
]);

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const mb = bytes / 1024 / 1024;
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}

function shortVersion(version: string): string {
  return version && version !== "unknown" ? version.slice(0, 12) : "—";
}

export default function AgentServerUpdateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { token } = useAuth();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const apiBase = import.meta.env.VITE_API_URL ?? "";

  const loadStatus = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const response = await fetch(`${apiBase}/api/agent-updates/status`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: "no-store",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || t("topbar.agentUpdateCheckFailed"));
      setStatus(body as UpdateStatus);
      setError("");
    } catch (e: any) {
      // A short connection gap is expected while zacod-app restarts. Preserve
      // the last visible phase and keep polling instead of turning it into a
      // scary failure message.
      if (!silent) setError(e?.message || t("topbar.agentUpdateCheckFailed"));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [apiBase, t, token]);

  useEffect(() => {
    if (!open) {
      setConfirming(false);
      return;
    }
    void loadStatus(false);
  }, [open, loadStatus]);

  const busy = !!status && BUSY.has(status.operation.state);
  useEffect(() => {
    if (!open || !busy) return;
    const timer = window.setInterval(() => void loadStatus(true), 2_000);
    return () => window.clearInterval(timer);
  }, [open, busy, loadStatus]);

  const completed = status?.operation.state === "completed" && !status.updateAvailable;
  const rolledBack = status?.operation.state === "rolled_back";
  const operationFailed = status?.operation.state === "failed" || rolledBack;
  const publishedLabel = useMemo(() => {
    if (!status?.publishedAt) return null;
    const d = new Date(status.publishedAt);
    return Number.isNaN(d.getTime())
      ? null
      : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }, [status?.publishedAt]);

  const applyUpdate = async () => {
    if (!status) return;
    setStarting(true);
    setError("");
    try {
      const response = await fetch(`${apiBase}/api/agent-updates/apply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ confirm: true, version: status.availableVersion }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || t("topbar.agentUpdateStartFailed"));
      setConfirming(false);
      setStatus((current) => current ? {
        ...current,
        operation: {
          state: "queued",
          message: t("topbar.agentUpdateQueued"),
          targetVersion: body?.targetVersion || current.availableVersion,
          updatedAt: new Date().toISOString(),
        },
      } : current);
    } catch (e: any) {
      setError(e?.message || t("topbar.agentUpdateStartFailed"));
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-testid="agent-update-dialog">
        <DialogHeader className="text-start">
          <DialogTitle className="flex items-center gap-2">
            <ServerCog className="h-5 w-5 text-primary" />
            {t("topbar.agentUpdateTitle")}
          </DialogTitle>
          <DialogDescription>{t("topbar.agentUpdateDescription")}</DialogDescription>
        </DialogHeader>

        {loading && !status ? (
          <div className="flex min-h-40 items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            {t("topbar.agentUpdateChecking")}
          </div>
        ) : (
          <div className="space-y-4">
            {error && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
                {error}
              </div>
            )}

            {status && (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="rounded-lg border bg-muted/30 p-3">
                    <p className="text-xs text-muted-foreground">{t("topbar.agentUpdateCurrent")}</p>
                    <p className="mt-1 font-mono text-sm font-semibold" dir="ltr">{shortVersion(status.currentVersion)}</p>
                  </div>
                  <div className="rounded-lg border bg-muted/30 p-3">
                    <p className="text-xs text-muted-foreground">{t("topbar.agentUpdateAvailable")}</p>
                    <p className="mt-1 font-mono text-sm font-semibold" dir="ltr">{shortVersion(status.availableVersion)}</p>
                  </div>
                  <div className="rounded-lg border bg-muted/30 p-3">
                    <p className="text-xs text-muted-foreground">{t("topbar.agentUpdateSize")}</p>
                    <p className="mt-1 text-sm font-semibold" dir="ltr">{formatBytes(status.sizeBytes)}</p>
                  </div>
                </div>

                {publishedLabel && (
                  <p className="text-xs text-muted-foreground">
                    {t("topbar.agentUpdatePublished")}: <span dir="ltr">{publishedLabel}</span>
                  </p>
                )}

                {busy ? (
                  <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-blue-900">
                    <div className="flex items-start gap-3">
                      <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin" />
                      <div>
                        <p className="font-semibold">{status.operation.message}</p>
                        <p className="mt-1 text-xs text-blue-700">{t("topbar.agentUpdateRestartHint")}</p>
                      </div>
                    </div>
                  </div>
                ) : completed || (!status.updateAvailable && !operationFailed) ? (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-900">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-5 w-5" />
                      <p className="font-semibold">
                        {completed ? status.operation.message : t("topbar.agentUpdateLatest")}
                      </p>
                    </div>
                  </div>
                ) : operationFailed ? (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-900">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                      <div>
                        <p className="font-semibold">{status.operation.message}</p>
                        {rolledBack && <p className="mt-1 text-xs">{t("topbar.agentUpdateRollbackSafe")}</p>}
                      </div>
                    </div>
                  </div>
                ) : confirming ? (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                      <div>
                        <p className="font-semibold">{t("topbar.agentUpdateConfirmTitle")}</p>
                        <p className="mt-1 text-sm text-amber-800">{t("topbar.agentUpdateConfirmDescription")}</p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
                    <p className="font-semibold text-primary">{t("topbar.agentUpdateReady")}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{t("topbar.agentUpdateNoAuto")}</p>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {status && confirming && !busy ? (
            <>
              <Button variant="outline" onClick={() => setConfirming(false)} disabled={starting}>
                {t("common.cancel")}
              </Button>
              <Button onClick={applyUpdate} disabled={starting} data-testid="confirm-agent-update">
                {starting ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <Download className="me-2 h-4 w-4" />}
                {t("topbar.agentUpdateConfirmButton")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => void loadStatus(false)} disabled={loading || busy}>
                <RefreshCw className={`me-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                {t("topbar.agentUpdateCheck")}
              </Button>
              {completed ? (
                <Button onClick={() => window.location.reload()} data-testid="reload-after-agent-update">
                  {t("topbar.agentUpdateReload")}
                </Button>
              ) : status?.updateAvailable && !busy ? (
                <Button onClick={() => setConfirming(true)} data-testid="start-agent-update">
                  <Download className="me-2 h-4 w-4" />
                  {t("topbar.agentUpdateInstall")}
                </Button>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}