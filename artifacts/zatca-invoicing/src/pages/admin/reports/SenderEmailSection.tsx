import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AtSign, CheckCircle2, Info, Loader2, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";

interface SenderInfo {
  active: string;
  source: "override" | "smtp_from_env" | "smtp_user_env" | "outlook_account" | "fallback";
  override: string | null;
  smtpFromEnv: string | null;
  smtpUserEnv: string | null;
  outlookEnabled: boolean;
  outlookAddress: string | null;
  willActuallySendFrom: string;
  notice: "outlook_locks_sender" | "no_transport_configured" | null;
}

const SOURCE_LABELS: Record<SenderInfo["source"], { ar: string; tone: string }> = {
  override:        { ar: "تم التعيين يدوياً",                   tone: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  smtp_from_env:   { ar: "من إعدادات SMTP_FROM",               tone: "bg-sky-100 text-sky-800 border-sky-200" },
  smtp_user_env:   { ar: "من حساب SMTP",                       tone: "bg-sky-100 text-sky-800 border-sky-200" },
  outlook_account: { ar: "من حساب Outlook المربوط",            tone: "bg-violet-100 text-violet-800 border-violet-200" },
  fallback:        { ar: "افتراضي مؤقت — لم تُهيّأ خدمة بريد", tone: "bg-amber-100 text-amber-800 border-amber-200" },
};

export default function SenderEmailSection() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");

  const { data, isLoading, error } = useQuery<SenderInfo>({
    queryKey: ["report-sender-email"],
    queryFn: async () => {
      const r = await fetch("/api/admin/reports/sender-email", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error("تعذر قراءة بريد الإرسال");
      return r.json();
    },
  });

  // Reset the draft input whenever the server-side override changes — so the
  // input always starts with the currently-effective override (empty if none).
  useEffect(() => {
    setDraft(data?.override ?? "");
  }, [data?.override]);

  const saveMut = useMutation({
    mutationFn: async (email: string | null) => {
      const r = await fetch("/api/admin/reports/sender-email", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error ?? "تعذر حفظ الإعداد");
      return body as SenderInfo;
    },
    onSuccess: (next) => {
      qc.setQueryData(["report-sender-email"], next);
      qc.invalidateQueries({ queryKey: ["report-email-schedule"] });
      toast({
        title: "تم الحفظ",
        description: next.override
          ? `سيتم إرسال التقارير من: ${next.willActuallySendFrom}`
          : "تمت العودة إلى البريد الافتراضي",
      });
    },
    onError: (err: any) => {
      toast({
        title: "تعذر الحفظ",
        description: err?.message ?? "حصل خطأ غير متوقع",
        variant: "destructive",
      });
    },
  });

  const handleSave = () => {
    const trimmed = draft.trim();
    if (!trimmed) { saveMut.mutate(null); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      toast({ title: "صيغة البريد غير صحيحة", variant: "destructive" });
      return;
    }
    saveMut.mutate(trimmed);
  };

  const handleReset = () => saveMut.mutate(null);

  const overrideEqualsDraft = (data?.override ?? "") === draft.trim();
  const dirty = !overrideEqualsDraft;

  return (
    <section
      data-testid="sender-email-section"
      dir="rtl"
      className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-5"
    >
      <header className="flex items-start gap-3">
        <div className="rounded-xl bg-emerald-50 p-2 text-emerald-700"><AtSign className="h-5 w-5" /></div>
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-slate-900">بريد الإرسال المُفعَّل</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            عنوان البريد الذي ستظهر منه التقارير والدعوات في صناديق المستلمين. يمكنك تغييره بإدخال بريد جديد وحفظه.
          </p>
        </div>
      </header>

      {isLoading && (
        <div className="flex items-center gap-2 text-slate-500 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> جاري التحميل…
        </div>
      )}

      {!!error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          تعذر قراءة الإعدادات. حاول تحديث الصفحة.
        </div>
      )}

      {data && (
        <>
          {/* Active address card */}
          <div
            data-testid="sender-active-card"
            className="rounded-xl border border-slate-200 bg-slate-50 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
          >
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wider text-slate-500 mb-1">البريد الفعّال حالياً</div>
              <div
                data-testid="sender-active-email"
                className="font-mono text-base font-semibold text-slate-900 truncate"
                title={data.active}
              >
                {data.active}
              </div>
            </div>
            <Badge
              data-testid="sender-source-badge"
              variant="outline"
              className={`shrink-0 ${SOURCE_LABELS[data.source].tone}`}
            >
              {SOURCE_LABELS[data.source].ar}
            </Badge>
          </div>

          {/* Outlook lock notice — Microsoft Graph forces send-as = mailbox owner */}
          {data.notice === "outlook_locks_sender" && (
            <div
              data-testid="sender-outlook-notice"
              className="rounded-lg border border-violet-200 bg-violet-50 p-3 text-sm text-violet-900 flex items-start gap-2"
            >
              <Info className="h-4 w-4 mt-0.5 shrink-0" />
              <div className="space-y-1">
                <div>
                  لم يُضبط حساب SMTP، لذلك يتم الإرسال عبر حساب Outlook المربوط
                  {data.outlookAddress ? <> (<span className="font-mono">{data.outlookAddress}</span>)</> : null}.
                </div>
                <div className="text-xs text-violet-800/80">
                  مايكروسوفت تُجبر بريد المُرسل ليكون نفس عنوان الحساب المربوط، فأي بريد تضبطه هنا
                  سيُستخدم فقط للعرض داخل النظام، أما العنوان الفعلي في صندوق المستلم فسيكون:
                  <span className="font-mono font-semibold"> {data.willActuallySendFrom}</span>.
                  لإرسال من بريدك الخاص، اضبط متغيرات SMTP_HOST وSMTP_USER وSMTP_PASS.
                </div>
              </div>
            </div>
          )}

          {data.notice === "no_transport_configured" && (
            <div
              data-testid="sender-no-transport-notice"
              className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 flex items-start gap-2"
            >
              <Info className="h-4 w-4 mt-0.5 shrink-0" />
              <div>لا توجد خدمة بريد مُهيّأة بعد — لن تتمكّن من إرسال أي رسالة قبل ضبط SMTP أو ربط حساب Outlook.</div>
            </div>
          )}

          {/* Change form */}
          <div className="space-y-2">
            <label htmlFor="sender-email-input" className="text-sm font-medium text-slate-700">
              تغيير بريد الإرسال
            </label>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                id="sender-email-input"
                data-testid="sender-email-input"
                type="email"
                dir="ltr"
                placeholder="reports@yourcompany.com"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="flex-1 font-mono"
                disabled={saveMut.isPending}
              />
              <Button
                data-testid="sender-email-save"
                onClick={handleSave}
                disabled={saveMut.isPending || !dirty}
              >
                {saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin ml-2" /> : <Save className="h-4 w-4 ml-2" />}
                تفعيل وحفظ
              </Button>
              {data.override && (
                <Button
                  data-testid="sender-email-reset"
                  variant="outline"
                  onClick={handleReset}
                  disabled={saveMut.isPending}
                  title="إزالة البريد المخصّص والعودة للقيمة الافتراضية"
                >
                  <RotateCcw className="h-4 w-4 ml-2" />
                  إرجاع للافتراضي
                </Button>
              )}
            </div>
            <p className="text-xs text-slate-500">
              يكفي إدخال البريد ثم الضغط على «تفعيل وحفظ» — سيُستخدم في كل التقارير والدعوات الجديدة من اللحظة نفسها.
            </p>
          </div>

          {/* Compact source detail */}
          <details className="text-xs text-slate-500">
            <summary className="cursor-pointer select-none hover:text-slate-700">تفاصيل تقنية</summary>
            <ul className="mt-2 space-y-1 font-mono">
              <li>SMTP_FROM: {data.smtpFromEnv ?? <span className="text-slate-400">— غير مضبوط</span>}</li>
              <li>SMTP_USER: {data.smtpUserEnv ?? <span className="text-slate-400">— غير مضبوط</span>}</li>
              <li>Outlook: {data.outlookEnabled
                ? (data.outlookAddress ?? <span className="text-slate-400">مربوط — تعذّر قراءة عنوان الحساب</span>)
                : <span className="text-slate-400">غير مربوط</span>}</li>
              {data.source === "override" && (
                <li className="flex items-center gap-1 text-emerald-700">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  override نشط: {data.override}
                </li>
              )}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}
