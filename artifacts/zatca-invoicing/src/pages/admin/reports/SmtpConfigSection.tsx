import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Eye, EyeOff, Info, Loader2, Mail, RotateCcw, Save, Send, Server,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";

interface SmtpConfig {
  source: "db" | "env" | "none";
  host: string | null;
  port: number | null;
  user: string | null;
  hasPassword: boolean;
  from: string | null;
  envHost: string | null;
  envPort: string | null;
  envUser: string | null;
  envHasPassword: boolean;
  envFrom: string | null;
}

const SOURCE_LABELS: Record<SmtpConfig["source"], { ar: string; tone: string }> = {
  db:   { ar: "إعدادات محفوظة في النظام", tone: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  env:  { ar: "من متغيرات البيئة",       tone: "bg-sky-100 text-sky-800 border-sky-200" },
  none: { ar: "غير مهيّأ",               tone: "bg-amber-100 text-amber-800 border-amber-200" },
};

interface DraftState {
  host: string;
  port: string;
  user: string;
  password: string;   // empty string means "keep existing"
  from: string;
}

const emptyDraft: DraftState = { host: "", port: "587", user: "", password: "", from: "" };

function configToDraft(cfg: SmtpConfig): DraftState {
  return {
    host: cfg.host ?? "",
    port: String(cfg.port ?? 587),
    user: cfg.user ?? "",
    password: "",
    from: cfg.from ?? "",
  };
}

export default function SmtpConfigSection() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<DraftState>(emptyDraft);
  const [showPass, setShowPass] = useState(false);
  const [testTo, setTestTo] = useState("");

  const { data, isLoading, error } = useQuery<SmtpConfig>({
    queryKey: ["report-smtp-config"],
    queryFn: async () => {
      const r = await fetch("/api/admin/reports/smtp-config", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error("تعذر قراءة إعدادات البريد");
      return r.json();
    },
  });

  // Initialise the draft from server state whenever the saved config changes.
  // Password field always starts empty so SuperAdmins don't accidentally
  // overwrite the saved one when editing other fields.
  useEffect(() => {
    if (data) setDraft(configToDraft(data));
  }, [data]);

  const saveMut = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const r = await fetch("/api/admin/reports/smtp-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error ?? "تعذر حفظ الإعداد");
      return body as SmtpConfig;
    },
    onSuccess: (next) => {
      qc.setQueryData(["report-smtp-config"], next);
      // Sender info also depends on SMTP config (from address fallback chain).
      qc.invalidateQueries({ queryKey: ["report-sender-email"] });
      toast({
        title: "تم الحفظ",
        description: next.source === "db"
          ? "تم تفعيل إعدادات SMTP الجديدة"
          : "تمت العودة إلى إعدادات البيئة",
      });
      setDraft(configToDraft(next));
      setShowPass(false);
    },
    onError: (err: any) => {
      toast({
        title: "تعذر الحفظ",
        description: err?.message ?? "حصل خطأ غير متوقع",
        variant: "destructive",
      });
    },
  });

  const testMut = useMutation({
    mutationFn: async (to: string) => {
      const r = await fetch("/api/admin/reports/smtp-config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ to }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error ?? body?.reason ?? "فشل الإرسال");
      return body as { ok: true; sentTo: string; from: string };
    },
    onSuccess: (res) => {
      toast({
        title: "تم الإرسال",
        description: `أُرسلت رسالة الاختبار إلى ${res.sentTo} من ${res.from}`,
      });
    },
    onError: (err: any) => {
      toast({
        title: "تعذر الإرسال",
        description: err?.message ?? "حصل خطأ غير متوقع",
        variant: "destructive",
      });
    },
  });

  const handleSave = () => {
    const host = draft.host.trim();
    const user = draft.user.trim();
    const port = Number(draft.port);
    const from = draft.from.trim();
    if (!host) { toast({ title: "خادم SMTP مطلوب", variant: "destructive" }); return; }
    if (!user) { toast({ title: "اسم المستخدم مطلوب", variant: "destructive" }); return; }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      toast({ title: "المنفذ غير صحيح", variant: "destructive" }); return;
    }
    if (from && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) {
      toast({ title: "صيغة عنوان المُرسِل غير صحيحة", variant: "destructive" }); return;
    }
    if (!draft.password && !data?.hasPassword) {
      toast({ title: "كلمة مرور SMTP مطلوبة في أول إعداد", variant: "destructive" }); return;
    }
    saveMut.mutate({
      host, port, user,
      password: draft.password,            // empty = keep existing
      from: from || null,
    });
  };

  const handleClear = () => {
    if (!confirm("سيتم حذف الإعدادات المحفوظة والعودة إلى متغيرات البيئة. متابعة؟")) return;
    saveMut.mutate({ clear: true });
  };

  const handleTest = () => {
    const to = testTo.trim();
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      toast({ title: "أدخل عنوان بريد صحيح للاختبار", variant: "destructive" }); return;
    }
    testMut.mutate(to);
  };

  return (
    <section
      data-testid="smtp-config-section"
      dir="rtl"
      className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-5"
    >
      <header className="flex items-start gap-3">
        <div className="rounded-xl bg-sky-50 p-2 text-sky-700"><Server className="h-5 w-5" /></div>
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-slate-900">إعدادات خادم البريد (SMTP)</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            اضبط خادم SMTP الذي يُرسل التقارير ورموز التحقق ودعوات المستلمين مباشرة من هنا — دون الحاجة لتعديل أسرار النشر.
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
          {/* Status card */}
          <div
            data-testid="smtp-status-card"
            className="rounded-xl border border-slate-200 bg-slate-50 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
          >
            <div className="min-w-0 space-y-0.5">
              <div className="text-xs uppercase tracking-wider text-slate-500">المصدر الفعّال</div>
              <div className="font-mono text-sm text-slate-900 truncate">
                {data.source === "db" && (
                  <>
                    {data.host}:{data.port}
                    <span className="text-slate-400"> · </span>
                    {data.user}
                  </>
                )}
                {data.source === "env" && (
                  <>
                    {data.envHost}:{data.envPort ?? "587"}
                    <span className="text-slate-400"> · </span>
                    {data.envUser}
                  </>
                )}
                {data.source === "none" && <span className="text-slate-500">— لا يوجد إعداد فعّال</span>}
              </div>
            </div>
            <Badge
              data-testid="smtp-source-badge"
              variant="outline"
              className={`shrink-0 ${SOURCE_LABELS[data.source].tone}`}
            >
              {SOURCE_LABELS[data.source].ar}
            </Badge>
          </div>

          {data.source === "none" && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 flex items-start gap-2">
              <Info className="h-4 w-4 mt-0.5 shrink-0" />
              <div>لا توجد خدمة بريد مُهيّأة بعد. اضبط الحقول أدناه واحفظها لتفعيل الإرسال.</div>
            </div>
          )}

          {/* Config form */}
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2 space-y-1">
                <label htmlFor="smtp-host" className="text-sm font-medium text-slate-700">خادم SMTP (host)</label>
                <Input
                  id="smtp-host"
                  data-testid="smtp-host-input"
                  dir="ltr"
                  placeholder="smtp.gmail.com"
                  value={draft.host}
                  onChange={(e) => setDraft(d => ({ ...d, host: e.target.value }))}
                  className="font-mono"
                  disabled={saveMut.isPending}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="smtp-port" className="text-sm font-medium text-slate-700">المنفذ (port)</label>
                <Input
                  id="smtp-port"
                  data-testid="smtp-port-input"
                  dir="ltr"
                  type="number"
                  placeholder="587"
                  value={draft.port}
                  onChange={(e) => setDraft(d => ({ ...d, port: e.target.value }))}
                  className="font-mono"
                  disabled={saveMut.isPending}
                />
              </div>
            </div>

            <div className="space-y-1">
              <label htmlFor="smtp-user" className="text-sm font-medium text-slate-700">اسم المستخدم (user)</label>
              <Input
                id="smtp-user"
                data-testid="smtp-user-input"
                dir="ltr"
                placeholder="reports@yourcompany.com"
                value={draft.user}
                onChange={(e) => setDraft(d => ({ ...d, user: e.target.value }))}
                className="font-mono"
                disabled={saveMut.isPending}
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="smtp-pass" className="text-sm font-medium text-slate-700">
                كلمة المرور (password)
                {data.hasPassword && (
                  <span className="text-xs text-slate-500 mr-2 font-normal">
                    — اتركها فارغة للإبقاء على القيمة المحفوظة
                  </span>
                )}
              </label>
              <div className="relative">
                <Input
                  id="smtp-pass"
                  data-testid="smtp-pass-input"
                  dir="ltr"
                  type={showPass ? "text" : "password"}
                  placeholder={data.hasPassword ? "••••••••" : "أدخل كلمة المرور"}
                  value={draft.password}
                  onChange={(e) => setDraft(d => ({ ...d, password: e.target.value }))}
                  className="font-mono pr-10"
                  autoComplete="new-password"
                  disabled={saveMut.isPending}
                />
                <button
                  type="button"
                  onClick={() => setShowPass(s => !s)}
                  className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                  tabIndex={-1}
                  aria-label={showPass ? "إخفاء" : "إظهار"}
                >
                  {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div className="space-y-1">
              <label htmlFor="smtp-from" className="text-sm font-medium text-slate-700">
                عنوان المُرسِل (from)
                <span className="text-xs text-slate-500 mr-2 font-normal">— اختياري؛ يُستخدم اسم المستخدم إن تُرك فارغًا</span>
              </label>
              <Input
                id="smtp-from"
                data-testid="smtp-from-input"
                dir="ltr"
                type="email"
                placeholder="reports@yourcompany.com"
                value={draft.from}
                onChange={(e) => setDraft(d => ({ ...d, from: e.target.value }))}
                className="font-mono"
                disabled={saveMut.isPending}
              />
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                data-testid="smtp-save"
                onClick={handleSave}
                disabled={saveMut.isPending}
              >
                {saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin ml-2" /> : <Save className="h-4 w-4 ml-2" />}
                حفظ الإعدادات
              </Button>
              {data.source === "db" && (
                <Button
                  data-testid="smtp-clear"
                  variant="outline"
                  onClick={handleClear}
                  disabled={saveMut.isPending}
                  title="حذف الإعدادات المحفوظة والعودة لمتغيرات البيئة"
                >
                  <RotateCcw className="h-4 w-4 ml-2" />
                  حذف الإعدادات والعودة للبيئة
                </Button>
              )}
            </div>
          </div>

          {/* Test send block */}
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2">
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-slate-600" />
              <div className="text-sm font-semibold text-slate-800">اختبار الإرسال</div>
            </div>
            <p className="text-xs text-slate-500">
              يُرسَل بريد قصير للتأكد من نجاح الاتصال بـ SMTP وقبول الخادم لعملية المصادقة.
              يستخدم الإعدادات المحفوظة حالياً (لا حاجة للحفظ مسبقاً إذا كنتَ تستخدم متغيرات البيئة).
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                data-testid="smtp-test-to"
                dir="ltr"
                type="email"
                placeholder="your-mailbox@example.com"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                className="flex-1 font-mono"
                disabled={testMut.isPending}
              />
              <Button
                data-testid="smtp-test-send"
                onClick={handleTest}
                disabled={testMut.isPending}
                variant="secondary"
              >
                {testMut.isPending ? <Loader2 className="h-4 w-4 animate-spin ml-2" /> : <Send className="h-4 w-4 ml-2" />}
                إرسال رسالة اختبار
              </Button>
            </div>
          </div>

          {/* Compact env detail */}
          <details className="text-xs text-slate-500">
            <summary className="cursor-pointer select-none hover:text-slate-700">تفاصيل تقنية ومتغيرات البيئة</summary>
            <ul className="mt-2 space-y-1 font-mono">
              <li>SMTP_HOST: {data.envHost ?? <span className="text-slate-400">— غير مضبوط</span>}</li>
              <li>SMTP_PORT: {data.envPort ?? <span className="text-slate-400">— غير مضبوط (افتراضي 587)</span>}</li>
              <li>SMTP_USER: {data.envUser ?? <span className="text-slate-400">— غير مضبوط</span>}</li>
              <li>SMTP_PASS: {data.envHasPassword
                ? <span className="text-emerald-700">مضبوط</span>
                : <span className="text-slate-400">— غير مضبوط</span>}</li>
              <li>SMTP_FROM: {data.envFrom ?? <span className="text-slate-400">— غير مضبوط</span>}</li>
              <li className="text-slate-600">إعدادات النظام تتقدّم على متغيرات البيئة عند تعارضها.</li>
            </ul>
          </details>
        </>
      )}
    </section>
  );
}
