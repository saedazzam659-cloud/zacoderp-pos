import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  BadgeCheck, Sparkles, Loader2, Wallet, TrendingUp, Receipt,
  Target, Percent, Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import ExportButtons from "@/components/ExportButtons";
import type { ExportColumn } from "@/lib/export";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Rep = {
  id: number;
  code: string;
  nameAr: string;
  nameEn: string | null;
  region: string | null;
  isActive: boolean;
  commissionPct: string;
  commissionType: "invoice" | "collection";
  monthlyTarget: string;
};

type CommissionDetail = {
  rep: {
    id: number; code: string; nameAr: string; nameEn: string | null;
    region: string | null; commissionPct: number;
    commissionType: "invoice" | "collection";
    monthlyTarget: number; isActive: boolean;
  };
  window: { from: string | null; to: string | null };
  summary: {
    invoiceCount: number;
    totalSales: number;
    totalCommissionRaw: number;
    totalCollected: number;
    effectiveCommission: number;
    avgInvoiceValue: number;
    targetAchievedPct: number | null;
  };
  invoices: Array<{
    id: number; invoiceNumber: string | null; invoiceDate: string;
    customerName: string; totalAmount: number;
    commissionPct: number; commissionAmount: number;
  }>;
  collections: Array<{ id: number; date: string; amount: number }>;
};

const todayISO = () => new Date().toISOString().slice(0, 10);
const monthStartISO = () => {
  const d = new Date(); d.setDate(1);
  return d.toISOString().slice(0, 10);
};
const fmtSAR = (n: number) =>
  new Intl.NumberFormat("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0);

// Lightweight markdown → HTML for AI panel. Supports headings, bold, lists.
function renderMarkdown(md: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = md.split("\n");
  const out: string[] = [];
  let inList = false;
  const flush = () => { if (inList) { out.push("</ul>"); inList = false; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); out.push(""); continue; }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^####\s+(.*)$/))) { flush(); out.push(`<h4 class="text-sm font-bold mt-3 mb-1 text-primary">${esc(m[1])}</h4>`); continue; }
    if ((m = line.match(/^###\s+(.*)$/)))  { flush(); out.push(`<h3 class="text-base font-bold mt-3 mb-2 text-primary">${esc(m[1])}</h3>`); continue; }
    if ((m = line.match(/^##\s+(.*)$/)))   { flush(); out.push(`<h2 class="text-lg font-bold mt-4 mb-2 text-primary">${esc(m[1])}</h2>`); continue; }
    if ((m = line.match(/^#\s+(.*)$/)))    { flush(); out.push(`<h1 class="text-xl font-bold mt-4 mb-2 text-primary">${esc(m[1])}</h1>`); continue; }
    if (line.match(/^\s*[-*]\s+/)) {
      if (!inList) { out.push(`<ul class="list-disc pr-5 space-y-1 my-2">`); inList = true; }
      const item = line.replace(/^\s*[-*]\s+/, "");
      out.push(`<li>${esc(item).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")}</li>`);
      continue;
    }
    flush();
    out.push(`<p class="my-2 leading-relaxed">${esc(line).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")}</p>`);
  }
  flush();
  return out.join("\n");
}

export default function SalesRepCommissions() {
  const { t, i18n } = useTranslation();
  const tr = (k: string, opts?: any): string => t(`salesRepCommissions.${k}`, opts) as string;
  const isAr = i18n.language?.startsWith("ar");
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [repId, setRepId] = useState<string>("");
  const [from, setFrom] = useState<string>(monthStartISO());
  const [to, setTo] = useState<string>(todayISO());
  const [aiOpen, setAiOpen] = useState(false);
  const [aiText, setAiText] = useState<string>("");

  const repsQ = useQuery<Rep[]>({
    queryKey: ["sales-reps-active", cid],
    enabled: !!cid,
    queryFn: async () => {
      const r = await fetch(`${API}/api/sales-reps/active?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });

  const detailQ = useQuery<CommissionDetail>({
    queryKey: ["sales-rep-commission", cid, repId, from, to],
    enabled: !!cid && !!repId,
    queryFn: async () => {
      const qs = new URLSearchParams({ companyId: String(cid) });
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      const r = await fetch(`${API}/api/sales-reps/${repId}/commission-detail?${qs.toString()}`, { headers });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "failed");
      }
      return r.json();
    },
  });

  const aiMut = useMutation({
    mutationFn: async () => {
      const qs = new URLSearchParams({ companyId: String(cid) });
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      const r = await fetch(`${API}/api/sales-reps/${repId}/ai-commission?${qs.toString()}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "AI failed");
      }
      return r.json() as Promise<{ analysis: string }>;
    },
    onSuccess: (d) => { setAiText(d.analysis || ""); setAiOpen(true); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const detail = detailQ.data;

  const repOptions = useMemo(() => repsQ.data ?? [], [repsQ.data]);

  // Columns + rows + totals for the unified Excel / PDF / Print export.
  const exportColumns: ExportColumn[] = useMemo(() => ([
    { header: "#",                  key: "idx",          width: 5  },
    { header: tr("invoiceNumber"),  key: "invoiceNumber",width: 16 },
    { header: tr("invoiceDate"),    key: "invoiceDate",  width: 12 },
    { header: tr("customer"),       key: "customer",     width: 28 },
    { header: tr("totalAmount"),    key: "totalAmount",  width: 14 },
    { header: tr("commPct"),        key: "commPct",      width: 10 },
    { header: tr("commAmount"),     key: "commAmount",   width: 14 },
  ]), [i18n.language]);

  const exportRows = useMemo(() => {
    if (!detail) return [];
    return detail.invoices.map((i, idx) => ({
      idx:           idx + 1,
      invoiceNumber: i.invoiceNumber ?? `#${i.id}`,
      invoiceDate:   i.invoiceDate,
      customer:      i.customerName,
      totalAmount:   fmtSAR(i.totalAmount),
      commPct:       `${i.commissionPct}%`,
      commAmount:    fmtSAR(i.commissionAmount),
    }));
  }, [detail]);

  const totalsRow = useMemo(() => {
    if (!detail) return null;
    return {
      idx:         "",
      invoiceNumber: "",
      invoiceDate: "",
      customer:    tr("total"),
      totalAmount: fmtSAR(detail.summary.totalSales),
      commPct:     "",
      commAmount:  fmtSAR(detail.summary.totalCommissionRaw),
    };
  }, [detail, i18n.language]);

  const summaryFooter = useMemo(() => {
    if (!detail) return null;
    const items: Array<{ label: string; value: string; tone?: "default" | "primary" }> = [
      { label: tr("totalSales"),          value: `${fmtSAR(detail.summary.totalSales)} ${tr("sar")}` },
      { label: tr("effectiveCommission"), value: `${fmtSAR(detail.summary.effectiveCommission)} ${tr("sar")}`, tone: "primary" },
    ];
    if (detail.summary.totalCollected > 0 || detail.rep.commissionType === "collection") {
      items.push({ label: tr("collected"), value: `${fmtSAR(detail.summary.totalCollected)} ${tr("sar")}` });
    }
    if (detail.summary.targetAchievedPct != null) {
      items.push({ label: tr("targetAchieved"), value: `${detail.summary.targetAchievedPct}%` });
    }
    return items;
  }, [detail, i18n.language]);

  const exportTitle = detail
    ? `${tr("title")} — ${detail.rep.nameAr} (${detail.rep.code})`
    : tr("title");
  const exportSubtitle = detail ? `${tr("from")}: ${from}   ${tr("to")}: ${to}` : "";
  const exportFilename = detail
    ? `commission_${detail.rep.code}_${from}_${to}`
    : "commission";

  return (
    <div className="p-4 md:p-6 space-y-5" dir={isAr ? "rtl" : "ltr"}>
      {/* HERO */}
      <div className="rounded-2xl border bg-gradient-to-br from-primary/10 via-amber-50/40 to-emerald-50/40 p-5 md:p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 rounded-xl bg-primary/15 flex items-center justify-center">
              <BadgeCheck className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="text-xl md:text-2xl font-bold">{tr("title")}</h1>
              <p className="text-xs md:text-sm text-muted-foreground mt-0.5">{tr("subtitle")}</p>
            </div>
          </div>
          <Button
            disabled={!repId || aiMut.isPending}
            onClick={() => aiMut.mutate()}
            className="gap-2 bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-700 hover:to-fuchsia-700 text-white"
          >
            {aiMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {tr("aiAnalyze")}
          </Button>
        </div>

        {/* CONTROLS */}
        <div className="mt-5 grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">{tr("selectRep")}</Label>
            <Select value={repId} onValueChange={setRepId}>
              <SelectTrigger className="h-10 bg-card"><SelectValue placeholder={tr("selectRepPh")} /></SelectTrigger>
              <SelectContent>
                {repOptions.map(r => (
                  <SelectItem key={r.id} value={String(r.id)}>
                    {r.nameAr} {r.code ? <span className="text-muted-foreground text-xs">({r.code})</span> : null}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{tr("from")}</Label>
            <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="h-10 bg-card" dir="ltr" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{tr("to")}</Label>
            <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="h-10 bg-card" dir="ltr" />
          </div>
          <div className="flex items-end">
            <div className="w-full">
              <ExportButtons
                rows={exportRows}
                columns={exportColumns}
                filename={exportFilename}
                title={exportTitle}
                subtitle={exportSubtitle}
                disabled={!detail || exportRows.length === 0}
                totalsRow={totalsRow}
                summaryFooter={summaryFooter}
              />
            </div>
          </div>
        </div>
      </div>

      {/* EMPTY STATE */}
      {!repId && (
        <div className="rounded-xl border bg-card p-10 text-center">
          <Users className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">{tr("emptyHint")}</p>
        </div>
      )}

      {/* LOADING */}
      {repId && detailQ.isLoading && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[0,1,2,3].map(i => <Skeleton key={i} className="h-28 rounded-xl" />)}
        </div>
      )}

      {/* DETAIL */}
      {detail && (
        <>
          {/* REP META */}
          <div className="rounded-xl border bg-card p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold">
                {detail.rep.nameAr.slice(0, 1)}
              </div>
              <div>
                <div className="font-semibold">{detail.rep.nameAr} <span className="text-xs text-muted-foreground font-normal">({detail.rep.code})</span></div>
                <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap gap-x-3">
                  {detail.rep.region && <span>{tr("region")}: {detail.rep.region}</span>}
                  <span className={cn("inline-flex items-center gap-1 px-1.5 rounded",
                    detail.rep.commissionType === "invoice"
                      ? "bg-blue-50 text-blue-700"
                      : "bg-emerald-50 text-emerald-700"
                  )}>
                    <Percent className="h-3 w-3" />
                    {tr(detail.rep.commissionType === "invoice" ? "typeInvoice" : "typeCollection")} • {detail.rep.commissionPct}%
                  </span>
                  {detail.rep.monthlyTarget > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <Target className="h-3 w-3" /> {tr("target")}: {fmtSAR(detail.rep.monthlyTarget)} {tr("sar")}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* KPI CARDS */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard
              icon={<TrendingUp className="h-5 w-5" />}
              label={tr("totalSales")}
              value={`${fmtSAR(detail.summary.totalSales)} ${tr("sar")}`}
              hint={`${detail.summary.invoiceCount} ${tr("invoices")}`}
              tone="blue"
            />
            <KpiCard
              icon={<Wallet className="h-5 w-5" />}
              label={tr("effectiveCommission")}
              value={`${fmtSAR(detail.summary.effectiveCommission)} ${tr("sar")}`}
              hint={detail.rep.commissionType === "collection"
                ? `${tr("basedOnCollections")}`
                : `${tr("basedOnInvoices")}`}
              tone="emerald"
            />
            <KpiCard
              icon={<Receipt className="h-5 w-5" />}
              label={tr("avgInvoice")}
              value={`${fmtSAR(detail.summary.avgInvoiceValue)} ${tr("sar")}`}
              tone="amber"
            />
            <KpiCard
              icon={<Target className="h-5 w-5" />}
              label={tr("targetAchieved")}
              value={detail.summary.targetAchievedPct != null ? `${detail.summary.targetAchievedPct}%` : "—"}
              hint={detail.rep.monthlyTarget > 0 ? `${tr("of")} ${fmtSAR(detail.rep.monthlyTarget)}` : tr("noTarget")}
              tone={detail.summary.targetAchievedPct == null ? "gray"
                : detail.summary.targetAchievedPct >= 100 ? "emerald"
                : detail.summary.targetAchievedPct >= 60 ? "amber" : "red"}
            />
          </div>

          {/* COLLECTIONS BAR (only for collection-type or when there are collections) */}
          {(detail.summary.totalCollected > 0 || detail.rep.commissionType === "collection") && (
            <div className="rounded-xl border bg-card p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{tr("collected")}</span>
                <span className="font-semibold">{fmtSAR(detail.summary.totalCollected)} {tr("sar")}</span>
              </div>
              {detail.summary.totalSales > 0 && (
                <>
                  <div className="mt-2 h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-emerald-500"
                      style={{ width: `${Math.min(100, (detail.summary.totalCollected / detail.summary.totalSales) * 100)}%` }}
                    />
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-1">
                    {tr("collectionRate")}: {((detail.summary.totalCollected / detail.summary.totalSales) * 100).toFixed(1)}%
                  </div>
                </>
              )}
            </div>
          )}

          {/* INVOICE TABLE */}
          <div className="rounded-xl border bg-card overflow-hidden">
            <div className="px-4 py-3 border-b bg-muted/30 flex items-center justify-between">
              <div className="font-semibold text-sm">{tr("invoiceBreakdown")}</div>
              <div className="text-xs text-muted-foreground">{detail.invoices.length} {tr("rows")}</div>
            </div>
            {detail.invoices.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">{tr("noInvoices")}</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/40 text-xs text-muted-foreground">
                      <th className="text-start p-2 w-10">#</th>
                      <th className="text-start p-2">{tr("invoiceNumber")}</th>
                      <th className="text-start p-2">{tr("invoiceDate")}</th>
                      <th className="text-start p-2">{tr("customer")}</th>
                      <th className="text-end p-2">{tr("totalAmount")}</th>
                      <th className="text-end p-2">{tr("commPct")}</th>
                      <th className="text-end p-2">{tr("commAmount")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {detail.invoices.map((i, idx) => (
                      <tr key={i.id} className="hover:bg-muted/20">
                        <td className="p-2 text-muted-foreground">{idx + 1}</td>
                        <td className="p-2 font-mono text-xs">{i.invoiceNumber ?? `#${i.id}`}</td>
                        <td className="p-2 font-mono text-xs" dir="ltr">{i.invoiceDate}</td>
                        <td className="p-2">{i.customerName}</td>
                        <td className="p-2 text-end font-mono">{fmtSAR(i.totalAmount)}</td>
                        <td className="p-2 text-end font-mono text-muted-foreground">{i.commissionPct}%</td>
                        <td className="p-2 text-end font-mono font-semibold text-emerald-700">{fmtSAR(i.commissionAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-muted/30 font-semibold">
                      <td colSpan={4} className="p-2 text-end">{tr("total")}</td>
                      <td className="p-2 text-end font-mono">{fmtSAR(detail.summary.totalSales)}</td>
                      <td className="p-2"></td>
                      <td className="p-2 text-end font-mono text-emerald-700">{fmtSAR(detail.summary.totalCommissionRaw)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>

          {/* AI PANEL */}
          {aiOpen && aiText && (
            <div className="rounded-xl border bg-gradient-to-br from-violet-50 to-fuchsia-50 p-5 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2 font-semibold text-violet-900">
                  <Sparkles className="h-4 w-4" /> {tr("aiTitle")}
                </div>
                <Button variant="ghost" size="sm" onClick={() => setAiOpen(false)}>{tr("close")}</Button>
              </div>
              <div
                className="prose prose-sm max-w-none text-sm leading-7 text-foreground"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(aiText) }}
              />
              <div className="text-[10px] text-muted-foreground mt-3 text-end">{tr("aiDisclaimer")}</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function KpiCard({
  icon, label, value, hint, tone = "blue",
}: {
  icon: React.ReactNode; label: string; value: string; hint?: string;
  tone?: "blue" | "emerald" | "amber" | "red" | "gray";
}) {
  const tones: Record<string, string> = {
    blue:    "from-blue-50 to-blue-100/40 text-blue-700 ring-blue-200/60",
    emerald: "from-emerald-50 to-emerald-100/40 text-emerald-700 ring-emerald-200/60",
    amber:   "from-amber-50 to-amber-100/40 text-amber-800 ring-amber-200/60",
    red:     "from-red-50 to-red-100/40 text-red-700 ring-red-200/60",
    gray:    "from-muted to-muted/40 text-muted-foreground ring-border",
  };
  return (
    <div className={cn("rounded-xl bg-gradient-to-br p-4 ring-1 shadow-sm", tones[tone])}>
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium opacity-80">{label}</div>
        <div className="opacity-70">{icon}</div>
      </div>
      <div className="text-xl md:text-2xl font-bold mt-2 font-mono tabular-nums">{value}</div>
      {hint && <div className="text-[11px] opacity-70 mt-1">{hint}</div>}
    </div>
  );
}
