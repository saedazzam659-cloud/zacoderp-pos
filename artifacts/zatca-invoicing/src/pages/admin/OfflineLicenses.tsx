// SuperAdmin — Standalone (offline) POS license issuance (Task #199).
// Generates Ed25519-signed `.zacolic.json` files the customer drops into the
// pos-desktop standalone wizard. NO cloud sync, NO company binding.
// Pattern matches PosDevices.tsx (direct fetch + Bearer, NOT generated client).

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Download, KeyRound, ShieldOff, Trash2, Copy, RefreshCw, Plus } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type OfflineLicense = {
  id: number; licenseKey: string; customerName: string; vertical: string; plan: string;
  maxUsers: number; fingerprintHash: string | null; status: string;
  issuedAt: string; expiresAt: string | null; revokedAt: string | null;
  publicKeyFingerprint: string | null; notes: string | null;
};

type PublicKeyInfo = { publicKeyB64: string; publicKeyFingerprint: string; source: "env" | "dev-cache" };
type Stats = { total: number; active: number; revoked: number; expired: number };

export default function OfflineLicenses() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const listQ = useQuery<OfflineLicense[]>({
    queryKey: ["offline-licenses"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/offline-licenses`, { headers });
      if (!r.ok) throw new Error("فشل تحميل التراخيص");
      return r.json();
    },
  });
  const statsQ = useQuery<Stats>({
    queryKey: ["offline-licenses-stats"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/offline-licenses/stats`, { headers });
      if (!r.ok) throw new Error("");
      return r.json();
    },
  });
  const pubKeyQ = useQuery<PublicKeyInfo>({
    queryKey: ["offline-licenses-pubkey"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/offline-licenses/public-key`, { headers });
      if (!r.ok) throw new Error("فشل قراءة المفتاح العام");
      return r.json();
    },
  });

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    customerName: "", vertical: "retail", plan: "standalone_pos",
    maxUsers: 5, fingerprint: "", expiresAt: "", notes: "",
  });

  const create = useMutation({
    mutationFn: async () => {
      const body: any = {
        customerName: form.customerName,
        vertical: form.vertical, plan: form.plan,
        maxUsers: Number(form.maxUsers),
        notes: form.notes || undefined,
      };
      if (form.fingerprint.trim()) body.fingerprint = form.fingerprint.trim();
      if (form.expiresAt) body.expiresAt = new Date(form.expiresAt).toISOString();
      const r = await fetch(`${API}/api/admin/offline-licenses`, {
        method: "POST", headers, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? "فشل الإنشاء");
      return r.json();
    },
    onSuccess: (data) => {
      toast({ title: "تم إنشاء الترخيص", description: data.license.licenseKey });
      qc.invalidateQueries({ queryKey: ["offline-licenses"] });
      qc.invalidateQueries({ queryKey: ["offline-licenses-stats"] });
      setShowCreate(false);
      // Auto-download the signed file
      downloadSignedFile(data.signedFile, data.license.licenseKey);
      setForm({ customerName: "", vertical: "retail", plan: "standalone_pos", maxUsers: 5, fingerprint: "", expiresAt: "", notes: "" });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const revoke = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/admin/offline-licenses/${id}/revoke`, { method: "POST", headers });
      if (!r.ok) throw new Error("فشل الإلغاء");
    },
    onSuccess: () => {
      toast({ title: "تم إلغاء الترخيص" });
      qc.invalidateQueries({ queryKey: ["offline-licenses"] });
      qc.invalidateQueries({ queryKey: ["offline-licenses-stats"] });
    },
  });

  const del = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/admin/offline-licenses/${id}`, { method: "DELETE", headers });
      if (!r.ok) throw new Error("فشل الحذف");
    },
    onSuccess: () => {
      toast({ title: "تم الحذف" });
      qc.invalidateQueries({ queryKey: ["offline-licenses"] });
      qc.invalidateQueries({ queryKey: ["offline-licenses-stats"] });
    },
  });

  function downloadSignedFile(file: any, key: string) {
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${key}.zacolic.json`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  async function redownload(id: number, key: string) {
    const r = await fetch(`${API}/api/admin/offline-licenses/${id}/file`, { headers });
    if (!r.ok) { toast({ title: "تعذّر التنزيل", variant: "destructive" }); return; }
    const file = await r.json();
    downloadSignedFile(file, key);
  }

  return (
    <div className="p-6 space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">تراخيص POS Standalone (بدون سحابة)</h1>
          <p className="text-sm text-muted-foreground mt-1">
            إصدار ملفات ترخيص موقّعة رقمياً (Ed25519) لتشغيل تطبيق POS Desktop في وضع مستقل بدون أي ربط سحابي.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => qc.invalidateQueries()}>
            <RefreshCw className="ml-2 h-4 w-4" /> تحديث
          </Button>
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="ml-2 h-4 w-4" /> ترخيص جديد
          </Button>
        </div>
      </div>

      {/* Public key info — for embedding into POS Desktop builds */}
      {pubKeyQ.data && (
        <Card>
          <CardContent className="pt-6 space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-xs text-muted-foreground">المفتاح العام لتوقيع التراخيص (Ed25519)</Label>
                <code className="block text-xs font-mono mt-1 bg-slate-50 p-2 rounded break-all">{pubKeyQ.data.publicKeyB64}</code>
              </div>
              <Button variant="outline" size="sm" onClick={() => {
                navigator.clipboard.writeText(pubKeyQ.data!.publicKeyB64);
                toast({ title: "تم النسخ" });
              }}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <div className="text-xs text-muted-foreground">
              بصمة المفتاح: <code>{pubKeyQ.data.publicKeyFingerprint}</code> ·
              المصدر: <Badge variant={pubKeyQ.data.source === "env" ? "default" : "secondary"}>{pubKeyQ.data.source}</Badge>
              {pubKeyQ.data.source !== "env" && (
                <span className="text-amber-600 mr-2">⚠️ وضع تطوير — عيّن <code>OFFLINE_LICENSE_PRIVATE_KEY_PEM</code> في الإنتاج.</span>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              يجب تضمين هذا المفتاح في كل بناء POS Desktop عبر متغيّر البيئة <code>VITE_OFFLINE_LICENSE_PUBLIC_KEY_B64</code>.
            </div>
          </CardContent>
        </Card>
      )}

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3">
        <StatCard label="إجمالي" value={statsQ.data?.total ?? 0} />
        <StatCard label="نشط" value={statsQ.data?.active ?? 0} color="text-green-700 bg-green-50" />
        <StatCard label="ملغى" value={statsQ.data?.revoked ?? 0} color="text-red-700 bg-red-50" />
        <StatCard label="منتهٍ" value={statsQ.data?.expired ?? 0} color="text-amber-700 bg-amber-50" />
      </div>

      {/* List */}
      <Card>
        <CardContent className="pt-6">
          {listQ.isLoading && <div>جاري التحميل…</div>}
          {listQ.data && listQ.data.length === 0 && (
            <div className="text-center text-muted-foreground py-8">
              لا توجد تراخيص بعد. اضغط "ترخيص جديد" لإصدار أول ترخيص.
            </div>
          )}
          <div className="space-y-2">
            {listQ.data?.map((lic) => (
              <div key={lic.id} className="border rounded-lg p-4 flex items-center justify-between hover:bg-slate-50">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <KeyRound className="h-4 w-4 text-blue-600" />
                    <code className="font-mono text-sm font-semibold">{lic.licenseKey}</code>
                    <StatusBadge status={lic.status} />
                    <Badge variant="outline">{lic.vertical}</Badge>
                  </div>
                  <div className="text-sm font-medium">{lic.customerName}</div>
                  <div className="text-xs text-muted-foreground flex gap-3 mt-1">
                    <span>👥 {lic.maxUsers} مستخدم</span>
                    <span>📅 صدر: {new Date(lic.issuedAt).toLocaleDateString("ar-SA")}</span>
                    {lic.expiresAt && <span>⏰ ينتهي: {new Date(lic.expiresAt).toLocaleDateString("ar-SA")}</span>}
                    {lic.fingerprintHash && <span title={lic.fingerprintHash}>🔒 مربوط بجهاز</span>}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" onClick={() => redownload(lic.id, lic.licenseKey)}
                          disabled={lic.status === "revoked"} title="تنزيل ملف الترخيص الموقّع">
                    <Download className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => {
                    if (confirm(`تأكيد إلغاء الترخيص ${lic.licenseKey}؟ لن يعمل التطبيق على الأجهزة التي تستخدمه (لكن لن نعرف بذلك لأنها لا تتصل بنا).`)) revoke.mutate(lic.id);
                  }} disabled={lic.status !== "active"} title="إلغاء">
                    <ShieldOff className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => {
                    if (confirm(`حذف نهائي للترخيص ${lic.licenseKey} من قاعدة البيانات؟`)) del.mutate(lic.id);
                  }} title="حذف">
                    <Trash2 className="h-4 w-4 text-red-600" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Create dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent dir="rtl" className="max-w-lg">
          <DialogHeader>
            <DialogTitle>إصدار ترخيص Standalone جديد</DialogTitle>
            <DialogDescription>
              سيتم توليد مفتاح ترخيص وملف JSON موقّع رقمياً. حمّل الملف وسلّمه للعميل.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>اسم العميل / الشركة *</Label>
              <Input value={form.customerName} onChange={(e) => setForm({ ...form, customerName: e.target.value })} placeholder="مؤسسة الأمين التجارية" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>المجال</Label>
                <Select value={form.vertical} onValueChange={(v) => setForm({ ...form, vertical: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="retail">تجزئة عامة</SelectItem>
                    <SelectItem value="grocery">بقالة / سوبرماركت</SelectItem>
                    <SelectItem value="pharmacy">صيدلية</SelectItem>
                    <SelectItem value="restaurant">مطعم</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>الحد الأقصى للمستخدمين</Label>
                <Input type="number" min={1} max={100} value={form.maxUsers} onChange={(e) => setForm({ ...form, maxUsers: Number(e.target.value) })} />
              </div>
            </div>
            <div>
              <Label>تاريخ الانتهاء (اختياري)</Label>
              <Input type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
              <p className="text-xs text-muted-foreground mt-1">اتركه فارغاً لترخيص دائم.</p>
            </div>
            <div>
              <Label>بصمة الجهاز (اختياري — لربط الترخيص بجهاز محدد مسبقاً)</Label>
              <Input value={form.fingerprint} onChange={(e) => setForm({ ...form, fingerprint: e.target.value })} placeholder="dev-xxxx أو SHA-256" />
              <p className="text-xs text-muted-foreground mt-1">
                إن تركتها فارغة، سيقبل التطبيق الترخيص على أي جهاز يفتحه أولاً.
              </p>
            </div>
            <div>
              <Label>ملاحظات</Label>
              <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>إلغاء</Button>
            <Button onClick={() => create.mutate()} disabled={!form.customerName.trim() || create.isPending}>
              {create.isPending ? "جارٍ الإنشاء…" : "إنشاء وتنزيل الملف"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <Card><CardContent className={`pt-6 ${color ?? ""}`}>
      <div className="text-3xl font-bold">{value}</div>
      <div className="text-sm mt-1">{label}</div>
    </CardContent></Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    active: { label: "نشط", cls: "bg-green-100 text-green-800" },
    revoked: { label: "ملغى", cls: "bg-red-100 text-red-800" },
    expired: { label: "منتهٍ", cls: "bg-amber-100 text-amber-800" },
  };
  const v = map[status] ?? { label: status, cls: "bg-slate-100 text-slate-700" };
  return <span className={`text-xs px-2 py-0.5 rounded ${v.cls}`}>{v.label}</span>;
}
