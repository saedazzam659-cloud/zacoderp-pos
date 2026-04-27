import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Clock, FileText, StopCircle, Sparkles, RefreshCw, Activity } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

interface WorkSession {
  id: number;
  companyId: number;
  userId: number;
  username: string | null;
  startedAt: string;
  endedAt: string | null;
  status: "active" | "ended";
  endReason: string | null;
  ip: string | null;
  userAgent: string | null;
  notes: string | null;
  aiReport: string | null;
  aiReportGeneratedAt: string | null;
  activityCount: number | null;
  createdAt: string;
  updatedAt: string;
}

interface SessionDetail {
  session: WorkSession;
  durationSecs: number;
  durationLabel: string;
  activity: Array<{
    id: number;
    module: string;
    action: string;
    entityType: string | null;
    entityId: string | null;
    method: string | null;
    path: string | null;
    statusCode: number | null;
    metadata: any;
    createdAt: string;
  }>;
  activityCount: number;
}

interface Summary { active: number; today: number; month: number; }

// Format an ISO date for display in the user's locale.
function fmtDate(iso: string | null, locale: string): string {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(locale); } catch { return iso; }
}

// Compute live duration label for active sessions client-side, since the
// list endpoint returns the raw row only — recomputing here keeps the table
// fresh without a per-row detail fetch.
function liveDuration(startedAt: string, endedAt: string | null, jariya: string): string {
  const end = endedAt ? new Date(endedAt) : new Date();
  const secs = Math.max(0, Math.floor((end.getTime() - new Date(startedAt).getTime()) / 1000));
  if (secs <= 0) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h && m) return `${h}س ${m}د`;
  if (h)      return `${h}س`;
  if (m)      return `${m}د`;
  return endedAt ? "<1د" : jariya;
}

// Tiny Markdown → HTML renderer. The AI report is well-controlled (Claude
// is instructed to use a fixed structure: H2 sections, bullet lists, an
// optional table), so we don't need the full react-markdown dependency.
// We escape input first then apply a small set of regex transforms.
function renderMarkdown(md: string): string {
  if (!md) return "";
  const esc = (s: string) => s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  let html = esc(md);

  // Tables: detect blocks of consecutive lines starting with `|`.
  html = html.replace(/((?:^\|.*\|\s*$\n?)+)/gm, (block) => {
    const lines = block.trim().split(/\n/).filter(Boolean);
    if (lines.length < 2) return block;
    const cells = (line: string) => line.replace(/^\||\|$/g, "").split("|").map(c => c.trim());
    const head = cells(lines[0]);
    const isSep = /^[\s\-:|]+$/.test(lines[1]);
    const bodyLines = isSep ? lines.slice(2) : lines.slice(1);
    const thead = `<thead><tr>${head.map(h => `<th class="px-2 py-1 text-start border border-border bg-muted/40">${h}</th>`).join("")}</tr></thead>`;
    const tbody = `<tbody>${bodyLines.map(l => `<tr>${cells(l).map(c => `<td class="px-2 py-1 border border-border align-top">${c}</td>`).join("")}</tr>`).join("")}</tbody>`;
    return `<table class="my-2 w-full text-xs border-collapse">${thead}${tbody}</table>`;
  });

  // Headings.
  html = html.replace(/^###\s+(.+)$/gm, '<h3 class="text-base font-semibold mt-4 mb-1">$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm,  '<h2 class="text-lg font-bold mt-5 mb-2 border-b border-border pb-1">$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm,   '<h1 class="text-xl font-bold mt-6 mb-2">$1</h1>');

  // Bullet lists: group consecutive `- ` lines into one <ul>.
  html = html.replace(/(?:^- .+\n?)+/gm, (block) => {
    const items = block.trim().split(/\n/).map(l => l.replace(/^- /, "").trim());
    return `<ul class="list-disc ms-6 my-2 space-y-1">${items.map(i => `<li>${i}</li>`).join("")}</ul>`;
  });

  // Inline emphasis + code.
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 rounded bg-muted text-xs">$1</code>');

  // Paragraphs: collapse remaining blank-line-separated chunks.
  html = html.split(/\n{2,}/).map(chunk => {
    const c = chunk.trim();
    if (!c) return "";
    if (/^<(h\d|ul|ol|table|p|div|pre)/.test(c)) return c;
    return `<p class="my-1 leading-7">${c.replace(/\n/g, "<br/>")}</p>`;
  }).join("\n");

  return html;
}

export default function WorkSessions() {
  const { token, user } = useAuth();
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const isRtl = i18n.language === "ar";
  const locale = isRtl ? "ar-SA" : "en-US";
  const tr = (k: string, opts?: any) => t(`workSessions.${k}`, opts) as string;
  const headers = { Authorization: `Bearer ${token}` };

  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "ended">("all");
  const [openId, setOpenId] = useState<number | null>(null);

  // List query — refetched every 30s so active-session durations stay live-ish
  // without hammering the server.
  const { data: rows = [], isLoading, refetch, isFetching } = useQuery<WorkSession[]>({
    queryKey: ["work-sessions", statusFilter],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (statusFilter !== "all") p.set("status", statusFilter);
      p.set("limit", "100");
      const r = await fetch(`${API}/api/work-sessions?${p.toString()}`, { headers });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    refetchInterval: 30_000,
  });

  const { data: summary } = useQuery<Summary>({
    queryKey: ["work-sessions-summary"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/work-sessions/summary`, { headers });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    refetchInterval: 30_000,
  });

  const { data: detail, isLoading: detailLoading } = useQuery<SessionDetail>({
    queryKey: ["work-session", openId],
    enabled: openId !== null,
    queryFn: async () => {
      const r = await fetch(`${API}/api/work-sessions/${openId}`, { headers });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  });

  const endMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/work-sessions/${id}/end`, { method: "POST", headers });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => {
      toast({ title: tr("toast.endedTitle"), description: tr("toast.endedBody") });
      qc.invalidateQueries({ queryKey: ["work-sessions"] });
      qc.invalidateQueries({ queryKey: ["work-sessions-summary"] });
      qc.invalidateQueries({ queryKey: ["work-session", openId] });
    },
    onError: (e: any) => toast({ title: tr("toast.errorTitle"), description: String(e?.message ?? e), variant: "destructive" }),
  });

  const reportMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/work-sessions/${id}/generate-report`, { method: "POST", headers });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: (res) => {
      toast({
        title: tr("toast.reportReadyTitle"),
        description: res?.truncated ? tr("toast.reportTruncated") : tr("toast.reportReadyBody"),
      });
      qc.invalidateQueries({ queryKey: ["work-sessions"] });
      qc.invalidateQueries({ queryKey: ["work-session", openId] });
    },
    onError: (e: any) => toast({ title: tr("toast.errorTitle"), description: String(e?.message ?? e), variant: "destructive" }),
  });

  const isAdmin = user?.role === "admin" || user?.role === "superadmin";

  const reportHtml = useMemo(
    () => detail?.session?.aiReport ? renderMarkdown(detail.session.aiReport) : "",
    [detail?.session?.aiReport],
  );

  return (
    <div dir={isRtl ? "rtl" : "ltr"} className="space-y-4">
      {/* Header + stats */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-primary" />
            {tr("title")}
          </CardTitle>
          <CardDescription>{tr("subtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <StatTile label={tr("stats.active")} value={summary?.active ?? "—"} accent="emerald" />
            <StatTile label={tr("stats.today")}  value={summary?.today  ?? "—"} accent="sky" />
            <StatTile label={tr("stats.month")}  value={summary?.month  ?? "—"} accent="violet" />
          </div>
        </CardContent>
      </Card>

      {/* Filter row */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[180px]">
              <label className="text-xs text-muted-foreground mb-1 block">{tr("filter.status")}</label>
              <Select value={statusFilter} onValueChange={(v: any) => setStatusFilter(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{tr("filter.all")}</SelectItem>
                  <SelectItem value="active">{tr("status.active")}</SelectItem>
                  <SelectItem value="ended">{tr("status.ended")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button variant="outline" onClick={() => refetch()} disabled={isFetching} className="gap-1">
              <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
              {tr("refresh")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Sessions table */}
      <Card>
        <CardContent className="pt-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : rows.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-10">{tr("empty")}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    {isAdmin && <th className="text-start p-2 font-medium">{tr("col.user")}</th>}
                    <th className="text-start p-2 font-medium">{tr("col.started")}</th>
                    <th className="text-start p-2 font-medium">{tr("col.ended")}</th>
                    <th className="text-start p-2 font-medium">{tr("col.duration")}</th>
                    <th className="text-start p-2 font-medium">{tr("col.actions")}</th>
                    <th className="text-start p-2 font-medium">{tr("col.status")}</th>
                    <th className="text-start p-2 font-medium">{tr("col.tools")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-border hover:bg-muted/30 cursor-pointer"
                        onClick={() => setOpenId(r.id)}
                        data-testid={`row-session-${r.id}`}>
                      {isAdmin && <td className="p-2">{r.username ?? `#${r.userId}`}</td>}
                      <td className="p-2 whitespace-nowrap">{fmtDate(r.startedAt, locale)}</td>
                      <td className="p-2 whitespace-nowrap">
                        {r.endedAt ? fmtDate(r.endedAt, locale) : <span className="text-emerald-600">{tr("ongoing")}</span>}
                      </td>
                      <td className="p-2 whitespace-nowrap">{liveDuration(r.startedAt, r.endedAt, tr("ongoing"))}</td>
                      <td className="p-2">{r.activityCount ?? "—"}</td>
                      <td className="p-2">
                        <Badge variant="outline" className={
                          r.status === "active"
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : "bg-gray-50 text-gray-700 border-gray-200"
                        }>
                          {tr(`status.${r.status}`)}
                        </Badge>
                      </td>
                      <td className="p-2">
                        <div className="flex flex-wrap items-center gap-1" onClick={(e) => e.stopPropagation()}>
                          <Button size="sm" variant="ghost" onClick={() => setOpenId(r.id)} className="gap-1">
                            <FileText className="h-4 w-4" /> {tr("action.view")}
                          </Button>
                          {r.status === "active" && (
                            <Button size="sm" variant="ghost" onClick={() => endMut.mutate(r.id)}
                                    disabled={endMut.isPending}
                                    className="gap-1 text-rose-600 hover:text-rose-700">
                              <StopCircle className="h-4 w-4" /> {tr("action.end")}
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" onClick={() => { setOpenId(r.id); reportMut.mutate(r.id); }}
                                  disabled={reportMut.isPending}
                                  className="gap-1 text-violet-600 hover:text-violet-700">
                            <Sparkles className="h-4 w-4" /> {tr("action.report")}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Detail dialog */}
      <Dialog open={openId !== null} onOpenChange={(o) => !o && setOpenId(null)}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col" dir={isRtl ? "rtl" : "ltr"}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-primary" />
              {tr("dialog.title")}
              {detail && (
                <Badge variant="outline" className={
                  detail.session.status === "active"
                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                    : "bg-gray-50 text-gray-700 border-gray-200"
                }>
                  {tr(`status.${detail.session.status}`)}
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              {detail
                ? `${detail.session.username ?? `#${detail.session.userId}`} • ${fmtDate(detail.session.startedAt, locale)} → ${detail.session.endedAt ? fmtDate(detail.session.endedAt, locale) : tr("ongoing")} • ${detail.durationLabel}`
                : tr("dialog.loading")}
            </DialogDescription>
          </DialogHeader>

          {detailLoading || !detail ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : (
            <ScrollArea className="flex-1 pr-2">
              <div className="space-y-4">
                {/* Report block */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-semibold flex items-center gap-1">
                      <Sparkles className="h-4 w-4 text-violet-600" />
                      {tr("dialog.aiReport")}
                    </h3>
                    <Button size="sm" variant="outline" onClick={() => reportMut.mutate(detail.session.id)}
                            disabled={reportMut.isPending} className="gap-1"
                            data-testid="button-generate-report">
                      {reportMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                      {detail.session.aiReport ? tr("dialog.regenerate") : tr("dialog.generate")}
                    </Button>
                  </div>
                  {detail.session.aiReport ? (
                    <>
                      {detail.session.aiReportGeneratedAt && (
                        <div className="text-xs text-muted-foreground mb-2">
                          {tr("dialog.generatedAt")}: {fmtDate(detail.session.aiReportGeneratedAt, locale)}
                        </div>
                      )}
                      <div
                        className="prose prose-sm max-w-none rounded border border-border bg-card p-3 leading-7"
                        dangerouslySetInnerHTML={{ __html: reportHtml }}
                        data-testid="text-ai-report"
                      />
                    </>
                  ) : (
                    <div className="text-sm text-muted-foreground border border-dashed border-border rounded p-4 text-center">
                      {tr("dialog.noReportYet")}
                    </div>
                  )}
                </div>

                {/* Activity timeline preview */}
                <div>
                  <h3 className="font-semibold mb-2 flex items-center gap-1">
                    <Activity className="h-4 w-4" />
                    {tr("dialog.activity")} ({detail.activityCount})
                  </h3>
                  {detail.activity.length === 0 ? (
                    <div className="text-sm text-muted-foreground">{tr("dialog.noActivity")}</div>
                  ) : (
                    <ul className="space-y-1 text-xs">
                      {detail.activity.slice(0, 50).map(a => (
                        <li key={a.id} className="flex flex-wrap items-center gap-2 border-b border-border/50 py-1">
                          <span className="text-muted-foreground whitespace-nowrap tabular-nums">
                            {new Date(a.createdAt).toLocaleTimeString(locale)}
                          </span>
                          <Badge variant="outline" className="text-[10px]">{a.module}</Badge>
                          <span className="font-mono">{a.action}</span>
                          {a.entityType && <span className="text-muted-foreground">[{a.entityType}{a.entityId ? `#${a.entityId}` : ""}]</span>}
                          {a.statusCode && a.statusCode >= 400 && (
                            <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200 text-[10px]">
                              {a.statusCode}
                            </Badge>
                          )}
                        </li>
                      ))}
                      {detail.activity.length > 50 && (
                        <li className="text-muted-foreground italic pt-1">
                          {tr("dialog.moreShown", { shown: 50, total: detail.activity.length })}
                        </li>
                      )}
                    </ul>
                  )}
                </div>
              </div>
            </ScrollArea>
          )}

          <DialogFooter>
            {detail?.session.status === "active" && (
              <Button variant="outline" onClick={() => endMut.mutate(detail.session.id)}
                      disabled={endMut.isPending}
                      className="gap-1 text-rose-600 hover:text-rose-700">
                <StopCircle className="h-4 w-4" />
                {tr("action.end")}
              </Button>
            )}
            <Button variant="secondary" onClick={() => setOpenId(null)}>{tr("close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatTile({ label, value, accent }: { label: string; value: number | string; accent: "emerald" | "sky" | "violet" }) {
  const cls = {
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
    sky:     "border-sky-200 bg-sky-50 text-sky-700",
    violet:  "border-violet-200 bg-violet-50 text-violet-700",
  }[accent];
  return (
    <div className={`rounded border ${cls} p-4`}>
      <div className="text-xs uppercase opacity-80">{label}</div>
      <div className="text-3xl font-bold tabular-nums mt-1">{value}</div>
    </div>
  );
}
