// SuperAdmin — «قواعد البيانات الخارجية»: register external Postgres databases
// and route storage-heavy modules (الأرشيف …) to them platform-wide, to
// offload the central database. Core tables + SA panel always stay central.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Plus, Trash2, Activity, Database, HardDrive, ArrowRightLeft } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

interface ExtDb { id: number; name: string; connDisplay: string | null; status: string; lastCheckAt: string | null; lastCheckResult: any; notes: string | null; }
interface Routing { moduleKey: string; externalDbId: number | null; }
interface ModuleDef { key: string; nameAr: string; wired: boolean; }

export default function ExternalDatabases() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const q = useQuery<{ databases: ExtDb[]; routings: Routing[]; modules: ModuleDef[] }>({
    queryKey: ["admin-external-dbs"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/external-databases`, { headers });
      if (!r.ok) throw new Error("فشل التحميل");
      return r.json();
    },
  });

  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ name: "", connectionString: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [migrateFor, setMigrateFor] = useState<{ moduleKey: string; externalDbId: number; dbName: string } | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ["admin-external-dbs"] });

  async function addDb() {
    setSaving(true);
    try {
      const r = await fetch(`${API}/api/admin/external-databases`, { method: "POST", headers, body: JSON.stringify(form) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "فشل الحفظ");
      toast({ title: "تمت الإضافة", description: `تم الاتصال بالقاعدة «${j.name}» بنجاح` });
      setAddOpen(false); setForm({ name: "", connectionString: "", notes: "" });
      refresh();
    } catch (e: any) {
      toast({ title: "خطأ", description: e.message, variant: "destructive" });
    } finally { setSaving(false); }
  }

  async function testDb(d: ExtDb) {
    setBusy(`test-${d.id}`);
    try {
      const r = await fetch(`${API}/api/admin/external-databases/${d.id}/test`, { method: "POST", headers });
      const j = await r.json();
      toast({
        title: `فحص «${d.name}»`,
        description: j.ok ? `متصلة ✓ (${j.latencyMs}ms)` : `فشل: ${j.error}`,
        variant: j.ok ? undefined : "destructive",
      });
      refresh();
    } finally { setBusy(null); }
  }

  async function deleteDb(d: ExtDb) {
    if (!confirm(`حذف القاعدة «${d.name}»؟`)) return;
    setBusy(`del-${d.id}`);
    try {
      const r = await fetch(`${API}/api/admin/external-databases/${d.id}`, { method: "DELETE", headers });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "فشل الحذف");
      refresh();
    } catch (e: any) {
      toast({ title: "خطأ", description: e.message, variant: "destructive" });
    } finally { setBusy(null); }
  }

  async function setRouting(moduleKey: string, externalDbId: number | null) {
    setBusy(`route-${moduleKey}`);
    try {
      const r = await fetch(`${API}/api/admin/external-databases/routings`, { method: "PUT", headers, body: JSON.stringify({ moduleKey, externalDbId }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "فشل التوجيه");
      toast({ title: "تم التوجيه", description: externalDbId == null ? "عاد الموديول للقاعدة المركزية" : "تم توجيه الموديول للقاعدة الخارجية" });
      refresh();
    } catch (e: any) {
      toast({ title: "خطأ", description: e.message, variant: "destructive" });
    } finally { setBusy(null); }
  }

  async function runMigrate() {
    if (!migrateFor) return;
    setBusy(`migrate-${migrateFor.moduleKey}`);
    try {
      const r = await fetch(`${API}/api/admin/external-databases/migrate`, { method: "POST", headers, body: JSON.stringify({ moduleKey: migrateFor.moduleKey, externalDbId: migrateFor.externalDbId }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "فشل النقل");
      toast({ title: "اكتمل النقل والتوجيه", description: `نُسخ ${j.copied} صف (المركزية: ${j.centralCount} / الخارجية: ${j.externalCount}) وتم تحويل القراءة والكتابة.` });
      setMigrateFor(null);
      refresh();
    } catch (e: any) {
      toast({ title: "خطأ في النقل", description: e.message, variant: "destructive" });
    } finally { setBusy(null); }
  }

  const dbs = q.data?.databases ?? [];
  const routings = q.data?.routings ?? [];
  const modules = q.data?.modules ?? [];
  const routingFor = (key: string) => routings.find(r => r.moduleKey === key)?.externalDbId ?? null;

  return (
    <div className="p-6 space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><HardDrive className="h-6 w-6" /> قواعد البيانات الخارجية</h1>
          <p className="text-sm text-muted-foreground mt-1">
            سجّل قواعد Postgres خارجية ووجّه إليها موديولات التخزين الثقيلة على مستوى كل الشركات لتخفيف الحمل عن القاعدة المركزية.
            الجداول الأساسية (المستخدمون، الشركات، القيود، لوحة السوبر أدمن) تبقى مركزية دائمًا.
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)} data-testid="button-add-external-db"><Plus className="h-4 w-4 ms-1" /> قاعدة جديدة</Button>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Database className="h-4 w-4" /> القواعد المسجلة</CardTitle></CardHeader>
        <CardContent>
          {q.isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : dbs.length === 0 ? (
            <p className="text-sm text-muted-foreground">لا توجد قواعد خارجية بعد.</p>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="border-b text-muted-foreground">
                <th className="p-2 text-start">الاسم</th><th className="p-2 text-start">الخادم</th><th className="p-2 text-start">الحالة</th><th className="p-2 text-start">آخر فحص</th><th className="p-2 text-start">إجراءات</th>
              </tr></thead>
              <tbody>
                {dbs.map(d => (
                  <tr key={d.id} className="border-b last:border-0" data-testid={`row-extdb-${d.id}`}>
                    <td className="p-2 font-medium">{d.name}</td>
                    <td className="p-2 font-mono text-xs" dir="ltr">{d.connDisplay ?? "—"}</td>
                    <td className="p-2">{d.status === "ok" ? <Badge className="bg-green-100 text-green-700">متصلة</Badge> : d.status === "error" ? <Badge variant="destructive">خطأ</Badge> : <Badge variant="secondary">لم تُفحص</Badge>}</td>
                    <td className="p-2 text-xs text-muted-foreground">{d.lastCheckAt ? new Date(d.lastCheckAt).toLocaleString("en-GB") : "—"}</td>
                    <td className="p-2 flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => testDb(d)} disabled={busy === `test-${d.id}`} title="فحص الاتصال">
                        {busy === `test-${d.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4 text-blue-600" />}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => deleteDb(d)} disabled={busy === `del-${d.id}`} title="حذف">
                        <Trash2 className="h-4 w-4 text-red-600" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><ArrowRightLeft className="h-4 w-4" /> توجيه الموديولات</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {modules.map(m => {
            const current = routingFor(m.key);
            return (
              <div key={m.key} className="flex flex-col md:flex-row md:items-center gap-2 border rounded-lg p-3" data-testid={`routing-${m.key}`}>
                <div className="flex-1">
                  <div className="font-medium text-sm">{m.nameAr} {!m.wired && <Badge variant="secondary" className="ms-2">قريبًا</Badge>}</div>
                  <div className="text-xs text-muted-foreground">{current == null ? "التخزين: القاعدة المركزية" : `التخزين: ${dbs.find(d => d.id === current)?.name ?? `قاعدة #${current}`}`}</div>
                </div>
                <div className="flex items-center gap-2">
                  <Select
                    value={current == null ? "central" : String(current)}
                    onValueChange={(v) => {
                      if (!m.wired) return;
                      const target = v === "central" ? null : Number(v);
                      if (target == null) { setRouting(m.key, null); return; }
                      // Route via the migrate dialog so old rows move too.
                      setMigrateFor({ moduleKey: m.key, externalDbId: target, dbName: dbs.find(d => d.id === target)?.name ?? "" });
                    }}
                    disabled={!m.wired || busy === `route-${m.key}`}
                  >
                    <SelectTrigger className="w-64" data-testid={`select-routing-${m.key}`}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="central">القاعدة المركزية (الافتراضي)</SelectItem>
                      {dbs.filter(d => d.status === "ok").map(d => <SelectItem key={d.id} value={String(d.id)}>{d.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {busy === `route-${m.key}` || busy === `migrate-${m.key}` ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                </div>
              </div>
            );
          })}
          <p className="text-xs text-muted-foreground">
            التوجيه يشمل كل الشركات. عند اختيار قاعدة خارجية سيتم أولًا نقل البيانات الحالية إليها ثم تحويل القراءة والكتابة — بدون توقف للنظام.
          </p>
        </CardContent>
      </Card>

      {/* Add DB dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent dir="rtl">
          <DialogHeader><DialogTitle>قاعدة بيانات خارجية جديدة</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>الاسم التعريفي</Label>
              <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="مثال: قاعدة الأرشيف - Neon" data-testid="input-extdb-name" /></div>
            <div><Label>رابط الاتصال (Connection String)</Label>
              <Input dir="ltr" value={form.connectionString} onChange={e => setForm({ ...form, connectionString: e.target.value })} placeholder="postgresql://user:pass@host:5432/dbname" data-testid="input-extdb-conn" />
              <p className="text-xs text-muted-foreground mt-1">يُخزَّن مشفرًا ولا يُعرض مرة أخرى بعد الحفظ. سيُفحص الاتصال قبل الحفظ.</p></div>
            <div><Label>ملاحظات (اختياري)</Label>
              <Input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></div>
          </div>
          <DialogFooter>
            <Button onClick={addDb} disabled={saving || !form.name.trim() || !form.connectionString.trim()} data-testid="button-save-extdb">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "فحص وحفظ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Migrate + route confirm dialog */}
      <Dialog open={!!migrateFor} onOpenChange={(v) => { if (!v) setMigrateFor(null); }}>
        <DialogContent dir="rtl">
          <DialogHeader><DialogTitle>نقل البيانات وتوجيه الموديول</DialogTitle></DialogHeader>
          <p className="text-sm">
            سيتم نسخ كل بيانات الموديول الحالية من القاعدة المركزية إلى «{migrateFor?.dbName}»، ثم التحقق من الأعداد، ثم تحويل القراءة والكتابة إليها.
            الملفات نفسها تبقى في التخزين السحابي — يُنقل الفهرس فقط. هل تريد المتابعة؟
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMigrateFor(null)}>إلغاء</Button>
            <Button onClick={runMigrate} disabled={busy === `migrate-${migrateFor?.moduleKey}`} data-testid="button-confirm-migrate">
              {busy === `migrate-${migrateFor?.moduleKey}` ? <Loader2 className="h-4 w-4 animate-spin" /> : "نقل وتوجيه"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
