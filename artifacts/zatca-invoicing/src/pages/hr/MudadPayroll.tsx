import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { employeesApi } from "@/lib/employeesApi";
import { parseError } from "@/lib/parseError";
import { useToast } from "@/hooks/use-toast";
import { saveBlob } from "@/lib/saveFile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Field, FormGrid } from "@/components/FormPanel";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Landmark, Download, Send, Loader2, CheckCircle2, XCircle,
  BarChart3, FileSpreadsheet, Users, AlertTriangle,
} from "lucide-react";
import { useTranslation } from "react-i18next";

const REASON_CODES = [
  "not_sponsored", "irregular", "resigned", "suspended", "inactive",
  "iqama_expired", "work_permit_expired", "no_id", "no_iban", "bank_not_approved",
];

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-800">
      <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-700 dark:border-slate-700 dark:text-slate-200">
        {title}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

export default function MudadPayroll() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`hrPages.mudad.${k}`, opts) as string;

  const [tab, setTab] = useState("send");
  const [runId, setRunId] = useState<number | null>(null);
  const [mode, setMode] = useState<"sponsored_only" | "all">("sponsored_only");
  const [establishmentNumber, setEstablishmentNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [viewBatchId, setViewBatchId] = useState<number | null>(null);

  const reasonLabel = (code?: string | null) =>
    code ? (t(`hrPages.mudad.reason_${code}`) as string) : "";

  const fmt = (n: any) =>
    Number(n || 0).toLocaleString(isRtl ? "ar-EG" : "en-US", {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });

  // ─── Data ───────────────────────────────────────────────────────────────
  const { data: stats, isLoading: loadingStats } = useQuery<any>({
    queryKey: ["mudad-stats"], queryFn: () => employeesApi.mudadStats(),
  });
  const { data: runs = [] } = useQuery<any[]>({
    queryKey: ["payroll-runs"], queryFn: () => employeesApi.payrollRuns(),
  });
  const { data: preview, isFetching: loadingPreview } = useQuery<any>({
    queryKey: ["mudad-preview", runId, mode],
    queryFn: () => employeesApi.mudadPreview(runId!, mode),
    enabled: !!runId,
  });
  const { data: batches = [] } = useQuery<any[]>({
    queryKey: ["mudad-batches"], queryFn: () => employeesApi.mudadBatches(),
  });
  const { data: batch } = useQuery<any>({
    queryKey: ["mudad-batch", viewBatchId],
    queryFn: () => employeesApi.mudadBatch(viewBatchId!),
    enabled: !!viewBatchId,
  });

  const runItems = useMemo(
    () => runs.map((r: any) => ({
      value: String(r.id),
      label: `${r.code} — ${String(r.month).padStart(2, "0")}/${r.year}`,
    })), [runs]);

  // ─── WPS CSV export (client-side, UTF-8 BOM) ─────────────────────────────
  const buildCsv = (lines: any[]) => {
    const header = [
      tr("csvCode"), tr("csvName"), tr("csvId"), tr("csvIban"),
      tr("csvBank"), tr("csvNet"),
    ];
    const esc = (v: any) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = lines.map((l) => [
      l.employeeCode, l.employeeName, l.idNumber, l.iban, l.bankName,
      Number(l.netSalary || 0).toFixed(2),
    ].map(esc).join(","));
    return "\uFEFF" + [header.join(","), ...rows].join("\r\n");
  };

  const downloadWps = (code: string, lines: any[]) => {
    if (!lines.length) { toast({ title: tr("noIncluded"), variant: "destructive" }); return; }
    const blob = new Blob([buildCsv(lines)], { type: "text/csv;charset=utf-8;" });
    void saveBlob(blob, `${code}.csv`);
  };

  // ─── Create batch (persist snapshot) ─────────────────────────────────────
  const createBatch = useMutation({
    mutationFn: () => employeesApi.mudadCreateBatch({
      payrollRunId: runId!, mode,
      establishmentNumber: establishmentNumber.trim() || undefined,
      notes: notes.trim() || undefined,
    }),
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ["mudad-batches"] });
      qc.invalidateQueries({ queryKey: ["mudad-stats"] });
      toast({ title: tr("batchCreated", { code: res?.batch?.code }) });
      downloadWps(res?.batch?.code ?? "mudad", res?.includedLines ?? []);
      setTab("batches");
      setViewBatchId(res?.batch?.id ?? null);
    },
    onError: (e) => toast({ title: parseError(e), variant: "destructive" }),
  });

  const included = preview?.lines?.filter((l: any) => l.included) ?? [];
  const excluded = preview?.lines?.filter((l: any) => !l.included) ?? [];

  const StatCard = ({ icon: Icon, label, value, tone }: any) => (
    <div className={`rounded-xl border p-4 ${tone}`}>
      <div className="flex items-center gap-2 text-sm opacity-80"><Icon className="h-4 w-4" /> {label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
    </div>
  );

  return (
    <div className="p-4 md:p-6 space-y-5" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center gap-3">
        <div className="rounded-xl bg-emerald-100 p-2 text-emerald-700"><Landmark className="h-6 w-6" /></div>
        <div>
          <h1 className="text-xl font-bold">{tr("title")}</h1>
          <p className="text-sm text-muted-foreground">{tr("subtitle")}</p>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="send" className="gap-1.5"><Send className="h-4 w-4" /> {tr("tabSend")}</TabsTrigger>
          <TabsTrigger value="dashboard" className="gap-1.5"><BarChart3 className="h-4 w-4" /> {tr("tabDashboard")}</TabsTrigger>
          <TabsTrigger value="batches" className="gap-1.5"><FileSpreadsheet className="h-4 w-4" /> {tr("tabBatches")}</TabsTrigger>
        </TabsList>

        {/* ─── SEND ─────────────────────────────────────────────────────── */}
        <TabsContent value="send" className="space-y-4">
          <Section title={tr("sendTitle")}>
            <FormGrid>
              <Field label={tr("fRun")} required>
                <SearchCombobox
                  items={runItems}
                  value={runId ? String(runId) : ""}
                  onValueChange={(v) => setRunId(v ? Number(v) : null)}
                  placeholder={tr("fRunPh")}
                  className="w-full"
                />
              </Field>
              <Field label={tr("fMode")}>
                <SearchCombobox
                  items={[
                    { value: "sponsored_only", label: tr("modeSponsored") },
                    { value: "all",            label: tr("modeAll") },
                  ]}
                  value={mode}
                  onValueChange={(v) => setMode(v === "all" ? "all" : "sponsored_only")}
                  placeholder=""
                  className="w-full"
                />
              </Field>
              <Field label={tr("fEstablishment")}>
                <Input value={establishmentNumber} onChange={(e) => setEstablishmentNumber(e.target.value)} dir="ltr" placeholder={tr("fEstablishmentPh")} />
              </Field>
              <Field label={tr("fNotes")}>
                <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={1} />
              </Field>
            </FormGrid>
          </Section>

          {!runId ? (
            <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">{tr("pickRunHint")}</div>
          ) : loadingPreview ? (
            <Skeleton className="h-40 w-full" />
          ) : preview ? (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard icon={Users}       label={tr("sTotal")}    value={preview.summary.total}         tone="bg-slate-50 border-slate-200" />
                <StatCard icon={CheckCircle2} label={tr("sIncluded")} value={preview.summary.includedCount} tone="bg-emerald-50 border-emerald-200 text-emerald-800" />
                <StatCard icon={XCircle}     label={tr("sExcluded")} value={preview.summary.excludedCount} tone="bg-rose-50 border-rose-200 text-rose-800" />
                <StatCard icon={Landmark}    label={tr("sNet")}      value={fmt(preview.summary.totalNet)} tone="bg-sky-50 border-sky-200 text-sky-800" />
              </div>

              <div className="flex flex-wrap gap-2">
                <Button onClick={() => createBatch.mutate()} disabled={createBatch.isPending || included.length === 0}>
                  {createBatch.isPending ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <Send className="h-4 w-4 me-1" />}
                  {tr("btnGenerate")}
                </Button>
                <Button variant="outline" onClick={() => downloadWps(preview.run?.code ?? "mudad", included)} disabled={included.length === 0}>
                  <Download className="h-4 w-4 me-1" /> {tr("btnDownloadOnly")}
                </Button>
              </div>

              {/* Included */}
              <Section title={tr("includedTitle", { n: included.length })}>
                <LinesTable
                  lines={included} isRtl={isRtl} tr={tr} fmt={fmt} withReason={false} reasonLabel={reasonLabel}
                />
              </Section>

              {/* Excluded report */}
              <Section title={tr("excludedTitle", { n: excluded.length })}>
                {excluded.length === 0 ? (
                  <div className="p-4 text-center text-emerald-700 text-sm">{tr("noExcluded")}</div>
                ) : (
                  <LinesTable
                    lines={excluded} isRtl={isRtl} tr={tr} fmt={fmt} withReason reasonLabel={reasonLabel}
                  />
                )}
              </Section>
            </>
          ) : null}
        </TabsContent>

        {/* ─── DASHBOARD ────────────────────────────────────────────────── */}
        <TabsContent value="dashboard" className="space-y-4">
          {loadingStats ? (
            <Skeleton className="h-40 w-full" />
          ) : stats ? (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard icon={Users}        label={tr("dTotal")}     value={stats.employees.total}      tone="bg-slate-50 border-slate-200" />
                <StatCard icon={Users}        label={tr("dActive")}    value={stats.employees.active}     tone="bg-slate-50 border-slate-200" />
                <StatCard icon={CheckCircle2} label={tr("dEligible")}  value={stats.employees.eligible}   tone="bg-emerald-50 border-emerald-200 text-emerald-800" />
                <StatCard icon={AlertTriangle} label={tr("dIneligible")} value={stats.employees.ineligible} tone="bg-rose-50 border-rose-200 text-rose-800" />
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard icon={Landmark}      label={tr("dSponsored")} value={stats.employees.sponsored}  tone="bg-sky-50 border-sky-200 text-sky-800" />
                <StatCard icon={AlertTriangle} label={tr("dIrregular")} value={stats.employees.irregular}  tone="bg-amber-50 border-amber-200 text-amber-800" />
                <StatCard icon={FileSpreadsheet} label={tr("dBatches")} value={stats.batches.count}        tone="bg-slate-50 border-slate-200" />
                <StatCard icon={Landmark}      label={tr("dBatchNet")}  value={fmt(stats.batches.totalNet)} tone="bg-sky-50 border-sky-200 text-sky-800" />
              </div>

              <Section title={tr("reasonBreakdownTitle")}>
                {Object.keys(stats.employees.reasonBreakdown || {}).length === 0 ? (
                  <div className="p-4 text-center text-emerald-700 text-sm">{tr("allEligible")}</div>
                ) : (
                  <div className="space-y-2">
                    {REASON_CODES.filter((c) => stats.employees.reasonBreakdown[c]).map((c) => (
                      <div key={c} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
                        <span>{reasonLabel(c)}</span>
                        <Badge className="bg-rose-100 text-rose-700 border border-rose-200 hover:bg-rose-100">{stats.employees.reasonBreakdown[c]}</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </Section>
            </>
          ) : null}
        </TabsContent>

        {/* ─── BATCHES ──────────────────────────────────────────────────── */}
        <TabsContent value="batches" className="space-y-4">
          <Section title={tr("batchesTitle")}>
            {batches.length === 0 ? (
              <div className="p-4 text-center text-muted-foreground text-sm">{tr("noBatches")}</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-start text-muted-foreground border-b">
                      <th className="p-2 text-start">{tr("bCode")}</th>
                      <th className="p-2 text-start">{tr("bPeriod")}</th>
                      <th className="p-2 text-start">{tr("bMode")}</th>
                      <th className="p-2 text-center">{tr("bIncluded")}</th>
                      <th className="p-2 text-center">{tr("bExcluded")}</th>
                      <th className="p-2 text-end">{tr("bNet")}</th>
                      <th className="p-2 text-center">{tr("bActions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batches.map((b: any) => (
                      <tr key={b.id} className="border-b hover:bg-muted/40">
                        <td className="p-2 font-medium">{b.code}</td>
                        <td className="p-2">{String(b.month).padStart(2, "0")}/{b.year}</td>
                        <td className="p-2">{b.sendMode === "all" ? tr("modeAll") : tr("modeSponsored")}</td>
                        <td className="p-2 text-center">{b.includedCount}</td>
                        <td className="p-2 text-center">{b.excludedCount}</td>
                        <td className="p-2 text-end">{fmt(b.totalNet)}</td>
                        <td className="p-2 text-center">
                          <Button size="sm" variant="ghost" onClick={() => setViewBatchId(b.id)}>{tr("bView")}</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {batch && (
            <Section title={tr("batchDetailTitle", { code: batch.code })}>
              <div className="flex flex-wrap gap-2 mb-3">
                <Button size="sm" variant="outline" onClick={() => downloadWps(batch.code, (batch.lines || []).filter((l: any) => l.included))}>
                  <Download className="h-4 w-4 me-1" /> {tr("btnDownloadFile")}
                </Button>
              </div>
              <div className="text-sm font-semibold mb-1">{tr("includedTitle", { n: (batch.lines || []).filter((l: any) => l.included).length })}</div>
              <LinesTable lines={(batch.lines || []).filter((l: any) => l.included)} isRtl={isRtl} tr={tr} fmt={fmt} withReason={false} reasonLabel={reasonLabel} />
              <div className="text-sm font-semibold mt-4 mb-1">{tr("excludedTitle", { n: (batch.lines || []).filter((l: any) => !l.included).length })}</div>
              <LinesTable lines={(batch.lines || []).filter((l: any) => !l.included)} isRtl={isRtl} tr={tr} fmt={fmt} withReason reasonLabel={reasonLabel} />
            </Section>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function LinesTable({ lines, isRtl, tr, fmt, withReason, reasonLabel }: any) {
  if (!lines.length) return <div className="p-3 text-center text-muted-foreground text-sm">—</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-muted-foreground border-b">
            <th className="p-2 text-start">{tr("csvCode")}</th>
            <th className="p-2 text-start">{tr("csvName")}</th>
            <th className="p-2 text-start">{tr("csvId")}</th>
            <th className="p-2 text-start">{tr("csvIban")}</th>
            <th className="p-2 text-end">{tr("csvNet")}</th>
            {withReason && <th className="p-2 text-start">{tr("colReason")}</th>}
          </tr>
        </thead>
        <tbody>
          {lines.map((l: any, i: number) => (
            <tr key={l.employeeId ?? i} className="border-b">
              <td className="p-2">{l.employeeCode}</td>
              <td className="p-2">{l.employeeName}</td>
              <td className="p-2" dir="ltr">{l.idNumber || "—"}</td>
              <td className="p-2" dir="ltr">{l.iban || "—"}</td>
              <td className="p-2 text-end">{fmt(l.netSalary)}</td>
              {withReason && (
                <td className="p-2">
                  <Badge className="bg-rose-100 text-rose-700 border border-rose-200 hover:bg-rose-100">{reasonLabel(l.excludedReason)}</Badge>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
