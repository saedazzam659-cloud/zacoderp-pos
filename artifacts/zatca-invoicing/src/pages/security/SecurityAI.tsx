import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Sparkles, Activity, Flame, ListChecks, RefreshCw, PlayCircle, Send,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectTrigger, SelectContent, SelectItem, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  securityAiApi,
  securityReportsApi,
} from "@/lib/securityAiApi";
import { securityEventsApi } from "@/lib/securityEventsApi";

const MODULE_TONE: Record<string, string> = {
  hr:         "bg-sky-100 text-sky-900 border-sky-200",
  production: "bg-violet-100 text-violet-900 border-violet-200",
  inventory:  "bg-amber-100 text-amber-900 border-amber-200",
  branch:     "bg-rose-100 text-rose-900 border-rose-200",
  none:       "bg-slate-100 text-slate-700 border-slate-200",
};
const LEVEL_TONE: Record<string, string> = {
  low:      "bg-slate-100 text-slate-800",
  medium:   "bg-amber-100 text-amber-900",
  high:     "bg-orange-100 text-orange-900",
  critical: "bg-rose-100 text-rose-900",
};

export default function SecurityAI() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [days, setDays] = useState(30);

  const insightsQ = useQuery({
    queryKey: ["security-ai", "insights", days],
    queryFn: () => securityAiApi.insights(days),
  });
  const heatQ = useQuery({
    queryKey: ["security-ai", "heatmap", days],
    queryFn: () => securityAiApi.heatmap(days),
  });
  const actionsQ = useQuery({
    queryKey: ["security-ai", "actions"],
    queryFn: () => securityAiApi.actions(),
  });
  const eventsQ = useQuery({
    queryKey: ["security-events", "recent-for-ai"],
    queryFn: () => securityEventsApi.list({ status: "open" }),
  });
  const summaryQ = useQuery({
    queryKey: ["security-reports", "actions-summary", days],
    queryFn: () => securityReportsApi.actionsSummary(days),
  });

  const evalM = useMutation({
    mutationFn: () => securityAiApi.evaluateRules(),
    onSuccess: (r) => {
      toast({ title: t("security.ai.evaluated"), description: t("security.ai.generatedN", { n: r.generated }) });
      qc.invalidateQueries({ queryKey: ["security-events"] });
      qc.invalidateQueries({ queryKey: ["security-ai"] });
    },
    onError: (e: any) => toast({ title: t("common.error"), description: e?.message, variant: "destructive" }),
  });

  const ins = insightsQ.data;
  const heat = heatQ.data;
  const events = (eventsQ.data ?? []).slice(0, 12);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-violet-600" />
            {t("security.ai.title")}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Select value={String(days)} onValueChange={v => setDays(Number(v))}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="7">{t("security.ai.last7")}</SelectItem>
                <SelectItem value="30">{t("security.ai.last30")}</SelectItem>
                <SelectItem value="90">{t("security.ai.last90")}</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => { insightsQ.refetch(); heatQ.refetch(); actionsQ.refetch(); }}>
              <RefreshCw className="w-4 h-4" />
            </Button>
            <Button size="sm" onClick={() => evalM.mutate()} disabled={evalM.isPending}>
              <PlayCircle className="w-4 h-4 me-1" />
              {evalM.isPending ? t("security.ai.evaluating") : t("security.ai.evaluateRules")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label={t("security.ai.totalEvents")} value={ins?.total ?? 0} tone="bg-rose-100 text-rose-900" />
            <Stat label={t("security.ai.mttr")} value={ins?.mttrHours == null ? "—" : `${ins.mttrHours}h`} tone="bg-sky-100 text-sky-900" />
            <Stat label={t("security.ai.aiSourced")} value={ins?.bySource?.find(s => s.k === "ai")?.c ?? 0} tone="bg-violet-100 text-violet-900" />
            <Stat label={t("security.ai.actionsTaken")} value={(ins?.actionsBy ?? []).reduce((a, b) => a + Number(b.c), 0)} tone="bg-emerald-100 text-emerald-900" />
          </div>
        </CardContent>
      </Card>

      {/* Insights row */}
      <div className="grid md:grid-cols-3 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Flame className="w-4 h-4 text-rose-600" />{t("security.ai.byModule")}</CardTitle></CardHeader>
          <CardContent>
            <ChipList items={(ins?.byModule ?? []).map(x => ({ label: t(`security.module.${x.k}`), count: Number(x.c), tone: MODULE_TONE[x.k] }))} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Activity className="w-4 h-4 text-violet-600" />{t("security.ai.bySource")}</CardTitle></CardHeader>
          <CardContent>
            <ChipList items={(ins?.bySource ?? []).map(x => ({ label: t(`security.source.${x.k}`), count: Number(x.c) }))} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm flex items-center gap-2"><ListChecks className="w-4 h-4 text-amber-600" />{t("security.ai.topTypes")}</CardTitle></CardHeader>
          <CardContent>
            <ChipList items={(ins?.topTypes ?? []).map(x => ({ label: String(t(`security.type.${x.k}`, { defaultValue: x.k })), count: Number(x.c) }))} />
          </CardContent>
        </Card>
      </div>

      {/* Heatmap */}
      <Card>
        <CardHeader><CardTitle className="text-sm">{t("security.ai.heatmap")}</CardTitle></CardHeader>
        <CardContent>
          {heat ? <Heatmap grid={heat.grid} /> : <div className="text-muted-foreground text-sm">…</div>}
        </CardContent>
      </Card>

      {/* Recommended actions for open events */}
      <Card>
        <CardHeader><CardTitle className="text-sm">{t("security.ai.openEventsRec")}</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {events.length === 0 && <div className="text-muted-foreground text-sm">{t("security.ai.noOpen")}</div>}
          {events.map(ev => <EventRow key={ev.id} event={ev} />)}
        </CardContent>
      </Card>

      {/* Actions log */}
      <Card>
        <CardHeader><CardTitle className="text-sm">{t("security.ai.actionsLog")}</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground">
                <th className="p-2 text-start">{t("security.ai.col.when")}</th>
                <th className="p-2 text-start">{t("security.ai.col.kind")}</th>
                <th className="p-2 text-start">{t("security.ai.col.module")}</th>
                <th className="p-2 text-start">{t("security.ai.col.title")}</th>
                <th className="p-2 text-start">{t("security.ai.col.event")}</th>
              </tr>
            </thead>
            <tbody>
              {(actionsQ.data ?? []).slice(0, 30).map(a => (
                <tr key={a.id} className="border-t">
                  <td className="p-2 text-xs">{new Date(a.createdAt).toLocaleString("ar-SA")}</td>
                  <td className="p-2"><Badge variant="outline">{String(t(`security.ai.kind.${a.kind}`, { defaultValue: a.kind }))}</Badge></td>
                  <td className="p-2"><Badge className={MODULE_TONE[a.targetModule] ?? ""} variant="outline">{t(`security.module.${a.targetModule}`)}</Badge></td>
                  <td className="p-2">{a.title}</td>
                  <td className="p-2 font-mono text-xs">#{a.eventId ?? "—"}</td>
                </tr>
              ))}
              {(actionsQ.data ?? []).length === 0 && (
                <tr><td colSpan={5} className="p-4 text-center text-muted-foreground">{t("security.ai.noActions")}</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: any; tone: string }) {
  return (
    <div className={`rounded-md p-4 text-center ${tone}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs opacity-90 mt-1">{label}</div>
    </div>
  );
}
function ChipList({ items }: { items: Array<{ label: string; count: number; tone?: string }> }) {
  if (items.length === 0) return <div className="text-muted-foreground text-sm">—</div>;
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((it, i) => (
        <Badge key={i} variant="outline" className={it.tone ?? "bg-slate-50"}>
          <span className="font-mono me-1">{it.count}</span>{it.label}
        </Badge>
      ))}
    </div>
  );
}
function Heatmap({ grid }: { grid: number[][] }) {
  const max = Math.max(1, ...grid.flat());
  const days = ["أحد", "إثن", "ثلا", "أرب", "خمي", "جمع", "سبت"];
  return (
    <div className="overflow-x-auto">
      <div className="inline-block">
        <div className="grid" style={{ gridTemplateColumns: `40px repeat(24, 22px)` }}>
          <div />
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="text-[10px] text-muted-foreground text-center">{h}</div>
          ))}
          {grid.map((row, d) => (
            <Fragment key={d}>
              <div className="text-[11px] text-muted-foreground self-center pe-2">{days[d]}</div>
              {row.map((v, h) => {
                const a = v / max;
                const bg = v === 0 ? "rgb(241, 245, 249)" : `rgba(225, 29, 72, ${0.15 + a * 0.85})`;
                return (
                  <div
                    key={`${d}-${h}`}
                    className="w-[22px] h-[22px] rounded-sm m-[1px]"
                    title={`${days[d]} ${h}:00 → ${v}`}
                    style={{ backgroundColor: bg }}
                  />
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

function EventRow({ event }: { event: any }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [analysis, setAnalysis] = useState<any>(null);

  const analyzeM = useMutation({
    mutationFn: () => securityAiApi.analyze(event.id),
    onSuccess: (r) => setAnalysis(r),
    onError: (e: any) => toast({ title: t("common.error"), description: e?.message, variant: "destructive" }),
  });
  const dispatchM = useMutation({
    mutationFn: (a: any) => securityAiApi.dispatch({
      eventId: event.id,
      kind: a.kind,
      targetModule: a.targetModule,
      title: a.title,
      details: a.details,
    }),
    onSuccess: () => {
      toast({ title: t("security.ai.dispatched") });
      qc.invalidateQueries({ queryKey: ["security-ai", "actions"] });
    },
    onError: (e: any) => toast({ title: t("common.error"), description: e?.message, variant: "destructive" }),
  });

  return (
    <div className="border rounded-md p-3 bg-white">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium truncate">{event.title}</div>
          <div className="text-xs text-muted-foreground">
            {String(t(`security.type.${event.eventType}`, { defaultValue: event.eventType }))} · {new Date(event.eventDateTime).toLocaleString("ar-SA")}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {analysis && (
            <>
              <Badge className={LEVEL_TONE[analysis.level]} variant="outline">
                {t(`security.severity.${analysis.level}`)} · {analysis.riskScore}
              </Badge>
              <Badge className={MODULE_TONE[analysis.action.targetModule] ?? ""} variant="outline">
                {t(`security.module.${analysis.action.targetModule}`)}
              </Badge>
            </>
          )}
          <Button size="sm" variant="outline" onClick={() => analyzeM.mutate()} disabled={analyzeM.isPending}>
            <Sparkles className="w-4 h-4 me-1" />
            {analyzeM.isPending ? t("security.ai.analyzing") : t("security.ai.analyze")}
          </Button>
          {analysis && (
            <Button size="sm" onClick={() => dispatchM.mutate(analysis.action)} disabled={dispatchM.isPending}>
              <Send className="w-4 h-4 me-1" />
              {t("security.ai.dispatch")}
            </Button>
          )}
        </div>
      </div>
      {analysis && (
        <div className="mt-2 text-xs bg-violet-50 border border-violet-100 rounded p-2 space-y-1">
          <div><strong>{t("security.ai.action")}:</strong> {String(t(`security.ai.kind.${analysis.action.kind}`, { defaultValue: analysis.action.kind }))} — {analysis.action.title}</div>
          <div className="text-muted-foreground">{analysis.action.details}</div>
          {analysis.reasons?.length > 0 && (
            <div className="text-muted-foreground">
              <strong>{t("security.ai.reasons")}:</strong> {analysis.reasons.join(" · ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
