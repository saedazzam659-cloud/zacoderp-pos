import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { MessageSquare, Webhook, Send, Loader2, Save, TestTube2, Bell } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function SupportSettings() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const { data, isLoading } = useQuery({
    queryKey: ["support-settings"],
    queryFn: async () => (await fetch(`${API}/api/support-messages/_settings/get`, { headers })).json(),
  });
  const initial = data?.settings;

  const [s, setS] = useState<any>(null);
  useEffect(() => { if (initial && !s) setS({ ...initial }); }, [initial, s]);

  const saveMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/support-messages/_settings/update`, {
        method: "PUT", headers, body: JSON.stringify(s),
      });
      if (!r.ok) throw new Error((await r.json())?.error || "فشل الحفظ");
      return r.json();
    },
    onSuccess: (j: any) => {
      toast({ title: "تم حفظ الإعدادات" });
      setS({ ...j.settings });
      qc.invalidateQueries({ queryKey: ["support-settings"] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e?.message, variant: "destructive" }),
  });

  const testMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/support-messages/_settings/test`, { method: "POST", headers });
      if (!r.ok) throw new Error((await r.json())?.error || "فشل الاختبار");
      return r.json();
    },
    onSuccess: () => toast({ title: "تم إرسال رسالة الاختبار", description: "تحقق من القنوات المُفعّلة." }),
    onError: (e: any) => toast({ title: "خطأ", description: e?.message, variant: "destructive" }),
  });

  if (isLoading || !s) {
    return <div className="p-8 text-center text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline ml-2" />جارٍ التحميل…</div>;
  }

  const set = (k: string, v: any) => setS((prev: any) => ({ ...prev, [k]: v }));

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-bold">إعدادات قنوات رسائل الدعم</h1>
        <p className="text-sm text-muted-foreground">اختر كيف تريد استلام رسائل المستخدمين</p>
      </div>

      {/* In-app */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Bell className="h-5 w-5 text-primary" />
            <div className="flex-1">
              <CardTitle className="text-base">إشعارات داخل التطبيق</CardTitle>
              <CardDescription className="text-xs">إنشاء إشعار لكل سوبر أدمن عند وصول رسالة جديدة</CardDescription>
            </div>
            <Switch checked={!!s.notifySuperadminInApp} onCheckedChange={v => set("notifySuperadminInApp", v)} data-testid="sw-inapp" />
          </div>
        </CardHeader>
      </Card>

      {/* Webhook */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Webhook className="h-5 w-5 text-primary" />
            <div className="flex-1">
              <CardTitle className="text-base">Webhook (HTTP POST)</CardTitle>
              <CardDescription className="text-xs">إرسال JSON إلى رابط خارجي (Slack, Discord, Zapier, n8n…)</CardDescription>
            </div>
            <Switch checked={!!s.webhookEnabled} onCheckedChange={v => set("webhookEnabled", v)} data-testid="sw-webhook" />
          </div>
        </CardHeader>
        {s.webhookEnabled && (
          <CardContent className="space-y-3">
            <div>
              <Label className="text-xs">رابط الـ Webhook</Label>
              <Input dir="ltr" placeholder="https://example.com/webhook"
                value={s.webhookUrl || ""} onChange={e => set("webhookUrl", e.target.value)} data-testid="in-webhook-url" />
            </div>
            <div>
              <Label className="text-xs">سر الإرسال (اختياري) — يُرسل في الترويسة X-Support-Secret</Label>
              <Input dir="ltr" placeholder="********"
                value={s.webhookSecret || ""} onChange={e => set("webhookSecret", e.target.value)} data-testid="in-webhook-secret" />
            </div>
          </CardContent>
        )}
      </Card>

      {/* Telegram */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Send className="h-5 w-5 text-primary" />
            <div className="flex-1">
              <CardTitle className="text-base">Telegram</CardTitle>
              <CardDescription className="text-xs">إرسال الرسائل إلى دردشة تيليجرام عبر بوت</CardDescription>
            </div>
            <Switch checked={!!s.telegramEnabled} onCheckedChange={v => set("telegramEnabled", v)} data-testid="sw-telegram" />
          </div>
        </CardHeader>
        {s.telegramEnabled && (
          <CardContent className="space-y-3">
            <div>
              <Label className="text-xs">Bot Token (من @BotFather)</Label>
              <Input dir="ltr" placeholder="********"
                value={s.telegramBotToken || ""} onChange={e => set("telegramBotToken", e.target.value)} data-testid="in-tg-token" />
            </div>
            <div>
              <Label className="text-xs">Chat ID</Label>
              <Input dir="ltr" placeholder="-1001234567890"
                value={s.telegramChatId || ""} onChange={e => set("telegramChatId", e.target.value)} data-testid="in-tg-chat" />
            </div>
          </CardContent>
        )}
      </Card>

      <div className="flex items-center gap-2">
        <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending} data-testid="btn-save">
          {saveMut.isPending ? <Loader2 className="h-4 w-4 ml-2 animate-spin" /> : <Save className="h-4 w-4 ml-2" />}
          حفظ الإعدادات
        </Button>
        <Button variant="outline" onClick={() => testMut.mutate()} disabled={testMut.isPending} data-testid="btn-test">
          {testMut.isPending ? <Loader2 className="h-4 w-4 ml-2 animate-spin" /> : <TestTube2 className="h-4 w-4 ml-2" />}
          إرسال رسالة اختبار
        </Button>
      </div>
    </div>
  );
}
