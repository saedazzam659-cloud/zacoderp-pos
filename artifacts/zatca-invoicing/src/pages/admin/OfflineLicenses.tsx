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
import { Checkbox } from "@/components/ui/checkbox";
import { Download, KeyRound, ShieldOff, Trash2, Copy, RefreshCw, Plus, Pencil, Search, Check, X, Clock } from "lucide-react";
import { DateField } from "@/components/ui/date-field";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type OfflineLicense = {
  id: number; licenseKey: string; customerName: string; vertical: string; plan: string;
  maxUsers: number; fingerprintHash: string | null; status: string;
  issuedAt: string; expiresAt: string | null; revokedAt: string | null;
  publicKeyFingerprint: string | null; notes: string | null;
  // Company profile + online self-registration (Task #236)
  country: string | null; companyTaxNumber: string | null; companyCrNumber: string | null;
  companyAddress: string | null; companyPhone: string | null; companyEmail: string | null;
  source: string; graceDays: number; lastSeenAt: string | null; appVersion: string | null;
  clockUnblockAt: string | null;
  modules: string[] | null;
  appProfile?: "pos" | "erp";
  netRole?: "single" | "host" | "client";
  lanHostUrl?: string;
  lanToken?: string;
  lanPort?: number;
};

const OFFLINE_MODULES = [
  { key: "pos", label: "نقطة البيع", detail: "البيع والمرتجعات واليومية", group: "العمليات" },
  { key: "customers", label: "العملاء", detail: "ملفات العملاء والتحصيل", group: "الملفات" },
  { key: "inventory", label: "المخازن والأصناف", detail: "الأصناف والمخزون والجرد", group: "المخازن" },
  { key: "purchasing", label: "المشتريات والموردون", detail: "الموردون وأوامر وفواتير الشراء", group: "المشتريات" },
  { key: "sales_docs", label: "فواتير المبيعات", detail: "الفواتير والعروض والطلبات", group: "المبيعات" },
  { key: "cash_banks", label: "النقد والبنوك", detail: "الخزائن والبنوك والتحويلات", group: "الخزينة" },
  { key: "accounting", label: "الحسابات والتقارير", detail: "القيود والحسابات والتقارير المالية", group: "المحاسبة" },
  { key: "control", label: "التحكم والإعدادات", detail: "المستخدمون والفروع وإعدادات النظام", group: "النظام" },
  { key: "zatca", label: "زاتكا", detail: "التسجيل والإرسال المباشر للفواتير والمرتجعات", group: "السعودية" },
] as const;
const ALL_OFFLINE_MODULES: string[] = OFFLINE_MODULES
  .filter((module) => module.key !== "zatca")
  .map((module) => module.key);
function offlineModulesForCountry(country: string | null | undefined, includeZatca = true) {
  return OFFLINE_MODULES.filter((module) =>
    module.key !== "zatca" || (includeZatca && country?.toUpperCase() === "SA"),
  );
}
const COUNTRIES = [
  ["SA", "السعودية"], ["EG", "مصر"], ["AE", "الإمارات"], ["KW", "الكويت"],
  ["BH", "البحرين"], ["OM", "عُمان"], ["QA", "قطر"], ["JO", "الأردن"],
  ["IQ", "العراق"], ["YE", "اليمن"], ["LB", "لبنان"], ["SY", "سوريا"],
  ["PS", "فلسطين"], ["SD", "السودان"], ["MA", "المغرب"], ["DZ", "الجزائر"],
  ["TN", "تونس"], ["LY", "ليبيا"], ["TR", "تركيا"], ["US", "الولايات المتحدة"],
] as const;
type LicenseSetup = {
  vertical: string;
  country: string;
  appProfile: string;
  netRole: string;
  lanHostUrl: string;
  lanToken: string;
  lanPort: number;
};
function generatePairingToken() {
  return crypto.randomUUID().replaceAll("-", "").toUpperCase();
}
function isSetupComplete(setup: LicenseSetup) {
  if (!setup.vertical || !setup.country || !setup.appProfile || !setup.netRole) return false;
  if (setup.netRole === "host") return setup.lanToken.trim().length >= 8 && setup.lanPort > 0 && setup.lanPort <= 65535;
  if (setup.netRole === "client") return !!setup.lanHostUrl.trim() && setup.lanToken.trim().length >= 8;
  return true;
}
const VERTICAL_LABELS: Record<string, string> = {
  general: "نظام ERP / عام",
  grocery: "بقالة / سوبرماركت",
  pharmacy: "صيدلية",
  retail: "تجزئة عامة",
  restaurant: "مطعم",
  plumbing: "أدوات صحية وسباكة",
  paints: "دهانات وأصباغ",
  auto_parts: "قطع غيار سيارات",
  auto_workshop: "ورشة سيارات",
  mobiles: "موبايلات وإكسسوارات",
};

type PublicKeyInfo = { publicKeyB64: string; publicKeyFingerprint: string; source: "env" | "dev-cache" };
type Stats = { total: number; active: number; revoked: number; expired: number; pending: number };

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
    customerName: "", vertical: "retail", country: "SA", appProfile: "pos", netRole: "single",
    lanHostUrl: "", lanToken: "", lanPort: 7711, plan: "standalone_pos",
    maxUsers: 5, fingerprint: "", expiresAt: "", notes: "",
    companyTaxNumber: "", companyCrNumber: "",
    companyAddress: "", companyPhone: "", companyEmail: "", graceDays: 7,
    modules: [...ALL_OFFLINE_MODULES],
  });

  // Search / filter — used to narrow long lists by license key or customer name.
  const [search, setSearch] = useState("");

  // Edit dialog state — SuperAdmin uses this mainly to extend / renew the expiry.
  const [editing, setEditing] = useState<OfflineLicense | null>(null);
  const [editForm, setEditForm] = useState({
    customerName: "", vertical: "retail", country: "", appProfile: "", netRole: "",
    lanHostUrl: "", lanToken: "", lanPort: 7711, maxUsers: 5, expiresAt: "", notes: "",
    companyTaxNumber: "", companyCrNumber: "",
    companyAddress: "", companyPhone: "", companyEmail: "", graceDays: 7,
    modules: [...ALL_OFFLINE_MODULES] as string[],
    modulesExplicit: false,
  });
  function openEdit(lic: OfflineLicense) {
    setEditing(lic);
    setEditForm({
      customerName: lic.customerName,
      vertical: lic.vertical,
      country: lic.country ?? "",
      appProfile: lic.appProfile ?? "",
      netRole: lic.netRole ?? "",
      lanHostUrl: lic.lanHostUrl ?? "",
      lanToken: lic.lanToken ?? "",
      lanPort: lic.lanPort ?? 7711,
      maxUsers: lic.maxUsers,
      expiresAt: lic.expiresAt ? new Date(lic.expiresAt).toISOString().slice(0, 10) : "",
      notes: lic.notes ?? "",
      companyTaxNumber: lic.companyTaxNumber ?? "",
      companyCrNumber: lic.companyCrNumber ?? "",
      companyAddress: lic.companyAddress ?? "",
      companyPhone: lic.companyPhone ?? "",
      companyEmail: lic.companyEmail ?? "",
      graceDays: lic.graceDays ?? 7,
      modules: (lic.modules?.length ? [...lic.modules] : [...ALL_OFFLINE_MODULES])
        .filter((module) => module !== "zatca" || lic.country?.toUpperCase() === "SA"),
      modulesExplicit: !!lic.modules?.length,
    });
  }
  const edit = useMutation({
    mutationFn: async () => {
      if (!editing) return;
      const body: any = {
        customerName: editForm.customerName,
        vertical: editForm.vertical,
        country: editForm.country || null,
        appProfile: editForm.appProfile,
        netRole: editForm.netRole,
        ...(editForm.netRole === "host" ? { lanToken: editForm.lanToken, lanPort: Number(editForm.lanPort) } : {}),
        ...(editForm.netRole === "client" ? { lanHostUrl: editForm.lanHostUrl, lanToken: editForm.lanToken } : {}),
        maxUsers: Number(editForm.maxUsers),
        notes: editForm.notes,
        // empty string clears expiry (permanent license)
        expiresAt: editForm.expiresAt ? new Date(editForm.expiresAt).toISOString() : "",
        companyTaxNumber: editForm.companyTaxNumber || null,
        companyCrNumber: editForm.companyCrNumber || null,
        companyAddress: editForm.companyAddress || null,
        companyPhone: editForm.companyPhone || null,
        companyEmail: editForm.companyEmail || null,
        graceDays: Number(editForm.graceDays) || 7,
        ...(editForm.modulesExplicit ? { modules: editForm.modules } : {}),
      };
      const r = await fetch(`${API}/api/admin/offline-licenses/${editing.id}`, {
        method: "PATCH", headers, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? "فشل التعديل");
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "تم تحديث الترخيص", description: "تم إعادة توقيع الملف بأحدث القيم. حمّله من جديد وسلّمه للعميل." });
      qc.invalidateQueries({ queryKey: ["offline-licenses"] });
      qc.invalidateQueries({ queryKey: ["offline-licenses-stats"] });
      setEditing(null);
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  // ⏩ quick-extend helpers — bumps the expiry forward N days from
  // either the current expiry (if still in the future) or from today.
  function bumpExpiry(days: number) {
    const base = editForm.expiresAt && new Date(editForm.expiresAt).getTime() > Date.now()
      ? new Date(editForm.expiresAt)
      : new Date();
    base.setDate(base.getDate() + days);
    setEditForm({ ...editForm, expiresAt: base.toISOString().slice(0, 10) });
  }

  const create = useMutation({
    mutationFn: async () => {
      const body: any = {
        customerName: form.customerName,
        vertical: form.vertical, plan: form.plan,
        maxUsers: Number(form.maxUsers),
        notes: form.notes || undefined,
        country: form.country || undefined,
        appProfile: form.appProfile,
        netRole: form.netRole,
        ...(form.netRole === "host" ? { lanToken: form.lanToken, lanPort: Number(form.lanPort) } : {}),
        ...(form.netRole === "client" ? { lanHostUrl: form.lanHostUrl, lanToken: form.lanToken } : {}),
        companyTaxNumber: form.companyTaxNumber || undefined,
        companyCrNumber: form.companyCrNumber || undefined,
        companyAddress: form.companyAddress || undefined,
        companyPhone: form.companyPhone || undefined,
        companyEmail: form.companyEmail || undefined,
        graceDays: Number(form.graceDays) || 7,
        modules: form.modules,
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
      setForm({ customerName: "", vertical: "retail", country: "SA", appProfile: "pos", netRole: "single", lanHostUrl: "", lanToken: "", lanPort: 7711, plan: "standalone_pos", maxUsers: 5, fingerprint: "", expiresAt: "", notes: "", companyTaxNumber: "", companyCrNumber: "", companyAddress: "", companyPhone: "", companyEmail: "", graceDays: 7, modules: [...ALL_OFFLINE_MODULES] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  // ─── Approve a pending self-registration (Task: standalone approval gate) ──
  // A self-registered device starts as `pending` with NO signed file. The
  // SuperAdmin sets a trial duration (default 7 days, editable) OR marks it
  // permanent, then approves — which signs + issues the license file the device
  // is polling for.
  const [approving, setApproving] = useState<OfflineLicense | null>(null);
  const [approveForm, setApproveForm] = useState({
    trialDays: 7, permanent: false, vertical: "", country: "", appProfile: "", netRole: "single",
    lanHostUrl: "", lanToken: "", lanPort: 7711, modules: [...ALL_OFFLINE_MODULES] as string[],
  });
  function openApprove(lic: OfflineLicense) {
    setApproving(lic);
    setApproveForm({
      trialDays: 7, permanent: false, vertical: "", country: "", appProfile: "", netRole: "single",
      lanHostUrl: "", lanToken: "", lanPort: 7711,
      modules: (lic.modules?.length ? [...lic.modules] : [...ALL_OFFLINE_MODULES])
        .filter((module) => module !== "zatca" || lic.country?.toUpperCase() === "SA"),
    });
  }
  const approve = useMutation({
    mutationFn: async () => {
      if (!approving) return;
      const setup = {
        vertical: approveForm.vertical, country: approveForm.country,
        appProfile: approveForm.appProfile, netRole: approveForm.netRole,
        ...(approveForm.netRole === "host" ? { lanToken: approveForm.lanToken, lanPort: Number(approveForm.lanPort) } : {}),
        ...(approveForm.netRole === "client" ? { lanHostUrl: approveForm.lanHostUrl, lanToken: approveForm.lanToken } : {}),
      };
      const body = approveForm.permanent
        ? { permanent: true, modules: approveForm.modules, ...setup }
        : { trialDays: Number(approveForm.trialDays) || 7, modules: approveForm.modules, ...setup };
      const r = await fetch(`${API}/api/admin/offline-licenses/${approving.id}/approve`, {
        method: "POST", headers, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? "فشل الموافقة");
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "تمت الموافقة على الترخيص", description: "تم إصدار الملف الموقّع — سيُفعَّل الجهاز تلقائياً عند تحققه التالي." });
      qc.invalidateQueries({ queryKey: ["offline-licenses"] });
      qc.invalidateQueries({ queryKey: ["offline-licenses-stats"] });
      setApproving(null);
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

  // ── Clock-rollback unlock tooling (Task #237) ──────────────────────
  // OFFLINE: paste the device code from the locked screen → mint a signed
  // unlock code (works for ALL standalone licenses, zero internet). Reuses the
  // pos-devices endpoint — the signed code is keyed by fingerprint+nonce, not
  // by a cloud device row, so it is valid for offline file licenses too.
  const [showOfflineUnlock, setShowOfflineUnlock] = useState(false);
  const [deviceCodeInput, setDeviceCodeInput] = useState("");
  const [unlockResult, setUnlockResult] = useState<{ unlockCode: string; fingerprint: string; nonce: string } | null>(null);
  const genUnlockMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/pos-devices/generate-clock-unlock`, {
        method: "POST", headers, body: JSON.stringify({ deviceCode: deviceCodeInput.trim() }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "تعذّر توليد رمز فكّ الحظر");
      return r.json() as Promise<{ ok: true; unlockCode: string; fingerprint: string; nonce: string }>;
    },
    onSuccess: (d) => setUnlockResult({ unlockCode: d.unlockCode, fingerprint: d.fingerprint, nonce: d.nonce }),
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  // ONLINE: one click stamps clock_unblock_at; a self_register device clears its
  // clock lock on the next online revalidate. Admin files refresh signed
  // entitlements online, but use the offline signed code for clock-lock recovery.
  const onlineUnblockMut = useMutation({
    mutationFn: async (id: number) => {
      if (!confirm("فكّ حظر الساعة لهذا الترخيص عبر الإنترنت؟ سيُلغى القفل تلقائياً عند أول تحقّق أونلاين من الجهاز.")) throw new Error("cancelled");
      const r = await fetch(`${API}/api/admin/offline-licenses/${id}/clock-unblock`, { method: "POST", headers });
      if (!r.ok) throw new Error((await r.json()).error || "فشل فكّ الحظر");
    },
    onSuccess: () => { toast({ title: "تم إرسال فكّ الحظر", description: "سيُلغى قفل الساعة على الجهاز عند أول تحقّق أونلاين." }); qc.invalidateQueries({ queryKey: ["offline-licenses"] }); },
    onError: (e: any) => { if (e.message !== "cancelled") toast({ title: "خطأ", description: e.message, variant: "destructive" }); },
  });
  function copyText(s: string) { navigator.clipboard.writeText(s); toast({ title: "تم النسخ" }); }

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
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-xl md:text-2xl font-bold">تراخيص POS Standalone (بدون سحابة)</h1>
          <p className="text-sm text-muted-foreground mt-1">
            إصدار ملفات موقّعة لتشغيل POS Desktop مستقلاً؛ تبقى بيانات التشغيل محلية، ويُستخدم الإنترنت للتفعيل وتجديد الترخيص وتحديث الوحدات فقط.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <Button variant="outline" onClick={() => qc.invalidateQueries()}>
            <RefreshCw className="ml-2 h-4 w-4" /> تحديث
          </Button>
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="ml-2 h-4 w-4" /> ترخيص جديد
          </Button>
          <Button variant="outline" onClick={() => { setShowOfflineUnlock(true); setDeviceCodeInput(""); setUnlockResult(null); }}>
            <Clock className="ml-2 h-4 w-4" /> فكّ حظر الساعة (دون اتصال)
          </Button>
          <div className="relative flex-1 min-w-[12rem] md:flex-none">
            <Search className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="بحث برقم الترخيص أو اسم العميل…"
              className="w-full md:w-72 pr-8"
            />
          </div>
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
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard label="إجمالي" value={statsQ.data?.total ?? 0} />
        <StatCard label="بانتظار الموافقة" value={statsQ.data?.pending ?? 0} color="text-orange-700 bg-orange-50" />
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
          {(() => {
            const q = search.trim().toLowerCase();
            const filtered = q
              ? (listQ.data ?? []).filter((l) =>
                  l.licenseKey.toLowerCase().includes(q) ||
                  l.customerName.toLowerCase().includes(q) ||
                  (l.notes ?? "").toLowerCase().includes(q))
              : (listQ.data ?? []);
            return (
          <div className="space-y-2">
            {q && (
              <div className="text-xs text-muted-foreground mb-2">
                {filtered.length} نتيجة من أصل {listQ.data?.length ?? 0}
              </div>
            )}
            {filtered.map((lic) => (
              <div key={lic.id} className="border rounded-lg p-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between hover:bg-slate-50">
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <KeyRound className="h-4 w-4 text-blue-600 shrink-0" />
                    <code className="font-mono text-sm font-semibold break-all">{lic.licenseKey}</code>
                    <StatusBadge status={lic.status} />
                    {lic.status === "pending"
                      ? <Badge variant="outline" className="border-amber-300 text-amber-800">النشاط يحدده المشرف</Badge>
                      : <Badge variant="outline">{VERTICAL_LABELS[lic.vertical] ?? lic.vertical}</Badge>}
                    {lic.source === "self_register"
                      ? <Badge className="bg-indigo-100 text-indigo-800">سجّل ذاتياً عبر الإنترنت</Badge>
                      : <Badge variant="outline">أصدره المشرف</Badge>}
                    {lic.country && <Badge variant="outline">{lic.country}</Badge>}
                    {lic.appProfile && <Badge variant="outline">{lic.appProfile === "pos" ? "نقطة بيع فقط" : "ERP كامل"}</Badge>}
                    {lic.netRole && <Badge variant="outline">{lic.netRole === "single" ? "جهاز مستقل" : lic.netRole === "host" ? "رئيسي" : "فرعي"}</Badge>}
                  </div>
                  <div className="text-sm font-medium">{lic.customerName}</div>
                  <div className="text-xs text-muted-foreground flex gap-3 mt-1 flex-wrap">
                    <span>👥 {lic.maxUsers} مستخدم</span>
                    <span>📅 صدر: {new Date(lic.issuedAt).toLocaleDateString("ar-SA-u-ca-gregory-nu-latn")}</span>
                    {lic.expiresAt && <span>⏰ ينتهي: {new Date(lic.expiresAt).toLocaleDateString("ar-SA-u-ca-gregory-nu-latn")}</span>}
                    <span data-testid={`text-license-module-count-${lic.id}`}>الوحدات المفعّلة: {lic.status === "pending" ? "تُحدَّد عند الموافقة" : lic.modules?.length ? `${lic.modules.length} من ${offlineModulesForCountry(lic.country).length}` : "ترخيص قديم — دون تقييد"}</span>
                    {lic.fingerprintHash && <span title={lic.fingerprintHash}>🔒 مربوط بجهاز</span>}
                    <span>🕒 مهلة عدم الاتصال: {lic.graceDays ?? 7} يوم</span>
                    {lic.lastSeenAt && <span>📡 آخر اتصال: {new Date(lic.lastSeenAt).toLocaleString("ar-SA-u-ca-gregory-nu-latn")}</span>}
                    {lic.appVersion && <span>📦 الإصدار: {lic.appVersion}</span>}
                  </div>
                  {(lic.companyTaxNumber || lic.companyCrNumber || lic.companyPhone || lic.companyEmail || lic.companyAddress) && (
                    <div className="text-xs text-muted-foreground flex gap-3 mt-1 flex-wrap">
                      {lic.companyTaxNumber && <span>الرقم الضريبي: {lic.companyTaxNumber}</span>}
                      {lic.companyCrNumber && <span>س.ت: {lic.companyCrNumber}</span>}
                      {lic.companyPhone && <span>📞 {lic.companyPhone}</span>}
                      {lic.companyEmail && <span>✉️ {lic.companyEmail}</span>}
                      {lic.companyAddress && <span>📍 {lic.companyAddress}</span>}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap gap-1 md:shrink-0 md:justify-end">
                  {lic.status === "pending" && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => openApprove(lic)}
                              title="الموافقة وإصدار الترخيص" className="border-green-200">
                        <Check className="h-4 w-4 text-green-600" />
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => {
                        if (confirm(`رفض طلب التسجيل ${lic.licenseKey} وحذفه نهائياً؟ سيتمكن العميل من إرسال طلب جديد.`)) del.mutate(lic.id);
                      }} title="رفض الطلب">
                        <X className="h-4 w-4 text-red-600" />
                      </Button>
                    </>
                  )}
                  {lic.status !== "pending" && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => openEdit(lic)}
                              disabled={lic.status === "revoked"} title="تعديل / تجديد المدة">
                        <Pencil className="h-4 w-4 text-blue-600" />
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => redownload(lic.id, lic.licenseKey)}
                              disabled={lic.status === "revoked"} title="تنزيل ملف الترخيص الموقّع">
                        <Download className="h-4 w-4" />
                      </Button>
                      {lic.source === "self_register" && (
                        <Button size="sm" variant="outline"
                                className="bg-emerald-50 hover:bg-emerald-100 border-emerald-300 text-emerald-800"
                                onClick={() => onlineUnblockMut.mutate(lic.id)}
                                disabled={onlineUnblockMut.isPending}
                                title="فكّ حظر الساعة (أونلاين)">
                          <Clock className="h-4 w-4" />
                        </Button>
                      )}
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
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
            );
          })()}
        </CardContent>
      </Card>

      {/* Offline clock-unlock dialog — works for ALL standalone licenses */}
      <Dialog open={showOfflineUnlock} onOpenChange={(o) => { setShowOfflineUnlock(o); if (!o) { setDeviceCodeInput(""); setUnlockResult(null); } }}>
        <DialogContent dir="rtl">
          <DialogHeader>
            <DialogTitle>فكّ حظر الساعة دون اتصال</DialogTitle>
            <DialogDescription>
              ألصق «رمز الجهاز» الذي يعرضه التطبيق على شاشة قفل الساعة، وسيتم توليد رمز فكّ حظر
              موقّع يُسلّم للعميل ليُدخله في الجهاز. يعمل بدون إنترنت ويصلح لجميع تراخيص Standalone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>رمز الجهاز</Label>
              <Textarea
                value={deviceCodeInput}
                onChange={(e) => setDeviceCodeInput(e.target.value)}
                placeholder="ألصق رمز الجهاز هنا…"
                rows={3} dir="ltr" className="font-mono text-xs"
              />
            </div>
            {unlockResult && (
              <div className="space-y-2 rounded-md border border-emerald-200 bg-emerald-50 p-3">
                <Label className="text-emerald-800">رمز فكّ الحظر (سلّمه للعميل):</Label>
                <div className="flex items-start gap-2">
                  <code className="flex-1 break-all bg-white rounded p-2 text-xs font-mono text-left" dir="ltr">{unlockResult.unlockCode}</code>
                  <Button size="sm" variant="outline" onClick={() => copyText(unlockResult.unlockCode)}>
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  البصمة: <span className="font-mono">{unlockResult.fingerprint.slice(0, 16)}…</span>
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowOfflineUnlock(false); setDeviceCodeInput(""); setUnlockResult(null); }}>إغلاق</Button>
            <Button onClick={() => genUnlockMut.mutate()} disabled={!deviceCodeInput.trim() || genUnlockMut.isPending}>
              {genUnlockMut.isPending ? "جارٍ التوليد…" : "توليد رمز فكّ الحظر"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent dir="rtl" className="w-[calc(100vw-2rem)] max-w-5xl max-h-[92vh] overflow-y-auto">
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
            <LicenseSetupFields
              idPrefix="create"
              value={form}
              onChange={(next) => setForm((current) => ({
                ...current,
                ...next,
                ...(next.country && next.country.toUpperCase() !== "SA"
                  ? { modules: current.modules.filter((module) => module !== "zatca") }
                  : {}),
              }))}
            />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>الحد الأقصى للمستخدمين</Label>
                <Input type="number" min={1} max={100} value={form.maxUsers} onChange={(e) => setForm({ ...form, maxUsers: Number(e.target.value) })} />
              </div>
              <div>
                <Label>مهلة عدم الاتصال (أيام)</Label>
                <Input type="number" min={1} max={90} value={form.graceDays} onChange={(e) => setForm({ ...form, graceDays: Number(e.target.value) })} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>الرقم الضريبي</Label>
                <Input value={form.companyTaxNumber} onChange={(e) => setForm({ ...form, companyTaxNumber: e.target.value })} placeholder="3xxxxxxxxxxxxx3" />
              </div>
              <div>
                <Label>السجل التجاري</Label>
                <Input value={form.companyCrNumber} onChange={(e) => setForm({ ...form, companyCrNumber: e.target.value })} placeholder="10xxxxxxxx" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>هاتف الشركة</Label>
                <Input value={form.companyPhone} onChange={(e) => setForm({ ...form, companyPhone: e.target.value })} placeholder="+9665xxxxxxxx" />
              </div>
              <div>
                <Label>البريد الإلكتروني</Label>
                <Input value={form.companyEmail} onChange={(e) => setForm({ ...form, companyEmail: e.target.value })} placeholder="info@example.com" />
              </div>
            </div>
            <div>
              <Label>عنوان الشركة</Label>
              <Input value={form.companyAddress} onChange={(e) => setForm({ ...form, companyAddress: e.target.value })} placeholder="الرياض، حي العليا" />
            </div>
            <ModuleEntitlementPicker
              idPrefix="create"
              country={form.country}
              selected={form.modules}
              includeZatca={false}
              onChange={(modules) => setForm({ ...form, modules })}
            />
            <div>
              <Label>تاريخ الانتهاء (اختياري)</Label>
              <DateField value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
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
            <Button onClick={() => create.mutate()} disabled={!form.customerName.trim() || !isSetupComplete(form) || create.isPending}>
              {create.isPending ? "جارٍ الإنشاء…" : "إنشاء وتنزيل الملف"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit / Renew dialog — main use case: extend expiry. Also lets
          SuperAdmin fix the customer name, change the vertical, or raise
          maxUsers. Backend re-signs the file so the next download
          delivers the updated, freshly-signed copy to the customer. */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent dir="rtl" className="w-[calc(100vw-2rem)] max-w-5xl max-h-[92vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>تعديل / تجديد الترخيص</DialogTitle>
            <DialogDescription>
              {editing && (<>
                مفتاح: <code className="font-mono text-xs">{editing.licenseKey}</code> · العميل: <b>{editing.customerName}</b>
              </>)}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>اسم العميل</Label>
              <Input value={editForm.customerName} onChange={(e) => setEditForm({ ...editForm, customerName: e.target.value })} />
            </div>
            <LicenseSetupFields
              idPrefix="edit"
              value={editForm}
              onChange={(next) => setEditForm((current) => ({
                ...current,
                ...next,
                ...(next.country && next.country.toUpperCase() !== "SA"
                  ? { modules: current.modules.filter((module) => module !== "zatca") }
                  : {}),
              }))}
            />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>الحد الأقصى للمستخدمين</Label>
                <Input type="number" min={1} max={100} value={editForm.maxUsers}
                  onChange={(e) => setEditForm({ ...editForm, maxUsers: Number(e.target.value) })} />
              </div>
              <div>
                <Label>مهلة عدم الاتصال (أيام)</Label>
                <Input type="number" min={1} max={90} value={editForm.graceDays} onChange={(e) => setEditForm({ ...editForm, graceDays: Number(e.target.value) })} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>الرقم الضريبي</Label>
                <Input value={editForm.companyTaxNumber} onChange={(e) => setEditForm({ ...editForm, companyTaxNumber: e.target.value })} />
              </div>
              <div>
                <Label>السجل التجاري</Label>
                <Input value={editForm.companyCrNumber} onChange={(e) => setEditForm({ ...editForm, companyCrNumber: e.target.value })} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>هاتف الشركة</Label>
                <Input value={editForm.companyPhone} onChange={(e) => setEditForm({ ...editForm, companyPhone: e.target.value })} />
              </div>
              <div>
                <Label>البريد الإلكتروني</Label>
                <Input value={editForm.companyEmail} onChange={(e) => setEditForm({ ...editForm, companyEmail: e.target.value })} />
              </div>
            </div>
            <div>
              <Label>عنوان الشركة</Label>
              <Input value={editForm.companyAddress} onChange={(e) => setEditForm({ ...editForm, companyAddress: e.target.value })} />
            </div>
            <ModuleEntitlementPicker
              idPrefix="edit"
              country={editForm.country}
              selected={editForm.modules}
              onChange={(modules) => setEditForm({ ...editForm, modules, modulesExplicit: true })}
            />
            <div>
              <Label>تاريخ الانتهاء</Label>
              <DateField value={editForm.expiresAt}
                onChange={(e) => setEditForm({ ...editForm, expiresAt: e.target.value })} />
              <div className="flex gap-2 mt-2 flex-wrap">
                <Button type="button" size="sm" variant="secondary" onClick={() => bumpExpiry(30)}>+30 يوم</Button>
                <Button type="button" size="sm" variant="secondary" onClick={() => bumpExpiry(90)}>+3 شهور</Button>
                <Button type="button" size="sm" variant="secondary" onClick={() => bumpExpiry(180)}>+6 شهور</Button>
                <Button type="button" size="sm" variant="secondary" onClick={() => bumpExpiry(365)}>+سنة</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditForm({ ...editForm, expiresAt: "" })}>
                  بدون انتهاء (دائم)
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                الأزرار تضيف من تاريخ الانتهاء الحالي (إن لم يكن منتهياً)، وإلا من اليوم.
              </p>
            </div>
            <div>
              <Label>ملاحظات</Label>
              <Textarea rows={2} value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>إلغاء</Button>
            <Button onClick={() => edit.mutate()} disabled={!editForm.customerName.trim() || !isSetupComplete(editForm) || edit.isPending}>
              {edit.isPending ? "جارٍ الحفظ…" : "حفظ وإعادة التوقيع"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Approve dialog — issue a signed file for a pending self-registration.
          Default a 7-day trial; allow editing the duration or marking it
          permanent. On approve the backend signs + stores the file and the
          device picks it up on its next poll. */}
      <Dialog open={!!approving} onOpenChange={(o) => !o && setApproving(null)}>
        <DialogContent dir="rtl" className="w-[calc(100vw-2rem)] max-w-5xl max-h-[92vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>الموافقة على طلب التسجيل</DialogTitle>
            <DialogDescription>
              {approving && (<>
                مفتاح: <code className="font-mono text-xs">{approving.licenseKey}</code> · العميل: <b>{approving.customerName}</b>
              </>)}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
              <LicenseSetupFields
                idPrefix="approve"
                value={approveForm}
                onChange={(next) => setApproveForm((current) => ({
                  ...current,
                  ...next,
                  ...(next.country && next.country.toUpperCase() !== "SA"
                    ? { modules: current.modules.filter((module) => module !== "zatca") }
                    : {}),
                }))}
              />
              <ModuleEntitlementPicker
                idPrefix="approve"
                country={approveForm.country}
                selected={approveForm.modules}
                includeZatca={false}
                onChange={(modules) => setApproveForm({ ...approveForm, modules })}
              />
            <div className="flex items-center gap-2">
              <Checkbox
                id="approve-permanent"
                checked={approveForm.permanent}
                onCheckedChange={(c) => setApproveForm({ ...approveForm, permanent: c === true })}
              />
              <Label htmlFor="approve-permanent" className="cursor-pointer">ترخيص دائم (بدون تاريخ انتهاء)</Label>
            </div>
            {!approveForm.permanent && (
              <div>
                <Label>مدة التجربة (أيام)</Label>
                <Input
                  type="number" min={1} max={3650}
                  value={approveForm.trialDays}
                  onChange={(e) => setApproveForm({ ...approveForm, trialDays: Number(e.target.value) })}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  الافتراضي 7 أيام. يبدأ الاحتساب من لحظة الموافقة. يمكنك التمديد لاحقاً من زر التعديل.
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproving(null)}>إلغاء</Button>
            <Button onClick={() => approve.mutate()} disabled={approve.isPending || !isSetupComplete(approveForm) || approveForm.modules.length === 0 || (!approveForm.permanent && (!approveForm.trialDays || approveForm.trialDays < 1))}>
              {approve.isPending ? "جارٍ الموافقة…" : "موافقة وإصدار الترخيص"}
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

function LicenseSetupFields({ idPrefix, value, onChange }: {
  idPrefix: string;
  value: LicenseSetup;
  onChange: (next: LicenseSetup) => void;
}) {
  const update = (key: keyof LicenseSetup, nextValue: string | number) =>
    onChange({ ...value, [key]: nextValue } as LicenseSetup);
  return (
    <section className="space-y-4 rounded-xl border border-sky-200 bg-sky-50/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold text-slate-900">إعداد نسخة Standalone</h3>
          <p className="text-xs text-muted-foreground">تُوقّع هذه الاختيارات داخل ملف الترخيص وتُطبّق على الجهاز.</p>
        </div>
        <Badge className="bg-slate-800 text-white">مستقل فقط · بدون سحابة</Badge>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-vertical`}>النشاط التجاري *</Label>
          <Select value={value.vertical || undefined} onValueChange={(v) => update("vertical", v)}>
            <SelectTrigger id={`${idPrefix}-vertical`}><SelectValue placeholder="اختر النشاط" /></SelectTrigger>
            <SelectContent>
              {Object.entries(VERTICAL_LABELS).map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-country`}>الدولة *</Label>
          <Select value={value.country || undefined} onValueChange={(v) => update("country", v)}>
            <SelectTrigger id={`${idPrefix}-country`}><SelectValue placeholder="اختر الدولة" /></SelectTrigger>
            <SelectContent>
              {COUNTRIES.map(([code, name]) => <SelectItem key={code} value={code}>{name} ({code})</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-profile`}>ملف التشغيل *</Label>
          <Select value={value.appProfile || undefined} onValueChange={(v) => update("appProfile", v)}>
            <SelectTrigger id={`${idPrefix}-profile`}><SelectValue placeholder="اختر الملف" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="pos">نقطة بيع فقط</SelectItem>
              <SelectItem value="erp">النظام الكامل (ERP)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-role`}>دور الجهاز على الشبكة *</Label>
          <Select value={value.netRole || undefined} onValueChange={(v) => {
          onChange({
            ...value,
            netRole: v,
            lanToken: v === "host" && !value.lanToken ? generatePairingToken() : value.lanToken,
          });
        }}>
          <SelectTrigger id={`${idPrefix}-role`}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="single">مستقل — جهاز واحد</SelectItem>
            <SelectItem value="host">رئيسي — يشارك قاعدة البيانات</SelectItem>
            <SelectItem value="client">فرعي — يتصل بالجهاز الرئيسي</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {value.netRole === "host" && (
        <div className="grid gap-3 rounded-lg border bg-white p-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-token`}>رمز إقران الأجهزة الفرعية *</Label>
            <div className="flex gap-2">
              <Input id={`${idPrefix}-token`} value={value.lanToken} dir="ltr" readOnly className="font-mono" />
              <Button type="button" variant="outline" onClick={() => update("lanToken", generatePairingToken())}>إنشاء رمز</Button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-port`}>منفذ الشبكة</Label>
            <Input id={`${idPrefix}-port`} type="number" min={1} max={65535} value={value.lanPort}
              onChange={(e) => update("lanPort", Number(e.target.value))} />
          </div>
          <p className="md:col-span-2 text-xs text-muted-foreground">يُدخل رمز الإقران وعنوان الجهاز الرئيسي في إعداد ترخيص كل جهاز فرعي.</p>
        </div>
      )}
      {value.netRole === "client" && (
        <div className="grid gap-3 rounded-lg border bg-white p-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-host-url`}>عنوان الجهاز الرئيسي *</Label>
            <Input id={`${idPrefix}-host-url`} value={value.lanHostUrl} dir="ltr"
              onChange={(e) => update("lanHostUrl", e.target.value)} placeholder="http://192.168.1.10:7711" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-client-token`}>رمز الإقران *</Label>
            <Input id={`${idPrefix}-client-token`} value={value.lanToken} dir="ltr"
              onChange={(e) => update("lanToken", e.target.value)} placeholder="رمز الجهاز الرئيسي" />
          </div>
        </div>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    pending: { label: "بانتظار الموافقة", cls: "bg-orange-100 text-orange-800" },
    active: { label: "نشط", cls: "bg-green-100 text-green-800" },
    revoked: { label: "ملغى", cls: "bg-red-100 text-red-800" },
    expired: { label: "منتهٍ", cls: "bg-amber-100 text-amber-800" },
  };
  const v = map[status] ?? { label: status, cls: "bg-slate-100 text-slate-700" };
  return <span className={`text-xs px-2 py-0.5 rounded ${v.cls}`}>{v.label}</span>;
}

function ModuleEntitlementPicker({
  idPrefix,
  country,
  selected,
  onChange,
  includeZatca = true,
}: {
  idPrefix: string;
  country: string;
  selected: string[];
  onChange: (modules: string[]) => void;
  includeZatca?: boolean;
}) {
  const availableModules = offlineModulesForCountry(country, includeZatca);
  return (
    <section className="rounded-xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-4 shadow-sm">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-slate-900">الوحدات المفعّلة لهذا الترخيص</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            أزل العلامة لإخفاء الوحدة عن الشركة. ستُطبّق التغييرات على جهاز Windows عند اتصاله بالإنترنت.
          </p>
        </div>
        <Badge variant="secondary" className="shrink-0">
          <span data-testid={`text-module-enabled-count-${idPrefix}`}>{selected.length} / {availableModules.length}</span>
        </Badge>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {availableModules.map((module) => {
          const checked = selected.includes(module.key);
          const id = `offline-module-${idPrefix}-${module.key}`;
          return (
            <label
              key={module.key}
              htmlFor={id}
              className={`flex min-h-[78px] cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                checked
                  ? "border-blue-300 bg-blue-50/70 hover:bg-blue-50"
                  : "border-slate-200 bg-white hover:border-slate-300"
              }`}
            >
              <Checkbox
                id={id}
                data-testid={`checkbox-module-${idPrefix}-${module.key}`}
                className="mt-0.5"
                checked={checked}
                onCheckedChange={(value) => {
                  if (value === true && !checked) onChange([...selected, module.key]);
                  else if (value !== true && checked && selected.length > 1) {
                    onChange(selected.filter((key) => key !== module.key));
                  }
                }}
              />
              <span className="min-w-0">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-900">{module.label}</span>
                  <span className="rounded-full bg-white/80 px-1.5 py-0.5 text-[10px] text-slate-500">{module.group}</span>
                </span>
                <span className="mt-1 block text-xs leading-5 text-slate-600">{module.detail}</span>
              </span>
            </label>
          );
        })}
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">
        يجب تفعيل وحدة واحدة على الأقل. التراخيص القديمة التي لا تحتوي على قائمة وحدات تبقى متاحة دون تغيير.
      </p>
    </section>
  );
}
