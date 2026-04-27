import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { Sparkles, Send, Inbox as InboxIcon, Mail, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Result = {
  ok: boolean;
  reportType?: string;
  dateFrom?: string;
  dateTo?: string;
  branchId?: number | null;
  labelAr?: string;
  summary?: { count?: number; totals?: Record<string, number> };
  recipientsCount?: number;
  inboxMessageId?: number | null;
  emailSent?: boolean;
  error?: string;
};

const SAMPLES_AR = [
  "ابعت تقرير مبيعات آخر ٧ أيام",
  "تقرير سندات القبض عن الشهر الحالي",
  "كشف مبيعات أمس",
  "تقرير سندات الصرف عن آخر ٣٠ يومًا",
  "ملخص مرتجعات المبيعات هذا الأسبوع",
];
const SAMPLES_EN = [
  "Send sales report for last 7 days",
  "Receipt vouchers report for the current month",
  "Yesterday's sales summary",
  "Payment vouchers for the last 30 days",
  "Sales returns summary for this week",
];

export default function AiReports() {
  const { token } = useAuth();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const dir = isRtl ? "rtl" : "ltr";
  const [prompt, setPrompt] = useState("");
  const [audience, setAudience] = useState<"self" | "all_admins">("self");
  const [sendEmail, setSendEmail] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const samples = isRtl ? SAMPLES_AR : SAMPLES_EN;

  async function handleSend() {
    if (!prompt.trim() || submitting) return;
    setSubmitting(true);
    setResult(null);
    try {
      const r = await fetch(`${API}/api/ai-reports/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ prompt, deliverByEmail: sendEmail, audience }),
      });
      const data = await r.json();
      if (!r.ok) {
        setResult({ ok: false, error: data?.error || `HTTP ${r.status}` });
      } else {
        setResult({ ok: true, ...data });
      }
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || "خطأ" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div dir={dir} className="p-4 md:p-6 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-violet-600" />
        <h1 className="text-xl md:text-2xl font-bold">{t("aiReports.title", "تقارير بالذكاء الاصطناعي")}</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        {t("aiReports.subtitle", "اكتب طلب التقرير بلغتك الطبيعية، وسيقوم النظام بفهم الطلب وإنشاء التقرير وتسليمه لك في صندوق الوارد.")}
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("aiReports.promptLabel", "اكتب طلبك")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder={t("aiReports.promptPlaceholder", "مثال: ابعت تقرير مبيعات آخر ٧ أيام")}
            rows={4}
            dir={dir}
            className="text-base"
          />

          <div className="flex flex-wrap gap-2">
            <span className="text-xs text-muted-foreground self-center">
              {t("aiReports.samplesLabel", "أمثلة:")}
            </span>
            {samples.map((s, i) => (
              <Button
                key={i}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPrompt(s)}
                className="text-xs"
              >
                {s}
              </Button>
            ))}
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center gap-4 pt-2">
            <div className="flex items-center gap-2">
              <Switch
                id="audience-toggle"
                checked={audience === "all_admins"}
                onCheckedChange={(v) => setAudience(v ? "all_admins" : "self")}
              />
              <Label htmlFor="audience-toggle" className="text-sm">
                {t("aiReports.toAllAdmins", "إرسال إلى جميع المسؤولين")}
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="email-toggle"
                checked={sendEmail}
                onCheckedChange={setSendEmail}
              />
              <Label htmlFor="email-toggle" className="text-sm flex items-center gap-1">
                <Mail className="h-3.5 w-3.5" />
                {t("aiReports.alsoEmail", "إرسال نسخة بالبريد الإلكتروني أيضاً")}
              </Label>
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <Button
              onClick={handleSend}
              disabled={!prompt.trim() || submitting}
              size="lg"
              className="bg-violet-600 hover:bg-violet-700"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 me-2 animate-spin" />
                  {t("aiReports.sending", "جارٍ الإنشاء...")}
                </>
              ) : (
                <>
                  <Send className="h-4 w-4 me-2" />
                  {t("aiReports.send", "أنشئ وأرسل التقرير")}
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {result && (
        <Card className={result.ok ? "border-green-300 bg-green-50/50" : "border-red-300 bg-red-50/50"}>
          <CardContent className="p-4">
            {result.ok ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-green-700">
                  <CheckCircle2 className="h-5 w-5" />
                  <span className="font-semibold">{t("aiReports.successTitle", "تم إنشاء وتسليم التقرير")}</span>
                </div>
                <div className="text-sm space-y-1">
                  <div><b>{t("aiReports.reportLabel", "التقرير")}:</b> {result.labelAr}</div>
                  <div>
                    <b>{t("aiReports.periodLabel", "الفترة")}:</b> {result.dateFrom} → {result.dateTo}
                    {result.branchId ? ` — ${t("aiReports.branch", "الفرع")}: ${result.branchId}` : ""}
                  </div>
                  <div><b>{t("aiReports.recordsLabel", "عدد السجلات")}:</b> {result.summary?.count ?? 0}</div>
                  <div><b>{t("aiReports.recipientsLabel", "عدد المستلمين")}:</b> {result.recipientsCount}</div>
                  {result.emailSent && (
                    <div className="text-xs text-green-700 flex items-center gap-1">
                      <Mail className="h-3.5 w-3.5" />
                      {t("aiReports.emailSent", "تم إرسال نسخة بالبريد الإلكتروني")}
                    </div>
                  )}
                </div>
                {result.inboxMessageId && (
                  <Link href={`/inbox?id=${result.inboxMessageId}`}>
                    <Button variant="outline" size="sm">
                      <InboxIcon className="h-4 w-4 me-1" />
                      {t("aiReports.openInInbox", "افتح في صندوق الوارد")}
                    </Button>
                  </Link>
                )}
              </div>
            ) : (
              <div className="flex items-start gap-2 text-red-700">
                <AlertCircle className="h-5 w-5 mt-0.5" />
                <div>
                  <div className="font-semibold">{t("aiReports.errorTitle", "تعذّر إنشاء التقرير")}</div>
                  <div className="text-sm mt-1">{result.error}</div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground text-center pt-4">
        {t("aiReports.footer", "أنواع التقارير المدعومة حالياً: المبيعات، مرتجعات المبيعات، سندات القبض، سندات الصرف، كشف الفواتير.")}
      </p>
    </div>
  );
}
