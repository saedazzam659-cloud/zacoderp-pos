// ─── ضبط المرسلات — per-company sender settings tab ─────────────────────────
// Lets an admin configure the company's OWN outbound sender: an email address
// (+ SMTP credentials for that mailbox) and a company WhatsApp number. When
// unset, general system emails fall back to the platform default sender.
// The SMTP password is write-only: the server never returns it, only a
// hasPassword flag; leaving the field empty keeps the stored password.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Mail, Send, MessageCircle, Loader2, Eye, EyeOff, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/hooks/use-toast";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

interface SenderSettings {
  senderEmail: string;
  senderSmtpHost: string;
  senderSmtpPort: number;
  hasPassword: boolean;
  senderWhatsapp: string;
}

export default function SenderSettingsTab({ companyId, token }: { companyId: number; token: string | null }) {
  const qc = useQueryClient();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const { data, isLoading } = useQuery<SenderSettings>({
    queryKey: ["sender-settings", companyId],
    queryFn: async () => {
      const res = await fetch(`${API}/api/companies/${companyId}/sender-settings`, { headers });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "تعذّر جلب إعدادات المرسلات");
      return res.json();
    },
    enabled: !!companyId,
  });

  const [form, setForm] = useState<{
    senderEmail: string; senderSmtpHost: string; senderSmtpPort: string;
    senderSmtpPass: string; senderWhatsapp: string;
  } | null>(null);
  const [showPass, setShowPass] = useState(false);
  const [clearPass, setClearPass] = useState(false);
  const [testTo, setTestTo] = useState("");

  // Seed the editable form once from the fetched settings.
  const f = form ?? (data ? {
    senderEmail: data.senderEmail,
    senderSmtpHost: data.senderSmtpHost,
    senderSmtpPort: String(data.senderSmtpPort || 587),
    senderSmtpPass: "",
    senderWhatsapp: data.senderWhatsapp,
  } : null);

  const set = (k: string, v: string) => setForm({ ...(f as any), [k]: v });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!f) return;
      const body: Record<string, any> = {
        senderEmail: f.senderEmail.trim(),
        senderSmtpHost: f.senderSmtpHost.trim(),
        senderSmtpPort: f.senderSmtpPort.trim() === "" ? null : Number(f.senderSmtpPort),
        senderWhatsapp: f.senderWhatsapp.trim(),
      };
      // Password: empty field = keep stored; explicit clear = send "".
      if (clearPass) body.senderSmtpPass = "";
      else if (f.senderSmtpPass) body.senderSmtpPass = f.senderSmtpPass;
      const res = await fetch(`${API}/api/companies/${companyId}/sender-settings`, {
        method: "PUT", headers, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "تعذّر الحفظ");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "تم الحفظ", description: "تم حفظ إعدادات المرسلات بنجاح" });
      setForm(null); setClearPass(false);
      qc.invalidateQueries({ queryKey: ["sender-settings", companyId] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e?.message ?? "تعذّر الحفظ", variant: "destructive" }),
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API}/api/companies/${companyId}/sender-settings/test`, {
        method: "POST", headers, body: JSON.stringify({ to: testTo.trim() }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error ?? "فشل إرسال رسالة الاختبار");
      return j;
    },
    onSuccess: (j: any) => toast({
      title: "تم الإرسال",
      description: j?.source === "company"
        ? `أُرسلت رسالة الاختبار من بريد الشركة: ${j?.usedSender ?? ""}`
        : `أُرسلت من المرسل الافتراضي للنظام: ${j?.usedSender ?? ""}`,
    }),
    onError: (e: any) => toast({ title: "فشل الاختبار", description: e?.message ?? "تعذّر الإرسال", variant: "destructive" }),
  });

  if (isLoading || !f) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground p-6"><Loader2 className="h-4 w-4 animate-spin" /> جارِ التحميل…</div>;
  }

  return (
    <div className="space-y-6" data-testid="tab-sender-settings">
      {/* ─── Sender email + SMTP ──────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-5 space-y-4">
        <h2 className="font-semibold text-base flex items-center gap-2">
          <Mail className="h-4 w-4 text-muted-foreground" />
          بريد المرسل الخاص بالشركة
        </h2>
        <p className="text-xs text-muted-foreground leading-relaxed">
          عند ضبط بريد هنا، سيتم إرسال جميع رسائل النظام العامة الخاصة بهذه الشركة
          (الفواتير، السندات، التقارير، النسخ الاحتياطية…) من هذا العنوان.
          إذا تُرك فارغاً، تُرسل الرسائل من المرسل الافتراضي للنظام.
          رسائل الأمان (رموز التحقق وتنبيهات الدخول) لا تتأثر بهذا الإعداد.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="sender-email">البريد الإلكتروني المرسل</Label>
            <Input id="sender-email" dir="ltr" type="email" placeholder="sales@company.com"
              value={f.senderEmail} onChange={(e) => set("senderEmail", e.target.value)}
              data-testid="input-sender-email" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sender-host">خادم SMTP</Label>
            <Input id="sender-host" dir="ltr" placeholder="smtp-mail.outlook.com"
              value={f.senderSmtpHost} onChange={(e) => set("senderSmtpHost", e.target.value)}
              data-testid="input-sender-host" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sender-port">منفذ SMTP</Label>
            <Input id="sender-port" dir="ltr" inputMode="numeric" placeholder="587"
              value={f.senderSmtpPort}
              onChange={(e) => set("senderSmtpPort", e.target.value.replace(/[^0-9]/g, ""))}
              data-testid="input-sender-port" />
            <p className="text-[11px] text-muted-foreground">587 (TLS) هو الشائع — 465 يستخدم SSL مباشرة.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sender-pass">كلمة مرور SMTP {data?.hasPassword && !clearPass && <span className="text-[11px] text-emerald-600">(محفوظة — اتركها فارغة للإبقاء عليها)</span>}</Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input id="sender-pass" dir="ltr" type={showPass ? "text" : "password"}
                  placeholder={data?.hasPassword && !clearPass ? "••••••••" : "كلمة مرور التطبيق"}
                  value={f.senderSmtpPass} disabled={clearPass}
                  onChange={(e) => set("senderSmtpPass", e.target.value)}
                  data-testid="input-sender-pass" />
                <button type="button" tabIndex={-1}
                  className="absolute inset-y-0 left-2 flex items-center text-muted-foreground"
                  onClick={() => setShowPass(s => !s)}>
                  {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {data?.hasPassword && (
                <Button type="button" variant={clearPass ? "destructive" : "outline"} size="icon"
                  title={clearPass ? "تراجع عن المسح" : "مسح كلمة المرور المحفوظة"}
                  onClick={() => setClearPass(c => !c)} data-testid="button-clear-pass">
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
            {clearPass && <p className="text-[11px] text-destructive">سيتم مسح كلمة المرور المحفوظة عند الحفظ.</p>}
          </div>
        </div>
      </div>

      {/* ─── WhatsApp ─────────────────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-5 space-y-4">
        <h2 className="font-semibold text-base flex items-center gap-2">
          <MessageCircle className="h-4 w-4 text-muted-foreground" />
          واتساب الشركة
        </h2>
        <p className="text-xs text-muted-foreground leading-relaxed">
          رقم الواتساب الخاص بالشركة يُستخدم كمرجع في شاشات المشاركة. ملاحظة: روابط
          واتساب (wa.me) تفتح المحادثة من جهاز المستخدم نفسه، لذا لا يمكن تقنياً
          إجبار الإرسال «من» هذا الرقم — هو رقم تعريفي للشركة.
        </p>
        <div className="max-w-sm space-y-1.5">
          <Label htmlFor="sender-wa">رقم الواتساب</Label>
          <Input id="sender-wa" dir="ltr" placeholder="+9665xxxxxxxx"
            value={f.senderWhatsapp} onChange={(e) => set("senderWhatsapp", e.target.value)}
            data-testid="input-sender-whatsapp" />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} data-testid="button-save-sender">
          {saveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin ms-1" />}
          حفظ إعدادات المرسلات
        </Button>
      </div>

      {/* ─── Test send ────────────────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-5 space-y-3">
        <h2 className="font-semibold text-base flex items-center gap-2">
          <Send className="h-4 w-4 text-muted-foreground" />
          اختبار الإرسال
        </h2>
        <p className="text-xs text-muted-foreground">
          احفظ الإعدادات أولاً، ثم أدخل بريداً لاستقبال رسالة اختبار من بريد الشركة المضبوط أعلاه.
        </p>
        <div className="flex flex-col sm:flex-row gap-2 max-w-lg">
          <Input dir="ltr" type="email" placeholder="you@example.com" value={testTo}
            onChange={(e) => setTestTo(e.target.value)} data-testid="input-test-to" />
          <Button variant="outline" onClick={() => testMutation.mutate()}
            disabled={testMutation.isPending || !testTo.trim()} data-testid="button-test-send">
            {testMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "إرسال رسالة اختبار"}
          </Button>
        </div>
      </div>
    </div>
  );
}
