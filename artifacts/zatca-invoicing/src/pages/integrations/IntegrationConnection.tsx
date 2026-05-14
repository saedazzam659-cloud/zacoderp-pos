import { useState } from "react";
import { useRoute, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ArrowRight, RefreshCw, Trash2, CheckCircle2, AlertCircle, Activity, Settings, Key } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Provider {
  id: string; nameAr: string; nameEn: string; logoSvg: string;
  credentialFields: Array<{ key: string; labelAr: string; type: "text" | "password" | "url"; required: boolean; placeholder?: string; helperAr?: string }>;
}
interface Connection {
  id: number; provider: string; displayName: string; status: string; baseUrl: string | null;
  config: Record<string, unknown>;
  pullEnabled: boolean; pullIntervalMinutes: number;
  lastSyncAt: string | null; lastSyncStatus: string | null; lastSyncError: string | null; totalSyncs: number;
  credentialKeysSet: string[];
}
interface SyncRun {
  id: number; trigger: string; status: string; startedAt: string; finishedAt: string | null;
  invoicesIngested: number; errors: Array<{ ref: string; reason: string }>;
}

export default function IntegrationConnection() {
  const [, params] = useRoute("/integrations/connections/:id");
  const id = Number(params?.id ?? 0);
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: connData } = useQuery<Connection>({
    queryKey: ["integrations", "connection", id],
    queryFn: async () => (await fetch(`/api/integrations/connections/${id}`).then(r => r.json())),
    enabled: id > 0,
  });
  const { data: provData } = useQuery<{ providers: Provider[] }>({
    queryKey: ["integrations", "providers"],
    queryFn: async () => (await fetch("/api/integrations/providers").then(r => r.json())),
  });
  const { data: runsData, refetch: refetchRuns } = useQuery<{ runs: SyncRun[] }>({
    queryKey: ["integrations", "runs", id],
    queryFn: async () => (await fetch(`/api/integrations/connections/${id}/runs`).then(r => r.json())),
    enabled: id > 0,
  });

  const conn = connData;
  const provider = conn ? provData?.providers.find(p => p.id === conn.provider) : null;

  const test = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/integrations/connections/${id}/test`, { method: "POST" });
      const j = await r.json();
      if (!r.ok || j.ok === false) throw new Error(j.error ?? "فشل الاختبار");
      return j;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["integrations", "connection", id] }); toast({ title: "نجح الاختبار", description: "الاتصال يعمل بشكل صحيح" }); },
    onError: (e: Error) => toast({ title: "فشل الاختبار", description: e.message, variant: "destructive" }),
  });

  const sync = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/integrations/connections/${id}/sync`, { method: "POST" });
      const j = await r.json();
      if (!r.ok && j.status !== "partial") throw new Error(j.error ?? "فشلت المزامنة");
      return j as { ingested: number; errors: number; status: string };
    },
    onSuccess: (j) => {
      qc.invalidateQueries({ queryKey: ["integrations", "connection", id] });
      refetchRuns();
      toast({ title: "اكتملت المزامنة", description: `تم استقبال ${j.ingested} فاتورة (${j.errors} خطأ)` });
    },
    onError: (e: Error) => toast({ title: "فشلت المزامنة", description: e.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/integrations/connections/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error("فشل الحذف");
    },
    onSuccess: () => { window.location.href = "/integrations/marketplace"; },
  });

  if (!conn || !provider) return <div className="p-6 text-slate-500">جارٍ التحميل...</div>;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6" dir="rtl">
      <div className="flex items-center justify-between gap-4">
        <Link href="/integrations/marketplace" className="text-sm text-slate-500 hover:text-slate-700 flex items-center gap-1">
          <ArrowRight className="w-4 h-4" /> العودة للسوق
        </Link>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => test.mutate()} disabled={test.isPending}>
            <CheckCircle2 className="w-4 h-4 ml-1" /> اختبار
          </Button>
          <Button size="sm" onClick={() => sync.mutate()} disabled={sync.isPending}>
            <RefreshCw className={`w-4 h-4 ml-1 ${sync.isPending ? "animate-spin" : ""}`} /> مزامنة الآن
          </Button>
        </div>
      </div>

      <Card className="p-6">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-xl bg-slate-50 flex items-center justify-center"
               dangerouslySetInnerHTML={{ __html: provider.logoSvg }} />
          <div className="flex-1">
            <h1 className="text-xl font-bold">{conn.displayName}</h1>
            <div className="text-sm text-slate-500">{provider.nameEn} • {conn.totalSyncs} مزامنة</div>
            <div className="mt-2">
              {conn.status === "connected" && <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100"><CheckCircle2 className="w-3 h-3 ml-1"/>متصل</Badge>}
              {conn.status === "error"     && <Badge className="bg-rose-100 text-rose-700 hover:bg-rose-100"><AlertCircle className="w-3 h-3 ml-1"/>خطأ</Badge>}
              {conn.status === "disconnected" && <Badge variant="secondary">غير مُختبر بعد</Badge>}
            </div>
          </div>
        </div>
        {conn.lastSyncError && (
          <div className="mt-4 bg-rose-50 border border-rose-200 rounded-lg p-3 text-sm text-rose-800">
            <strong>آخر خطأ:</strong> {conn.lastSyncError}
          </div>
        )}
      </Card>

      <Tabs defaultValue="settings">
        <TabsList>
          <TabsTrigger value="settings"><Settings className="w-4 h-4 ml-1"/>الإعدادات</TabsTrigger>
          <TabsTrigger value="credentials"><Key className="w-4 h-4 ml-1"/>بيانات الاعتماد</TabsTrigger>
          <TabsTrigger value="runs"><Activity className="w-4 h-4 ml-1"/>سجل المزامنة</TabsTrigger>
        </TabsList>

        <TabsContent value="settings">
          <SettingsPanel conn={conn} onSaved={() => qc.invalidateQueries({ queryKey: ["integrations", "connection", id] })} />
        </TabsContent>
        <TabsContent value="credentials">
          <CredentialsPanel conn={conn} provider={provider} onSaved={() => qc.invalidateQueries({ queryKey: ["integrations", "connection", id] })} />
        </TabsContent>
        <TabsContent value="runs">
          <RunsPanel runs={runsData?.runs ?? []} />
        </TabsContent>
      </Tabs>

      <Card className="p-4 border-rose-200">
        <h3 className="font-semibold text-rose-700 mb-2">منطقة الخطر</h3>
        <p className="text-sm text-slate-600 mb-3">حذف الاتصال يلغي رابط الاستقبال الحالي وكل سجلات المزامنة. الفواتير التي تم تحويلها سابقاً تبقى محفوظة.</p>
        <Button variant="destructive" size="sm" onClick={() => confirm("متأكد من حذف الاتصال؟") && remove.mutate()}>
          <Trash2 className="w-4 h-4 ml-1" /> حذف الاتصال
        </Button>
      </Card>
    </div>
  );
}

function SettingsPanel({ conn, onSaved }: { conn: Connection; onSaved: () => void }) {
  const { toast } = useToast();
  const [displayName, setDisplayName] = useState(conn.displayName);
  const [pullEnabled, setPullEnabled] = useState(conn.pullEnabled);
  const [interval, setInterval_] = useState(conn.pullIntervalMinutes);

  const save = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/integrations/connections/${conn.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName, pullEnabled, pullIntervalMinutes: interval }),
      });
      if (!r.ok) throw new Error("فشل الحفظ");
    },
    onSuccess: () => { onSaved(); toast({ title: "تم الحفظ" }); },
  });

  return (
    <Card className="p-6 space-y-4">
      <div>
        <Label>اسم العرض</Label>
        <Input value={displayName} onChange={e => setDisplayName(e.target.value)} />
      </div>
      <div className="flex items-center justify-between border-t pt-4">
        <div>
          <Label>تفعيل المزامنة المجدولة (Pull)</Label>
          <p className="text-xs text-slate-500 mt-1">يسحب النظام الفواتير الجديدة تلقائياً كل عدة دقائق</p>
        </div>
        <Switch checked={pullEnabled} onCheckedChange={setPullEnabled} />
      </div>
      {pullEnabled && (
        <div>
          <Label>الفاصل الزمني (دقائق)</Label>
          <Input type="number" min={5} max={1440} value={interval} onChange={e => setInterval_(Number(e.target.value))} dir="ltr" />
          <p className="text-xs text-slate-500 mt-1">من 5 إلى 1440 دقيقة (24 ساعة كحد أقصى)</p>
        </div>
      )}
      <Button onClick={() => save.mutate()} disabled={save.isPending}>حفظ التغييرات</Button>
    </Card>
  );
}

function CredentialsPanel({ conn, provider, onSaved }: { conn: Connection; provider: Provider; onSaved: () => void }) {
  const { toast } = useToast();
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [baseUrl, setBaseUrl] = useState(conn.baseUrl ?? "");

  const save = useMutation({
    mutationFn: async () => {
      const filled = Object.fromEntries(Object.entries(creds).filter(([_, v]) => v.trim()));
      if (Object.keys(filled).length === 0 && baseUrl === (conn.baseUrl ?? "")) {
        throw new Error("لم يتم تغيير أي حقل");
      }
      const r = await fetch(`/api/integrations/connections/${conn.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentials: filled, baseUrl }),
      });
      if (!r.ok) throw new Error("فشل الحفظ");
    },
    onSuccess: () => { onSaved(); setCreds({}); toast({ title: "تم تحديث بيانات الاعتماد" }); },
    onError: (e: Error) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  return (
    <Card className="p-6 space-y-4">
      <p className="text-sm text-slate-600">القيم الموجودة محمية ولا تُعرض. اترك الحقل فارغاً للإبقاء على القيمة الحالية، أو اكتب قيمة جديدة لاستبدالها.</p>
      <div>
        <Label>Base URL (إن وُجد)</Label>
        <Input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} dir="ltr" placeholder="https://api.example.com" />
      </div>
      {provider.credentialFields.map(f => {
        const isSet = conn.credentialKeysSet.includes(f.key);
        return (
          <div key={f.key}>
            <Label>{f.labelAr} {isSet && <Badge variant="outline" className="text-[10px] mr-2">محفوظ</Badge>}</Label>
            <Input
              type={f.type === "password" ? "password" : "text"}
              dir={f.type !== "text" ? "ltr" : undefined}
              placeholder={isSet ? "(اترك فارغاً للإبقاء على القيمة الحالية)" : f.placeholder}
              value={creds[f.key] ?? ""}
              onChange={e => setCreds({ ...creds, [f.key]: e.target.value })}
            />
            {f.helperAr && <p className="text-xs text-slate-500 mt-1">{f.helperAr}</p>}
          </div>
        );
      })}
      <Button onClick={() => save.mutate()} disabled={save.isPending}>حفظ بيانات الاعتماد</Button>
    </Card>
  );
}

function RunsPanel({ runs }: { runs: SyncRun[] }) {
  if (runs.length === 0) return <Card className="p-8 text-center text-slate-500">لا توجد عمليات مزامنة بعد. اضغط "مزامنة الآن" لتشغيل أول عملية.</Card>;
  return (
    <Card className="overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 border-b">
          <tr>
            <th className="text-right p-3 font-medium">الحالة</th>
            <th className="text-right p-3 font-medium">المصدر</th>
            <th className="text-right p-3 font-medium">البداية</th>
            <th className="text-right p-3 font-medium">المدة</th>
            <th className="text-right p-3 font-medium">الفواتير</th>
            <th className="text-right p-3 font-medium">الأخطاء</th>
          </tr>
        </thead>
        <tbody>
          {runs.map(r => {
            const dur = r.finishedAt ? Math.round((new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000) : null;
            return (
              <tr key={r.id} className="border-b last:border-0 hover:bg-slate-50">
                <td className="p-3">
                  {r.status === "success"  && <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">نجاح</Badge>}
                  {r.status === "partial"  && <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">جزئي</Badge>}
                  {r.status === "failed"   && <Badge className="bg-rose-100 text-rose-700 hover:bg-rose-100">فشل</Badge>}
                  {r.status === "running"  && <Badge variant="secondary">قيد التنفيذ</Badge>}
                </td>
                <td className="p-3">{r.trigger === "manual" ? "يدوي" : r.trigger === "scheduled" ? "مجدول" : "Push"}</td>
                <td className="p-3 text-xs text-slate-500" dir="ltr">{new Date(r.startedAt).toLocaleString()}</td>
                <td className="p-3 text-xs text-slate-500" dir="ltr">{dur !== null ? `${dur}s` : "—"}</td>
                <td className="p-3 font-mono">{r.invoicesIngested}</td>
                <td className="p-3">{r.errors.length > 0 && <span className="text-rose-600 text-xs">{r.errors[0].reason}</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
