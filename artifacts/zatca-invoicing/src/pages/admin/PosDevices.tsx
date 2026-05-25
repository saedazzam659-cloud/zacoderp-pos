import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchCombobox } from "@/components/ui/search-combobox";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Copy, KeyRound, Monitor, RefreshCw, Plus, Trash2, ShieldOff, Calendar,
  Download, Wifi, WifiOff, Cpu, Globe, Clock, Pencil,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Stats = {
  totalLicenses: number; activeLicenses: number; unassignedLicenses: number;
  revokedLicenses: number; totalDevices: number; activeDevices: number; onlineDevices: number;
};
type License = {
  id: number; licenseKey: string; companyId: number | null; companyName: string | null;
  deviceId: number | null; status: string; plan: string;
  issuedAt: string; activatedAt: string | null; expiresAt: string | null;
  revokedAt: string | null; notes: string | null;
};
type Device = {
  id: number; companyId: number; companyName: string | null; branchId: number | null;
  deviceName: string; status: string; appVersion: string | null; osInfo: string | null;
  fingerprintHash: string; lastHeartbeatAt: string | null; lastSeenIp: string | null;
  lastSyncAt: string | null; licenseId: number | null; createdAt: string;
};
type Release = {
  id: number; countryCode: string; platform: string; version: string;
  downloadUrl: string; fileSizeBytes: number | null; checksumSha256: string | null;
  releaseNotes: string | null; isActive: boolean; publishedAt: string;
};

export default function PosDevices() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const statsQ = useQuery<Stats>({
    queryKey: ["pos-devices-stats"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/pos-devices/stats`, { headers });
      if (!r.ok) throw new Error("فشل تحميل الإحصائيات");
      return r.json();
    },
    refetchInterval: 30000,
  });

  return (
    <div className="p-6 space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">إدارة أجهزة POS — نسخة Windows</h1>
          <p className="text-sm text-muted-foreground mt-1">
            تراخيص الأجهزة، الأجهزة المفعّلة، سجلات المزامنة، وروابط التحميل لكل دولة
          </p>
        </div>
        <Button variant="outline" onClick={() => { qc.invalidateQueries(); }}>
          <RefreshCw className="ml-2 h-4 w-4" /> تحديث
        </Button>
      </div>

      {/* ─── Stats cards ─── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="إجمالي التراخيص" value={statsQ.data?.totalLicenses ?? 0} color="bg-blue-50 text-blue-700" />
        <StatCard label="تراخيص نشطة" value={statsQ.data?.activeLicenses ?? 0} color="bg-green-50 text-green-700" />
        <StatCard label="تراخيص غير مخصصة" value={statsQ.data?.unassignedLicenses ?? 0} color="bg-amber-50 text-amber-700" />
        <StatCard label="تراخيص ملغاة" value={statsQ.data?.revokedLicenses ?? 0} color="bg-rose-50 text-rose-700" />
        <StatCard label="إجمالي الأجهزة" value={statsQ.data?.totalDevices ?? 0} color="bg-indigo-50 text-indigo-700" />
        <StatCard label="أجهزة نشطة" value={statsQ.data?.activeDevices ?? 0} color="bg-emerald-50 text-emerald-700" />
        <StatCard label="متصلة الآن (آخر 5د)" value={statsQ.data?.onlineDevices ?? 0} color="bg-teal-50 text-teal-700" />
        <StatCard label="معطّلة"
          value={(statsQ.data?.totalDevices ?? 0) - (statsQ.data?.activeDevices ?? 0)}
          color="bg-gray-50 text-gray-700" />
      </div>

      <Tabs defaultValue="licenses" className="w-full">
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="licenses"><KeyRound className="ml-2 h-4 w-4" /> التراخيص</TabsTrigger>
          <TabsTrigger value="devices"><Monitor className="ml-2 h-4 w-4" /> الأجهزة</TabsTrigger>
          <TabsTrigger value="sessions"><Clock className="ml-2 h-4 w-4" /> جلسات البيع</TabsTrigger>
          <TabsTrigger value="releases"><Download className="ml-2 h-4 w-4" /> روابط التحميل</TabsTrigger>
          <TabsTrigger value="logs"><Cpu className="ml-2 h-4 w-4" /> سجل المزامنة</TabsTrigger>
        </TabsList>
        <TabsContent value="licenses" className="mt-4"><LicensesTab headers={headers} /></TabsContent>
        <TabsContent value="devices"  className="mt-4"><DevicesTab  headers={headers} /></TabsContent>
        <TabsContent value="sessions" className="mt-4"><SessionsTab headers={headers} /></TabsContent>
        <TabsContent value="releases" className="mt-4"><ReleasesTab headers={headers} /></TabsContent>
        <TabsContent value="logs"     className="mt-4"><LogsTab     headers={headers} /></TabsContent>
      </Tabs>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <Card><CardContent className="p-4">
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className={`inline-flex items-center justify-center min-w-[40px] h-7 px-2 rounded-md font-bold ${color}`}>
        {value.toLocaleString("ar-EG")}
      </div>
    </CardContent></Card>
  );
}

// ════════════════════════════════════════════════════════════════════
// LICENSES TAB
// ════════════════════════════════════════════════════════════════════
function LicensesTab({ headers }: { headers: Record<string, string> }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showGen, setShowGen] = useState(false);
  const [genCount, setGenCount] = useState(1);
  const [genPlan, setGenPlan] = useState("pos_full");
  const [genExpires, setGenExpires] = useState("");
  const [genCompanyId, setGenCompanyId] = useState("");
  const [genNotes, setGenNotes] = useState("");
  const [assignFor, setAssignFor] = useState<License | null>(null);
  const [assignCompanyId, setAssignCompanyId] = useState("");
  const [extendFor, setExtendFor] = useState<License | null>(null);
  const [extendDate, setExtendDate] = useState("");

  const licensesQ = useQuery<License[]>({
    queryKey: ["device-licenses"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/pos-devices/licenses`, { headers });
      if (!r.ok) throw new Error("فشل تحميل التراخيص");
      return r.json();
    },
  });

  // Companies dropdown — populates both the "generate" and "assign" dialogs.
  // SuperAdmin sees every non-deleted tenant.
  const companiesQ = useQuery<Array<{ id: number; nameAr: string; nameEn: string | null; enableOfflinePos?: boolean }>>({
    queryKey: ["companies-for-pos-licenses"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/companies`, { headers });
      if (!r.ok) throw new Error("فشل تحميل الشركات");
      return r.json();
    },
  });
  const companyItems = useMemo(
    () => (companiesQ.data ?? []).map((c) => ({
      value: String(c.id),
      label: `${c.nameAr}${c.nameEn ? ` — ${c.nameEn}` : ""} (#${c.id})`,
      badge: c.enableOfflinePos ? "POS مفعّل" : "POS غير مفعّل",
      badgeClass: c.enableOfflinePos ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700",
    })),
    [companiesQ.data],
  );

  const genMut = useMutation({
    mutationFn: async () => {
      const body: any = { count: genCount, plan: genPlan };
      if (genExpires) body.expiresAt = new Date(genExpires + "T23:59:59").toISOString();
      if (genCompanyId.trim()) body.companyId = Number(genCompanyId);
      if (genNotes.trim()) body.notes = genNotes;
      const r = await fetch(`${API}/api/admin/pos-devices/licenses/generate`, { method: "POST", headers, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json()).error || "فشل التوليد");
      return r.json();
    },
    onSuccess: (d) => {
      toast({ title: "تم توليد التراخيص", description: `عدد ${d.created?.length || 0}` });
      qc.invalidateQueries({ queryKey: ["device-licenses"] });
      qc.invalidateQueries({ queryKey: ["pos-devices-stats"] });
      setShowGen(false);
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const assignMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/pos-devices/licenses/${assignFor!.id}/assign`, {
        method: "POST", headers, body: JSON.stringify({ companyId: Number(assignCompanyId) }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "فشل التخصيص");
    },
    onSuccess: () => {
      toast({ title: "تم تخصيص الترخيص" });
      qc.invalidateQueries({ queryKey: ["device-licenses"] });
      setAssignFor(null); setAssignCompanyId("");
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const revokeMut = useMutation({
    mutationFn: async (id: number) => {
      if (!confirm("هل أنت متأكد من إلغاء هذا الترخيص؟ سيتم تعطيل الجهاز المرتبط فوراً.")) throw new Error("cancelled");
      const r = await fetch(`${API}/api/admin/pos-devices/licenses/${id}/revoke`, { method: "POST", headers });
      if (!r.ok) throw new Error((await r.json()).error || "فشل الإلغاء");
    },
    onSuccess: () => { toast({ title: "تم إلغاء الترخيص" }); qc.invalidateQueries({ queryKey: ["device-licenses"] }); },
    onError: (e: any) => { if (e.message !== "cancelled") toast({ title: "خطأ", description: e.message, variant: "destructive" }); },
  });

  const extendMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/pos-devices/licenses/${extendFor!.id}/extend`, {
        method: "POST", headers,
        body: JSON.stringify({ expiresAt: new Date(extendDate + "T23:59:59").toISOString() }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "فشل التمديد");
    },
    onSuccess: () => { toast({ title: "تم التمديد" }); qc.invalidateQueries({ queryKey: ["device-licenses"] }); setExtendFor(null); setExtendDate(""); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  // Toggle companies.enable_offline_pos for a single company. The desktop
  // /activate call hard-rejects with 403 when this flag is false, so this
  // one-click switch sits right next to each license row whose linked
  // company hasn't been opted in yet.
  const flagMut = useMutation({
    mutationFn: async ({ companyId, enable }: { companyId: number; enable: boolean }) => {
      const r = await fetch(`${API}/api/admin/pos-devices/company/${companyId}/offline-pos-flag`, {
        method: "PATCH", headers,
        body: JSON.stringify({ enableOfflinePos: enable }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "فشل تحديث الإعداد");
    },
    onSuccess: (_d, v) => {
      toast({
        title: v.enable ? "تم تفعيل POS المكتبي للشركة" : "تم تعطيل POS المكتبي للشركة",
        description: v.enable ? "يمكن الآن تفعيل أي ترخيص مرتبط بهذه الشركة من تطبيق سطح المكتب." : undefined,
      });
      qc.invalidateQueries({ queryKey: ["companies-for-pos-licenses"] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  function companyFlagFor(companyId: number | null) {
    if (!companyId) return null;
    return companiesQ.data?.find((c) => c.id === companyId)?.enableOfflinePos ?? null;
  }

  function copy(s: string) { navigator.clipboard.writeText(s); toast({ title: "تم النسخ" }); }
  function statusBadge(s: string) {
    const map: Record<string, string> = {
      unassigned: "bg-gray-100 text-gray-700",
      assigned: "bg-blue-100 text-blue-700",
      active: "bg-green-100 text-green-700",
      revoked: "bg-rose-100 text-rose-700",
      expired: "bg-amber-100 text-amber-700",
    };
    return <Badge className={map[s] ?? ""}>{s}</Badge>;
  }

  return (
    <Card><CardContent className="p-4 space-y-3">
      <div className="flex justify-between items-center">
        <div className="text-sm text-muted-foreground">إجمالي: {licensesQ.data?.length || 0}</div>
        <Button onClick={() => setShowGen(true)}><Plus className="ml-2 h-4 w-4" /> توليد تراخيص</Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr>
              <th className="p-2 text-right">#</th>
              <th className="p-2 text-right">مفتاح الترخيص</th>
              <th className="p-2 text-right">الشركة</th>
              <th className="p-2 text-right">الخطة</th>
              <th className="p-2 text-right">الحالة</th>
              <th className="p-2 text-right">انتهاء</th>
              <th className="p-2 text-right">الإجراءات</th>
            </tr>
          </thead>
          <tbody>
            {(licensesQ.data ?? []).map((l) => (
              <tr key={l.id} className="border-t">
                <td className="p-2">{l.id}</td>
                <td className="p-2">
                  <div className="flex items-center gap-2">
                    <code className="text-xs bg-muted px-2 py-1 rounded">{l.licenseKey}</code>
                    <button onClick={() => copy(l.licenseKey)} className="text-muted-foreground hover:text-foreground">
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </td>
                <td className="p-2">
                  {l.companyName ? (
                    <div className="flex flex-col gap-1">
                      <span>{l.companyName}</span>
                      {companyFlagFor(l.companyId) === false && (
                        <div className="flex items-center gap-2">
                          <Badge className="bg-amber-100 text-amber-800 text-[10px]">POS غير مفعّل</Badge>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[11px] bg-green-50 hover:bg-green-100 border-green-300 text-green-800"
                            onClick={() => flagMut.mutate({ companyId: l.companyId!, enable: true })}
                            disabled={flagMut.isPending}
                          >
                            تفعيل الآن
                          </Button>
                        </div>
                      )}
                      {companyFlagFor(l.companyId) === true && (
                        <Badge className="bg-green-100 text-green-800 text-[10px]">POS مفعّل ✓</Badge>
                      )}
                    </div>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="p-2 text-xs">{l.plan}</td>
                <td className="p-2">{statusBadge(l.status)}</td>
                <td className="p-2 text-xs">{l.expiresAt ? new Date(l.expiresAt).toLocaleDateString("ar-SA") : "—"}</td>
                <td className="p-2 space-x-1 space-x-reverse">
                  {!l.companyId && l.status === "unassigned" && (
                    <Button size="sm" variant="outline" onClick={() => setAssignFor(l)}>تخصيص</Button>
                  )}
                  {l.status !== "revoked" && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => { setExtendFor(l); setExtendDate(l.expiresAt ? l.expiresAt.substring(0,10) : ""); }}>
                        <Calendar className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => revokeMut.mutate(l.id)}>
                        <ShieldOff className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {licensesQ.data?.length === 0 && (
              <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">لا توجد تراخيص. ابدأ بتوليد دفعة جديدة.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Generate dialog */}
      <Dialog open={showGen} onOpenChange={setShowGen}>
        <DialogContent dir="rtl">
          <DialogHeader>
            <DialogTitle>توليد تراخيص جديدة</DialogTitle>
            <DialogDescription>يتم إنشاء مفاتيح فريدة. اتركها غير مخصصة لشركة أو خصصها مباشرة.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div><Label>العدد</Label><Input type="number" min={1} max={100} value={genCount} onChange={(e) => setGenCount(Number(e.target.value))} /></div>
            <div><Label>الخطة</Label>
              <Select value={genPlan} onValueChange={setGenPlan}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pos_basic">POS Basic</SelectItem>
                  <SelectItem value="pos_full">POS Full</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div><Label>تاريخ الانتهاء (اختياري)</Label><Input type="date" value={genExpires} onChange={(e) => setGenExpires(e.target.value)} /></div>
            <div>
              <Label>الشركة (اختياري)</Label>
              <SearchCombobox
                items={[{ value: "", label: "— غير مخصصة —" }, ...companyItems]}
                value={genCompanyId}
                onValueChange={setGenCompanyId}
                placeholder={companiesQ.isLoading ? "جارٍ التحميل..." : "ابحث باسم الشركة أو رقمها..."}
                searchPlaceholder="اكتب للبحث..."
                emptyText="لا توجد شركات مطابقة"
              />
              <p className="text-xs text-muted-foreground mt-1">
                تخصيص الترخيص لشركة مباشرة يوفّر خطوة "تخصيص" اللاحقة، ويظهر الترخيص بحالة "نشط" فور التوليد.
              </p>
            </div>
            <div><Label>ملاحظات</Label><Textarea value={genNotes} onChange={(e) => setGenNotes(e.target.value)} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowGen(false)}>إلغاء</Button>
            <Button onClick={() => genMut.mutate()} disabled={genMut.isPending}>{genMut.isPending ? "..." : "توليد"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Assign dialog */}
      <Dialog open={!!assignFor} onOpenChange={(o) => !o && setAssignFor(null)}>
        <DialogContent dir="rtl">
          <DialogHeader><DialogTitle>تخصيص ترخيص لشركة</DialogTitle></DialogHeader>
          <div>
            <Label>الشركة</Label>
            <SearchCombobox
              items={companyItems}
              value={assignCompanyId}
              onValueChange={setAssignCompanyId}
              placeholder={companiesQ.isLoading ? "جارٍ التحميل..." : "ابحث باسم الشركة أو رقمها..."}
              searchPlaceholder="اكتب للبحث..."
              emptyText="لا توجد شركات"
            />
            <p className="text-xs text-amber-600 mt-2">
              ⚠️ تأكّد أن خاصية "تفعيل نقاط البيع المكتبية" (enable_offline_pos) مفعّلة في إعدادات الشركة، وإلا سيرفض الجهاز التفعيل برسالة 403.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignFor(null)}>إلغاء</Button>
            <Button onClick={() => assignMut.mutate()} disabled={!assignCompanyId || assignMut.isPending}>تخصيص</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Extend dialog */}
      <Dialog open={!!extendFor} onOpenChange={(o) => !o && setExtendFor(null)}>
        <DialogContent dir="rtl">
          <DialogHeader><DialogTitle>تمديد الترخيص</DialogTitle></DialogHeader>
          <div><Label>تاريخ انتهاء جديد</Label><Input type="date" value={extendDate} onChange={(e) => setExtendDate(e.target.value)} /></div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExtendFor(null)}>إلغاء</Button>
            <Button onClick={() => extendMut.mutate()} disabled={!extendDate || extendMut.isPending}>تمديد</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </CardContent></Card>
  );
}

// ════════════════════════════════════════════════════════════════════
// DEVICES TAB
// ════════════════════════════════════════════════════════════════════
function DevicesTab({ headers }: { headers: Record<string, string> }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const devicesQ = useQuery<Device[]>({
    queryKey: ["pos-devices"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/pos-devices/devices`, { headers });
      if (!r.ok) throw new Error("فشل تحميل الأجهزة");
      return r.json();
    },
    refetchInterval: 30000,
  });

  const unbindMut = useMutation({
    mutationFn: async (id: number) => {
      if (!confirm("هل أنت متأكد من فصل هذا الجهاز؟ سيخسر الوصول فوراً ويمكن إعادة تفعيل الترخيص لجهاز آخر.")) throw new Error("cancelled");
      const r = await fetch(`${API}/api/admin/pos-devices/devices/${id}/unbind`, { method: "POST", headers });
      if (!r.ok) throw new Error((await r.json()).error || "فشل الفصل");
    },
    onSuccess: () => { toast({ title: "تم فصل الجهاز" }); qc.invalidateQueries({ queryKey: ["pos-devices"] }); qc.invalidateQueries({ queryKey: ["device-licenses"] }); },
    onError: (e: any) => { if (e.message !== "cancelled") toast({ title: "خطأ", description: e.message, variant: "destructive" }); },
  });

  function isOnline(d: Device): boolean {
    if (!d.lastHeartbeatAt) return false;
    return Date.now() - new Date(d.lastHeartbeatAt).getTime() < 5 * 60 * 1000;
  }

  return (
    <Card><CardContent className="p-4">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr>
              <th className="p-2 text-right">#</th>
              <th className="p-2 text-right">حالة الاتصال</th>
              <th className="p-2 text-right">اسم الجهاز</th>
              <th className="p-2 text-right">الشركة</th>
              <th className="p-2 text-right">الإصدار</th>
              <th className="p-2 text-right">آخر نبضة</th>
              <th className="p-2 text-right">آخر مزامنة</th>
              <th className="p-2 text-right">الحالة</th>
              <th className="p-2 text-right">الإجراءات</th>
            </tr>
          </thead>
          <tbody>
            {(devicesQ.data ?? []).map((d) => (
              <tr key={d.id} className="border-t">
                <td className="p-2">{d.id}</td>
                <td className="p-2">{isOnline(d)
                  ? <span className="inline-flex items-center text-green-700 text-xs"><Wifi className="ml-1 h-3 w-3" /> متصل</span>
                  : <span className="inline-flex items-center text-muted-foreground text-xs"><WifiOff className="ml-1 h-3 w-3" /> غير متصل</span>}
                </td>
                <td className="p-2 font-medium">{d.deviceName}</td>
                <td className="p-2">{d.companyName ?? `#${d.companyId}`}</td>
                <td className="p-2 text-xs">{d.appVersion ?? "—"}</td>
                <td className="p-2 text-xs">{d.lastHeartbeatAt ? new Date(d.lastHeartbeatAt).toLocaleString("ar-SA") : "—"}</td>
                <td className="p-2 text-xs">{d.lastSyncAt ? new Date(d.lastSyncAt).toLocaleString("ar-SA") : "—"}</td>
                <td className="p-2"><Badge variant={d.status === "active" ? "default" : "secondary"}>{d.status}</Badge></td>
                <td className="p-2">
                  {d.status === "active" && (
                    <Button size="sm" variant="destructive" onClick={() => unbindMut.mutate(d.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {devicesQ.data?.length === 0 && (
              <tr><td colSpan={9} className="p-8 text-center text-muted-foreground">لا توجد أجهزة مفعّلة بعد.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </CardContent></Card>
  );
}

// ════════════════════════════════════════════════════════════════════
// RELEASES TAB
// ════════════════════════════════════════════════════════════════════
function ReleasesTab({ headers }: { headers: Record<string, string> }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const emptyForm = { countryCode: "SA", platform: "win-x64", version: "", downloadUrl: "", releaseNotes: "", isActive: true };
  const [form, setForm] = useState(emptyForm);

  const releasesQ = useQuery<Release[]>({
    queryKey: ["download-releases"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/pos-devices/releases`, { headers });
      if (!r.ok) throw new Error("فشل تحميل الإصدارات");
      return r.json();
    },
  });

  const saveMut = useMutation({
    mutationFn: async () => {
      const url = editingId
        ? `${API}/api/admin/pos-devices/releases/${editingId}`
        : `${API}/api/admin/pos-devices/releases`;
      const method = editingId ? "PATCH" : "POST";
      const r = await fetch(url, { method, headers, body: JSON.stringify(form) });
      if (!r.ok) throw new Error((await r.json()).error || (editingId ? "فشل التعديل" : "فشل الإضافة"));
    },
    onSuccess: () => {
      toast({ title: editingId ? "تم تعديل الإصدار" : "تمت إضافة الإصدار" });
      qc.invalidateQueries({ queryKey: ["download-releases"] });
      setShowAdd(false);
      setEditingId(null);
      setForm(emptyForm);
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const openEdit = (r: Release) => {
    setEditingId(r.id);
    setForm({
      countryCode: r.countryCode,
      platform: r.platform,
      version: r.version,
      downloadUrl: r.downloadUrl,
      releaseNotes: r.releaseNotes ?? "",
      isActive: r.isActive,
    });
    setShowAdd(true);
  };
  const openAdd = () => { setEditingId(null); setForm(emptyForm); setShowAdd(true); };

  const delMut = useMutation({
    mutationFn: async (id: number) => {
      if (!confirm("حذف هذا الإصدار؟")) throw new Error("cancelled");
      const r = await fetch(`${API}/api/admin/pos-devices/releases/${id}`, { method: "DELETE", headers });
      if (!r.ok) throw new Error("فشل الحذف");
    },
    onSuccess: () => { toast({ title: "تم الحذف" }); qc.invalidateQueries({ queryKey: ["download-releases"] }); },
    onError: (e: any) => { if (e.message !== "cancelled") toast({ title: "خطأ", description: e.message, variant: "destructive" }); },
  });

  const syncMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/pos-devices/releases/sync`, { method: "POST", headers });
      if (!r.ok) throw new Error((await r.json()).error || "فشل المزامنة");
      return r.json() as Promise<{ inserted?: boolean; alreadySynced?: boolean; version?: string; reason?: string; latestTag?: string | null }>;
    },
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ["download-releases"] });
      if (s.inserted) toast({ title: "تمت المزامنة", description: `تمت إضافة الإصدار ${s.version} من GitHub` });
      else if (s.alreadySynced) toast({ title: "محدّث", description: `أحدث إصدار (${s.version}) موجود بالفعل` });
      else toast({ title: "لا توجد إصدارات جديدة", description: s.reason ?? "لم يتم العثور على إصدار مناسب على GitHub" });
    },
    onError: (e: any) => toast({ title: "خطأ في المزامنة", description: e.message, variant: "destructive" }),
  });

  return (
    <Card><CardContent className="p-4 space-y-3">
      <div className="flex justify-between items-center gap-2">
        <p className="text-sm text-muted-foreground">روابط تنزيل المثبّت لكل دولة. استخدم رمز <code>ALL</code> كرابط احتياطي عام. النظام يتزامن تلقائياً مع GitHub كل ساعة.</p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => syncMut.mutate()} disabled={syncMut.isPending}>
            <RefreshCw className={`ml-2 h-4 w-4 ${syncMut.isPending ? "animate-spin" : ""}`} />
            {syncMut.isPending ? "جاري المزامنة…" : "مزامنة من GitHub"}
          </Button>
          <Button onClick={openAdd}><Plus className="ml-2 h-4 w-4" /> إضافة إصدار</Button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr>
              <th className="p-2 text-right">الدولة</th>
              <th className="p-2 text-right">المنصة</th>
              <th className="p-2 text-right">الإصدار</th>
              <th className="p-2 text-right">الرابط</th>
              <th className="p-2 text-right">نشط</th>
              <th className="p-2 text-right">منشور</th>
              <th className="p-2 text-right"></th>
            </tr>
          </thead>
          <tbody>
            {(releasesQ.data ?? []).map((r) => (
              <tr key={r.id} className="border-t">
                <td className="p-2"><Badge variant="outline">{r.countryCode}</Badge></td>
                <td className="p-2 text-xs">{r.platform}</td>
                <td className="p-2 font-mono text-xs">{r.version}</td>
                <td className="p-2 text-xs truncate max-w-[300px]"><a href={r.downloadUrl} className="text-blue-600 hover:underline" target="_blank" rel="noreferrer">{r.downloadUrl}</a></td>
                <td className="p-2">{r.isActive ? <Badge className="bg-green-100 text-green-700">نعم</Badge> : <Badge variant="secondary">لا</Badge>}</td>
                <td className="p-2 text-xs">{new Date(r.publishedAt).toLocaleDateString("ar-SA")}</td>
                <td className="p-2">
                  <div className="flex gap-1 justify-end">
                    <Button size="sm" variant="outline" onClick={() => openEdit(r)}><Pencil className="h-3.5 w-3.5" /></Button>
                    <Button size="sm" variant="destructive" onClick={() => delMut.mutate(r.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                </td>
              </tr>
            ))}
            {releasesQ.data?.length === 0 && (
              <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">لم تضف بعد أي رابط تنزيل.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={showAdd} onOpenChange={(o) => { setShowAdd(o); if (!o) { setEditingId(null); setForm(emptyForm); } }}>
        <DialogContent dir="rtl">
          <DialogHeader><DialogTitle>{editingId ? "تعديل الإصدار" : "إضافة إصدار جديد"}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>رمز الدولة (ISO-2)</Label><Input value={form.countryCode} onChange={(e) => setForm({ ...form, countryCode: e.target.value.toUpperCase() })} placeholder="SA / AE / ALL" /></div>
            <div><Label>المنصة</Label><Input value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })} /></div>
            <div><Label>الإصدار</Label><Input value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} placeholder="1.0.0" /></div>
            <div><Label>رابط التنزيل (https)</Label><Input value={form.downloadUrl} onChange={(e) => setForm({ ...form, downloadUrl: e.target.value })} /></div>
            <div><Label>ملاحظات الإصدار</Label><Textarea value={form.releaseNotes} onChange={(e) => setForm({ ...form, releaseNotes: e.target.value })} /></div>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
              <span>نشط</span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>إلغاء</Button>
            <Button onClick={() => saveMut.mutate()} disabled={!form.version || !form.downloadUrl || saveMut.isPending}>{editingId ? "حفظ التعديلات" : "إضافة"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </CardContent></Card>
  );
}

// ════════════════════════════════════════════════════════════════════
// LOGS TAB
// ════════════════════════════════════════════════════════════════════
function LogsTab({ headers }: { headers: Record<string, string> }) {
  const logsQ = useQuery<any[]>({
    queryKey: ["sync-logs"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/pos-devices/sync-logs?limit=200`, { headers });
      if (!r.ok) throw new Error("فشل التحميل");
      return r.json();
    },
    refetchInterval: 15000,
  });

  return (
    <Card><CardContent className="p-4">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr>
              <th className="p-2 text-right">#</th>
              <th className="p-2 text-right">الوقت</th>
              <th className="p-2 text-right">الجهاز</th>
              <th className="p-2 text-right">الاتجاه</th>
              <th className="p-2 text-right">النوع</th>
              <th className="p-2 text-right">العدد</th>
              <th className="p-2 text-right">المدة (ms)</th>
              <th className="p-2 text-right">الحالة</th>
              <th className="p-2 text-right">الخطأ</th>
            </tr>
          </thead>
          <tbody>
            {(logsQ.data ?? []).map((l: any) => (
              <tr key={l.id} className="border-t">
                <td className="p-2">{l.id}</td>
                <td className="p-2 text-xs">{new Date(l.createdAt).toLocaleString("ar-SA")}</td>
                <td className="p-2">{l.deviceId ?? "—"}</td>
                <td className="p-2"><Badge variant="outline">{l.direction}</Badge></td>
                <td className="p-2 text-xs">{l.entityType ?? "—"}</td>
                <td className="p-2">{l.payloadCount}</td>
                <td className="p-2 text-xs">{l.durationMs ?? "—"}</td>
                <td className="p-2"><Badge className={l.status === "ok" ? "bg-green-100 text-green-700" : "bg-rose-100 text-rose-700"}>{l.status}</Badge></td>
                <td className="p-2 text-xs text-rose-700">{l.errorMessage ?? ""}</td>
              </tr>
            ))}
            {logsQ.data?.length === 0 && (
              <tr><td colSpan={9} className="p-8 text-center text-muted-foreground">لا توجد سجلات مزامنة بعد.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </CardContent></Card>
  );
}

// ════════════════════════════════════════════════════════════════════
// SESSIONS TAB — POS sessions, with auto-closed ones highlighted so
// SuperAdmins can see at a glance which sessions were reaped by the
// server-side janitor (cashier app died, no heartbeat for N minutes)
// versus closed cleanly by the cashier.
// ════════════════════════════════════════════════════════════════════
type PosSessionRow = {
  id: number; companyId: number; userId: number; branchId: number | null;
  status: "open" | "closed" | "force_closed";
  openingCash: string; closingCash: string | null; expectedCash: string | null; difference: string | null;
  openedAt: string; closedAt: string | null;
  lastHeartbeatAt: string | null;
  closeReason: string | null;
  closedNotes: string | null;
  user?: { id: number; username: string; nameAr: string | null } | null;
  branch?: { id: number; nameAr: string | null } | null;
  invoiceCount?: number;
  totalSales?: number;
};

const CLOSE_REASON_LABEL_AR: Record<string, string> = {
  cashier_logout: "إغلاق طبيعي",
  cashier_logout_deferred: "إغلاق مؤجَّل (عاد للاتصال)",
  auto_closed_stale_heartbeat: "إغلاق تلقائي (انقطاع نبضات)",
  admin_force_close: "إغلاق إداري قسري",
};

function SessionsTab({ headers }: { headers: Record<string, string> }) {
  const [status, setStatus] = useState<string>("");
  const sessionsQ = useQuery<PosSessionRow[]>({
    queryKey: ["pos-sessions-admin", status],
    queryFn: async () => {
      const qs = status ? `?status=${encodeURIComponent(status)}` : "";
      const r = await fetch(`${API}/api/pos-sessions${qs}`, { headers });
      if (!r.ok) throw new Error("فشل تحميل الجلسات");
      return r.json();
    },
    refetchInterval: 30_000,
  });

  return (
    <Card><CardContent className="p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Label className="text-sm">الحالة:</Label>
        <Select value={status || "all"} onValueChange={(v) => setStatus(v === "all" ? "" : v)}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">الكل</SelectItem>
            <SelectItem value="open">مفتوحة</SelectItem>
            <SelectItem value="closed">مُغلقة</SelectItem>
            <SelectItem value="force_closed">قسرية / تلقائية</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={() => sessionsQ.refetch()}>
          <RefreshCw className="ml-1 h-4 w-4" /> تحديث
        </Button>
        <div className="ms-auto text-xs text-muted-foreground">
          الجلسات التي يغلقها النظام تلقائياً تظهر باللون البرتقالي. ينفذ النظام الإغلاق التلقائي عند توقف نبضات الجهاز لأكثر من 30 دقيقة.
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr>
              <th className="p-2 text-right">#</th>
              <th className="p-2 text-right">المستخدم</th>
              <th className="p-2 text-right">الفرع</th>
              <th className="p-2 text-right">الحالة</th>
              <th className="p-2 text-right">سبب الإغلاق</th>
              <th className="p-2 text-right">فُتحت</th>
              <th className="p-2 text-right">آخر نبضة</th>
              <th className="p-2 text-right">أُغلقت</th>
              <th className="p-2 text-right">الفرق</th>
            </tr>
          </thead>
          <tbody>
            {(sessionsQ.data ?? []).map((s) => {
              const isAuto = s.closeReason === "auto_closed_stale_heartbeat";
              return (
                <tr key={s.id} className={`border-t ${isAuto ? "bg-amber-50" : ""}`}>
                  <td className="p-2">{s.id}</td>
                  <td className="p-2">{s.user?.nameAr || s.user?.username || `#${s.userId}`}</td>
                  <td className="p-2">{s.branch?.nameAr ?? "—"}</td>
                  <td className="p-2">
                    <Badge className={
                      s.status === "open" ? "bg-blue-100 text-blue-700"
                      : s.status === "closed" ? "bg-green-100 text-green-700"
                      : "bg-amber-100 text-amber-700"
                    }>
                      {s.status === "open" ? "مفتوحة" : s.status === "closed" ? "مُغلقة" : "قسرية"}
                    </Badge>
                  </td>
                  <td className="p-2 text-xs">
                    {s.closeReason
                      ? (CLOSE_REASON_LABEL_AR[s.closeReason] ?? s.closeReason)
                      : (s.status === "open" ? "—" : "غير محدد")}
                  </td>
                  <td className="p-2 text-xs">{new Date(s.openedAt).toLocaleString("ar-SA")}</td>
                  <td className="p-2 text-xs">{s.lastHeartbeatAt ? new Date(s.lastHeartbeatAt).toLocaleString("ar-SA") : "—"}</td>
                  <td className="p-2 text-xs">{s.closedAt ? new Date(s.closedAt).toLocaleString("ar-SA") : "—"}</td>
                  <td className="p-2 text-xs">{s.difference ?? "—"}</td>
                </tr>
              );
            })}
            {sessionsQ.data?.length === 0 && (
              <tr><td colSpan={9} className="p-8 text-center text-muted-foreground">لا توجد جلسات بيع.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </CardContent></Card>
  );
}
