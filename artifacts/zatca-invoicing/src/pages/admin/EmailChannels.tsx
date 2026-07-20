// SuperAdmin — "إدارة إيميلات الإرسال". Pins a dedicated sender mailbox per
// email CHANNEL (متدربين / أمان / مستندات الشركات) stored platform-wide.
// IMPORTANT PRIORITY: for company/general emails the per-company sender
// (ضبط المرسلات in the company's GeneralSettings) ALWAYS wins — the
// "documents" channel here is only the platform-level default fallback.
// Direct fetch + Bearer convention (mirrors Domains.tsx), NOT the generated client.

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Mail, GraduationCap, ShieldCheck, FileText, Loader2, Send, Trash2,
  Save, HelpCircle, Info, Link2, ShieldAlert,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type ChannelKey = "training" | "security" | "documents";

type ChannelStatus = {
  channel: ChannelKey;
  configured: { email: string; host: string; port: number; hasPassword: boolean; strictNoFallback: boolean } | null;
  effectiveSender: string | null;
  effectiveSource: "channel_smtp" | "outlook" | "system_smtp" | "none";
};

type ConnectorInfo = { enabled: boolean; address: string | null };

type ChannelsResponse = { channels: ChannelStatus[]; connector?: ConnectorInfo };

const CHANNEL_META: Record<ChannelKey, {
  title: string; desc: string; icon: any; accent: string;
}> = {
  training: {
    title: "إيميلات المتدربين",
    desc: "رسائل تفعيل ورفض طلبات المتدربين (الوضع التدريبي).",
    icon: GraduationCap,
    accent: "border-sky-200 bg-sky-50",
  },
  security: {
    title: "رموز التحقق والأمان",
    desc: "رمز OTP لدخول السوبر أدمن وتنبيهات الأجهزة الجديدة.",
    icon: ShieldCheck,
    accent: "border-amber-200 bg-amber-50",
  },
  documents: {
    title: "مستندات الشركات (الافتراضي العام)",
    desc: "الفواتير والتقارير وبقية مراسلات الشركات عندما لا يكون للشركة مُرسِل خاص بها.",
    icon: FileText,
    accent: "border-emerald-200 bg-emerald-50",
  },
};

const SOURCE_LABEL: Record<ChannelStatus["effectiveSource"], { text: string; cls: string }> = {
  channel_smtp: { text: "بريد مخصص لهذه القناة", cls: "bg-green-100 text-green-700" },
  outlook:      { text: "حساب Outlook المرتبط", cls: "bg-blue-100 text-blue-700" },
  system_smtp:  { text: "بريد النظام الافتراضي (SMTP)", cls: "bg-slate-200 text-slate-700" },
  none:         { text: "لا يوجد إرسال مفعّل", cls: "bg-red-100 text-red-700" },
};

function FieldHint({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" tabIndex={-1} className="text-slate-400 hover:text-slate-600">
          <HelpCircle className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed" dir="rtl">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

function ChannelCard({
  status, headers, onSaved,
}: {
  status: ChannelStatus;
  headers: Record<string, string>;
  onSaved: (resp: ChannelsResponse) => void;
}) {
  const { toast } = useToast();
  const meta = CHANNEL_META[status.channel];
  const Icon = meta.icon;

  const [email, setEmail] = useState(status.configured?.email ?? "");
  const [host, setHost] = useState(status.configured?.host ?? "");
  const [port, setPort] = useState(String(status.configured?.port ?? 587));
  const [password, setPassword] = useState("");
  const [testTo, setTestTo] = useState("");
  const [strict, setStrict] = useState(status.configured?.strictNoFallback ?? false);

  // Re-seed local fields whenever the server state changes (save/delete).
  useEffect(() => {
    setEmail(status.configured?.email ?? "");
    setHost(status.configured?.host ?? "");
    setPort(String(status.configured?.port ?? 587));
    setPassword("");
    setStrict(status.configured?.strictNoFallback ?? false);
  }, [status.configured?.email, status.configured?.host, status.configured?.port, status.configured?.strictNoFallback]);

  const save = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/email-channels/${status.channel}`, {
        method: "PUT", headers,
        body: JSON.stringify({
          email: email.trim(), host: host.trim(), port: Number(port), password,
          strictNoFallback: strict,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "فشل حفظ إعدادات القناة");
      return j as ChannelsResponse;
    },
    onSuccess: (resp) => { toast({ title: "تم حفظ إعدادات القناة" }); onSaved(resp); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/email-channels/${status.channel}`, {
        method: "DELETE", headers,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "فشل حذف إعدادات القناة");
      return j as ChannelsResponse;
    },
    onSuccess: (resp) => { toast({ title: "تم الحذف — القناة رجعت للإعداد الافتراضي" }); onSaved(resp); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const test = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/email-channels/${status.channel}/test`, {
        method: "POST", headers, body: JSON.stringify({ to: testTo.trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.reason ? `${j.error || "فشل الإرسال"} — ${j.reason}` : (j.error || "فشل الإرسال"));
      return j;
    },
    onSuccess: (j: any) => toast({ title: "تم إرسال رسالة الاختبار", description: `إلى ${j.sentTo}` }),
    onError: (e: any) => toast({ title: "فشل الاختبار", description: e.message, variant: "destructive" }),
  });

  const src = SOURCE_LABEL[status.effectiveSource];

  return (
    <Card className={`border ${meta.accent}`} data-testid={`channel-card-${status.channel}`}>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-white p-2 shadow-sm border">
              <Icon className="h-5 w-5 text-slate-700" />
            </div>
            <div>
              <h3 className="font-bold text-slate-800">{meta.title}</h3>
              <p className="text-xs text-slate-500 mt-0.5">{meta.desc}</p>
            </div>
          </div>
          <div className="text-left space-y-1">
            <Badge className={src.cls}>{src.text}</Badge>
            <div className="text-xs text-slate-600 font-mono" dir="ltr" data-testid={`effective-${status.channel}`}>
              {status.effectiveSender ?? "—"}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="space-y-1 md:col-span-2">
            <div className="flex items-center gap-1">
              <Label className="text-xs">البريد الإلكتروني المرسل</Label>
              <FieldHint text="العنوان اللي هيوصل منه الإيميل للمستلم. لازم يكون نفس حساب الـ SMTP أو عنوان مسموح له بالإرسال من نفس الخادم." />
            </div>
            <Input dir="ltr" type="email" placeholder="sender@zacoderp.com"
              value={email} onChange={e => setEmail(e.target.value)}
              data-testid={`input-email-${status.channel}`} />
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-1">
              <Label className="text-xs">خادم SMTP</Label>
              <FieldHint text="عنوان خادم الإرسال. أمثلة: mail.zacoderp.com — Gmail: smtp.gmail.com — Outlook/Hotmail: smtp-mail.outlook.com (ملاحظة: حسابات مايكروسوفت الشخصية موقفة SMTP بكلمة مرور — استخدم ربط Outlook بدل ما تكتب إعدادات هنا)." />
            </div>
            <Input dir="ltr" placeholder="mail.example.com"
              value={host} onChange={e => setHost(e.target.value)}
              data-testid={`input-host-${status.channel}`} />
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-1">
              <Label className="text-xs">المنفذ (Port)</Label>
              <FieldHint text="587 = تشفير TLS/STARTTLS (الأشهر والموصى به) · 465 = تشفير SSL مباشر · 25 غالباً محجوب من مزودي الاستضافة." />
            </div>
            <Input dir="ltr" inputMode="numeric" placeholder="587"
              value={port} onChange={e => setPort(e.target.value)}
              data-testid={`input-port-${status.channel}`} />
          </div>
          <div className="space-y-1 md:col-span-2">
            <div className="flex items-center gap-1">
              <Label className="text-xs">كلمة المرور / App Password</Label>
              <FieldHint text="كلمة مرور حساب البريد أو كلمة مرور التطبيقات (App Password). تتخزن مشفّرة AES-256 في قاعدة البيانات. سيبها فاضية عند التعديل لو مش عايز تغيّرها." />
            </div>
            <Input dir="ltr" type="password" autoComplete="new-password"
              placeholder={status.configured?.hasPassword ? "•••••••• (محفوظة — اتركها فارغة للإبقاء عليها)" : "كلمة المرور"}
              value={password} onChange={e => setPassword(e.target.value)}
              data-testid={`input-password-${status.channel}`} />
          </div>
          <div className="flex items-end gap-2 md:col-span-2">
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}
              data-testid={`btn-save-${status.channel}`}>
              {save.isPending ? <Loader2 className="h-4 w-4 animate-spin ml-1" /> : <Save className="h-4 w-4 ml-1" />}
              حفظ
            </Button>
            {status.configured && (
              <Button size="sm" variant="outline" className="text-red-600 border-red-200 hover:bg-red-50"
                onClick={() => { if (confirm("حذف إعدادات هذه القناة والرجوع للافتراضي؟")) remove.mutate(); }}
                disabled={remove.isPending} data-testid={`btn-delete-${status.channel}`}>
                {remove.isPending ? <Loader2 className="h-4 w-4 animate-spin ml-1" /> : <Trash2 className="h-4 w-4 ml-1" />}
                حذف
              </Button>
            )}
          </div>
        </div>

        <div className="flex items-start gap-2 pt-2 border-t border-slate-200/70">
          <ShieldAlert className={`h-4 w-4 mt-0.5 shrink-0 ${strict ? "text-red-600" : "text-slate-400"}`} />
          <div className="flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Label className="text-xs font-semibold cursor-pointer" htmlFor={`strict-${status.channel}`}>
                منع الإرسال من أي بريد بديل (وضع صارم)
              </Label>
              <Switch id={`strict-${status.channel}`} checked={strict} onCheckedChange={setStrict}
                data-testid={`switch-strict-${status.channel}`} />
              {status.configured?.strictNoFallback !== undefined &&
                strict !== status.configured.strictNoFallback && (
                <span className="text-[11px] text-amber-600">— اضغط «حفظ» لتطبيق التغيير</span>
              )}
            </div>
            <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
              لو بريد القناة ده فشل في الإرسال، الرسالة <strong>مش هتتبعت نهائياً</strong> من حساب
              Outlook المرتبط أو بريد النظام — وهيظهر سبب الفشل الحقيقي بدل ما الرسالة تطلع من إيميل غلط.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 pt-1 border-t border-slate-200/70 flex-wrap">
          <Label className="text-xs whitespace-nowrap">إرسال اختبار إلى:</Label>
          <Input dir="ltr" type="email" placeholder="you@example.com" className="h-8 w-64"
            value={testTo} onChange={e => setTestTo(e.target.value)}
            data-testid={`input-test-${status.channel}`} />
          <Button size="sm" variant="secondary" onClick={() => test.mutate()}
            disabled={test.isPending || !testTo.trim()}
            data-testid={`btn-test-${status.channel}`}>
            {test.isPending ? <Loader2 className="h-4 w-4 animate-spin ml-1" /> : <Send className="h-4 w-4 ml-1" />}
            اختبار الإرسال
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function EmailChannels() {
  const { token } = useAuth();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const listQ = useQuery<ChannelsResponse>({
    queryKey: ["admin-email-channels"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/email-channels`, { headers });
      if (!r.ok) throw new Error("فشل تحميل إعدادات الإيميلات");
      return r.json();
    },
  });

  const onSaved = (resp: ChannelsResponse) =>
    qc.setQueryData(["admin-email-channels"], resp);

  const connector = listQ.data?.connector;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="p-6 max-w-5xl mx-auto space-y-5" data-testid="email-channels-page">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-slate-900 p-2.5">
            <Mail className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-800">إدارة إيميلات الإرسال</h1>
            <p className="text-sm text-slate-500">
              تحديد بريد مرسل مخصص لكل نوع من رسائل المنصة، مع إمكانية اختبار الإرسال فوراً.
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 flex gap-2 text-sm text-blue-800 leading-relaxed">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <strong>قاعدة الأولوية:</strong> لو الشركة ضابطة بريد مرسل خاص بها من شاشة
            «ضبط المرسلات» في إعداداتها العامة، بريد الشركة هو اللي بيستخدم <u>دايماً</u> لمستنداتها
            — الإعداد هنا مجرد الافتراضي العام للمنصة لما الشركة مالهاش مُرسِل خاص.
            قنوات المتدربين والأمان منصّية بالكامل ولا تتأثر بإعدادات الشركات.
          </div>
        </div>

        {connector && (
          <div className="rounded-lg border border-slate-300 bg-slate-50 p-3 flex items-start gap-2 text-sm leading-relaxed"
            data-testid="connector-banner">
            <Link2 className="h-4 w-4 mt-0.5 shrink-0 text-slate-600" />
            <div className="text-slate-700">
              <strong>حساب Outlook المرتبط بالمنصة (الاحتياطي):</strong>{" "}
              {connector.enabled ? (
                connector.address ? (
                  <span className="font-mono" dir="ltr" data-testid="connector-address">{connector.address}</span>
                ) : (
                  <span className="text-amber-600">مفعّل لكن تعذّر قراءة عنوان البريد حالياً</span>
                )
              ) : (
                <span className="text-red-600">غير مرتبط</span>
              )}
              <p className="text-xs text-slate-500 mt-1">
                ده الحساب اللي بيُستخدم كاحتياطي لو بريد القناة فشل. تغييره بيتم من لوحة Integrations في Replit
                (فصل الربط الحالي ثم الربط بالحساب الجديد) — ولو مش عايز أي إرسال منه لقناة معيّنة فعّل
                «الوضع الصارم» في كارت القناة تحت.
              </p>
            </div>
          </div>
        )}

        {listQ.isLoading && (
          <div className="flex items-center gap-2 text-slate-500 py-10 justify-center">
            <Loader2 className="h-5 w-5 animate-spin" /> جارٍ التحميل…
          </div>
        )}
        {listQ.isError && (
          <div className="text-red-600 text-sm py-6 text-center">فشل تحميل الإعدادات — حدّث الصفحة أو حاول لاحقاً.</div>
        )}
        {listQ.data?.channels.map(ch => (
          <ChannelCard key={ch.channel} status={ch} headers={headers} onSaved={onSaved} />
        ))}
      </div>
    </TooltipProvider>
  );
}
