import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Loader2, Mail, Plus, Save, Send, X, AlertCircle, CheckCircle2, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";

interface ReportOption { key: string; label: string }
interface ScheduleConfig {
  enabled: boolean;
  reports: string[];
  frequency: "weekly" | "monthly";
  recipients: string[];
  lastSentAt: string | null;
  lastStatus: "ok" | "failed" | "no_data" | "skipped" | null;
  lastError: string | null;
  lastReports: string[];
  lastRecipients: number | null;
}
interface RunRow {
  id: number;
  ranAt: string;
  trigger: "scheduled" | "manual";
  status: "ok" | "failed" | "no_data" | "skipped";
  reports: string[];
  recipients: number;
  message: string | null;
}
interface ScheduleResp {
  schedule: ScheduleConfig;
  availableReports: ReportOption[];
  smtpConfigured: boolean;
  history: RunRow[];
}

const STATUS_LABELS: Record<RunRow["status"], { ar: string; tone: string }> = {
  ok:        { ar: "تم الإرسال",      tone: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  failed:    { ar: "فشل",            tone: "bg-rose-100 text-rose-800 border-rose-200" },
  no_data:   { ar: "بدون بيانات",     tone: "bg-amber-100 text-amber-800 border-amber-200" },
  skipped:   { ar: "تم التخطي",       tone: "bg-slate-100 text-slate-700 border-slate-200" },
};

const fmtDateTime = (iso: string | null) => {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString("ar-SA"); }
  catch { return iso; }
};

export default function EmailScheduleSection() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery<ScheduleResp>({
    queryKey: ["report-email-schedule"],
    queryFn: async () => {
      const r = await fetch("/api/admin/reports/email-schedule", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "تعذر تحميل الإعدادات");
      return r.json();
    },
    refetchOnWindowFocus: false,
  });

  // Local edit buffer; reset whenever the server snapshot changes so the form
  // reflects the latest persisted values without dropping in-flight edits.
  const [enabled, setEnabled] = useState(false);
  const [reports, setReports] = useState<string[]>([]);
  const [frequency, setFrequency] = useState<"weekly" | "monthly">("weekly");
  const [recipients, setRecipients] = useState<string[]>([]);
  const [emailDraft, setEmailDraft] = useState("");

  useEffect(() => {
    if (!data?.schedule) return;
    setEnabled(data.schedule.enabled);
    setReports(data.schedule.reports);
    setFrequency(data.schedule.frequency);
    setRecipients(data.schedule.recipients);
  }, [data?.schedule]);

  const dirty = useMemo(() => {
    if (!data?.schedule) return false;
    const s = data.schedule;
    if (s.enabled !== enabled) return true;
    if (s.frequency !== frequency) return true;
    if (s.reports.length !== reports.length || s.reports.some(k => !reports.includes(k))) return true;
    if (s.recipients.length !== recipients.length || s.recipients.some(e => !recipients.includes(e))) return true;
    return false;
  }, [data?.schedule, enabled, frequency, reports, recipients]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/admin/reports/email-schedule", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, reports, frequency, recipients }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? "تعذر الحفظ");
      return body;
    },
    onSuccess: () => {
      toast({ title: "تم الحفظ", description: "تم تحديث جدولة التقارير." });
      qc.invalidateQueries({ queryKey: ["report-email-schedule"] });
    },
    onError: (e: Error) => {
      toast({ title: "تعذر الحفظ", description: e.message, variant: "destructive" });
    },
  });

  const runNowMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/admin/reports/email-schedule/run-now", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? "تعذر الإرسال");
      return body as { ok: boolean; outcome: { status: RunRow["status"]; message: string } };
    },
    onSuccess: (res) => {
      const ok = res.outcome.status === "ok";
      toast({
        title: ok ? "تم الإرسال" : "لم يكتمل الإرسال",
        description: res.outcome.message,
        variant: ok ? "default" : "destructive",
      });
      qc.invalidateQueries({ queryKey: ["report-email-schedule"] });
    },
    onError: (e: Error) => {
      toast({ title: "فشل الإرسال", description: e.message, variant: "destructive" });
    },
  });

  function addEmail() {
    const v = emailDraft.trim().toLowerCase();
    if (!v) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
      toast({ title: "بريد غير صالح", description: v, variant: "destructive" });
      return;
    }
    if (recipients.includes(v)) {
      setEmailDraft("");
      return;
    }
    setRecipients([...recipients, v]);
    setEmailDraft("");
  }
  function removeEmail(e: string) {
    setRecipients(recipients.filter(x => x !== e));
  }
  function toggleReport(key: string) {
    setReports(reports.includes(key) ? reports.filter(k => k !== key) : [...reports, key]);
  }

  if (isLoading) {
    return (
      <div className="border rounded-xl p-6 bg-card flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="border rounded-xl p-4 bg-rose-50 border-rose-200 text-rose-800 text-sm">
        {(error as Error).message}
      </div>
    );
  }
  if (!data) return null;

  const reportLabel = (k: string) => data.availableReports.find(r => r.key === k)?.label ?? k;

  return (
    <div className="border rounded-xl bg-card overflow-hidden" data-testid="email-schedule-section">
      <div className="p-5 border-b bg-muted/30 flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-bold flex items-center gap-2">
            <CalendarClock className="h-5 w-5 text-primary" /> الإرسال المجدول للتقارير
          </h2>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed max-w-2xl">
            أرسل خلاصة دورية بالبريد للمستلمين المحددين، تحتوي على ملفات CSV من تقارير المشرف العام.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{enabled ? "مفعّل" : "متوقف"}</span>
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            data-testid="schedule-enabled-switch"
          />
        </div>
      </div>

      {!data.smtpConfigured && (
        <div className="m-4 p-3 rounded border border-amber-300 bg-amber-50 text-amber-900 text-sm flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <div>
            <div className="font-semibold">إعدادات SMTP غير مكتملة</div>
            <div className="text-xs mt-0.5">يلزم ضبط متغيرات SMTP_HOST و SMTP_USER و SMTP_PASS قبل أن يتمكن النظام من الإرسال الفعلي.</div>
          </div>
        </div>
      )}

      <div className="p-5 grid gap-5 lg:grid-cols-2">
        {/* Reports */}
        <div className="space-y-2">
          <label className="text-sm font-semibold flex items-center gap-1">
            التقارير المُرفقة
            <span className="text-xs font-normal text-muted-foreground">(CSV)</span>
          </label>
          <div className="border rounded-lg divide-y">
            {data.availableReports.map(r => {
              const checked = reports.includes(r.key);
              return (
                <label
                  key={r.key}
                  className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-muted/40"
                  data-testid={`report-toggle-${r.key}`}
                >
                  <Checkbox checked={checked} onCheckedChange={() => toggleReport(r.key)} />
                  <span className="text-sm">{r.label}</span>
                </label>
              );
            })}
          </div>
        </div>

        {/* Frequency */}
        <div className="space-y-2">
          <label className="text-sm font-semibold">تكرار الإرسال</label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setFrequency("weekly")}
              className={`border rounded-lg p-3 text-sm text-right transition ${
                frequency === "weekly" ? "border-primary bg-primary/5 font-semibold" : "hover:bg-muted/40"
              }`}
              data-testid="frequency-weekly"
            >
              <div>أسبوعي</div>
              <div className="text-xs text-muted-foreground mt-0.5">كل 7 أيام</div>
            </button>
            <button
              type="button"
              onClick={() => setFrequency("monthly")}
              className={`border rounded-lg p-3 text-sm text-right transition ${
                frequency === "monthly" ? "border-primary bg-primary/5 font-semibold" : "hover:bg-muted/40"
              }`}
              data-testid="frequency-monthly"
            >
              <div>شهري</div>
              <div className="text-xs text-muted-foreground mt-0.5">كل 30 يومًا</div>
            </button>
          </div>
        </div>

        {/* Recipients */}
        <div className="space-y-2 lg:col-span-2">
          <label className="text-sm font-semibold flex items-center gap-1">
            <Mail className="h-4 w-4" /> المستلمون
            <span className="text-xs font-normal text-muted-foreground">({recipients.length})</span>
          </label>
          <div className="flex gap-2">
            <Input
              type="email"
              dir="ltr"
              placeholder="example@domain.com"
              value={emailDraft}
              onChange={(e) => setEmailDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addEmail(); } }}
              data-testid="recipient-input"
            />
            <Button type="button" variant="outline" onClick={addEmail} data-testid="recipient-add">
              <Plus className="h-4 w-4 ml-1" /> إضافة
            </Button>
          </div>
          {recipients.length > 0 ? (
            <div className="flex flex-wrap gap-2 pt-1" data-testid="recipient-chips">
              {recipients.map(e => (
                <Badge key={e} variant="secondary" className="gap-1 pl-1.5 text-xs" dir="ltr">
                  {e}
                  <button
                    type="button"
                    onClick={() => removeEmail(e)}
                    className="rounded-full hover:bg-rose-200 p-0.5"
                    aria-label={`إزالة ${e}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">لم يُضف أي مستلم بعد.</p>
          )}
        </div>
      </div>

      {/* Actions + status */}
      <div className="p-4 border-t bg-muted/20 flex items-center justify-between flex-wrap gap-3">
        <div className="text-xs text-muted-foreground space-y-0.5">
          <div>
            آخر إرسال: <span className="font-semibold">{fmtDateTime(data.schedule.lastSentAt)}</span>
            {data.schedule.lastStatus && (
              <span className={`mr-2 inline-block px-2 py-0.5 rounded border text-[11px] ${STATUS_LABELS[data.schedule.lastStatus].tone}`}>
                {STATUS_LABELS[data.schedule.lastStatus].ar}
              </span>
            )}
          </div>
          {data.schedule.lastError && (
            <div className="text-rose-700">
              <AlertCircle className="inline h-3 w-3 ml-1" />
              {data.schedule.lastError}
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => runNowMutation.mutate()}
            disabled={runNowMutation.isPending || !data.smtpConfigured}
            data-testid="run-now"
          >
            {runNowMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin ml-1" /> : <Send className="h-4 w-4 ml-1" />}
            إرسال الآن
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || !dirty}
            data-testid="save-schedule"
          >
            {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin ml-1" /> : <Save className="h-4 w-4 ml-1" />}
            حفظ
          </Button>
        </div>
      </div>

      {/* History */}
      <div className="border-t">
        <div className="p-4 flex items-center gap-2 text-sm font-semibold">
          <History className="h-4 w-4 text-muted-foreground" /> سجل آخر الإرسالات
        </div>
        {data.history.length === 0 ? (
          <div className="px-4 pb-4 text-xs text-muted-foreground">لا توجد سجلات بعد.</div>
        ) : (
          <div className="overflow-x-auto" data-testid="schedule-history">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-right font-medium">الوقت</th>
                  <th className="px-3 py-2 text-right font-medium">المصدر</th>
                  <th className="px-3 py-2 text-right font-medium">الحالة</th>
                  <th className="px-3 py-2 text-right font-medium">التقارير</th>
                  <th className="px-3 py-2 text-right font-medium">المستلمون</th>
                  <th className="px-3 py-2 text-right font-medium">ملاحظات</th>
                </tr>
              </thead>
              <tbody>
                {data.history.map(row => {
                  const s = STATUS_LABELS[row.status];
                  return (
                    <tr key={row.id} className="border-t">
                      <td className="px-3 py-2 text-xs whitespace-nowrap">{fmtDateTime(row.ranAt)}</td>
                      <td className="px-3 py-2 text-xs">{row.trigger === "manual" ? "يدوي" : "تلقائي"}</td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] ${s.tone}`}>
                          {row.status === "ok" && <CheckCircle2 className="h-3 w-3" />}
                          {row.status === "failed" && <AlertCircle className="h-3 w-3" />}
                          {s.ar}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {row.reports.length > 0 ? row.reports.map(reportLabel).join(" • ") : "—"}
                      </td>
                      <td className="px-3 py-2 text-xs tabular-nums">{row.recipients}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground max-w-xs truncate" title={row.message ?? ""}>
                        {row.message ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
