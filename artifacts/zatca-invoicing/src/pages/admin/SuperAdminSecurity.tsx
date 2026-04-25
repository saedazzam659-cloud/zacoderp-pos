import { useEffect, useState, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  ShieldCheck, Smartphone, KeyRound, History, AlertTriangle, RefreshCw,
  X, Copy, Download, Check, Clock, MailCheck, MailX, UserPlus, Users,
} from "lucide-react";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authHeaders(): Record<string, string> {
  const t = localStorage.getItem("zatca_token");
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (t) h["Authorization"] = `Bearer ${t}`;
  return h;
}

interface Session {
  id: number; deviceName: string | null; userAgent: string | null; ip: string | null;
  createdAt: string; lastSeenAt: string; current?: boolean;
}
interface Device {
  id: number; deviceName: string | null; deviceFingerprint: string;
  ip: string | null; userAgent: string | null; createdAt: string; lastUsedAt: string | null;
}
interface Attempt {
  id: number; username: string | null; ip: string | null; userAgent: string | null;
  success: boolean; outcome: string; createdAt: string;
}
interface PendingApproval {
  id: number; approvalToken: string; requestingDeviceFp: string;
  requestingIp: string | null; requestingUa: string | null; createdAt: string; expiresAt: string;
}
interface Status {
  activeSessions: number; trustedDevices: number; unusedRecoveryCodes: number;
  emailConfigured: boolean; turnstileEnabled: boolean;
}

export default function SuperAdminSecurity() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [tab, setTab] = useState("overview");
  const [status, setStatus] = useState<Status | null>(null);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [history, setHistory] = useState<Attempt[]>([]);
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [recoveryCodes, setRecoveryCodes] = useState<{ id: number; usedAt: string | null; createdAt: string }[]>([]);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  // Change password
  const [pwOld, setPwOld] = useState(""); const [pwNew, setPwNew] = useState(""); const [pwNew2, setPwNew2] = useState("");

  // SuperAdmin accounts
  interface SAUser { id: number; username: string; email: string | null; nameAr: string | null; nameEn: string | null; isActive: boolean; lastLoginAt: string | null; createdAt: string; }
  const [saUsers, setSaUsers] = useState<SAUser[]>([]);
  const [naName, setNaName] = useState("");
  const [naUsername, setNaUsername] = useState("");
  const [naEmail, setNaEmail] = useState("");
  const [naPassword, setNaPassword] = useState("");
  const [naPassword2, setNaPassword2] = useState("");
  const [naCurrentPw, setNaCurrentPw] = useState("");

  const fetchAll = useCallback(async () => {
    try {
      const [s1, s2, s3, s4, s5, s6, s7] = await Promise.all([
        fetch(`${API_BASE}/api/auth/superadmin/security-status`, { headers: authHeaders() }),
        fetch(`${API_BASE}/api/auth/superadmin/sessions`, { headers: authHeaders() }),
        fetch(`${API_BASE}/api/auth/superadmin/devices`, { headers: authHeaders() }),
        fetch(`${API_BASE}/api/auth/superadmin/login-history`, { headers: authHeaders() }),
        fetch(`${API_BASE}/api/auth/superadmin/device-approvals/pending`, { headers: authHeaders() }),
        fetch(`${API_BASE}/api/auth/superadmin/recovery-codes`, { headers: authHeaders() }),
        fetch(`${API_BASE}/api/auth/superadmin/users`, { headers: authHeaders() }),
      ]);
      if (s1.ok) setStatus(await s1.json());
      if (s2.ok) setSessions(await s2.json());
      if (s3.ok) setDevices(await s3.json());
      if (s4.ok) setHistory(await s4.json());
      if (s5.ok) setPending(await s5.json());
      if (s6.ok) setRecoveryCodes(await s6.json());
      if (s7.ok) setSaUsers(await s7.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  if (!user || user.role !== "superadmin") {
    return <div className="p-6 text-destructive">غير مصرح.</div>;
  }

  // ── Actions ──────────────────────────────────────────────────────────
  async function revokeSession(id: number) {
    if (!confirm("إنهاء هذه الجلسة؟")) return;
    setBusy(true);
    const r = await fetch(`${API_BASE}/api/auth/superadmin/sessions/${id}`, { method: "DELETE", headers: authHeaders() });
    setBusy(false);
    if (r.ok) { toast({ title: "تم إنهاء الجلسة" }); fetchAll(); }
    else toast({ title: "فشل", description: (await r.json()).error, variant: "destructive" });
  }

  async function revokeAllSessions() {
    if (!confirm("إنهاء كل الجلسات الأخرى؟")) return;
    setBusy(true);
    const r = await fetch(`${API_BASE}/api/auth/superadmin/sessions/revoke-all`, { method: "POST", headers: authHeaders() });
    setBusy(false);
    if (r.ok) { toast({ title: "تم إنهاء الجلسات الأخرى" }); fetchAll(); }
  }

  async function revokeDevice(id: number) {
    if (!confirm("إلغاء ثقة هذا الجهاز؟ سيُطلب التحقق المتعدد عند الدخول منه مرة أخرى.")) return;
    setBusy(true);
    const r = await fetch(`${API_BASE}/api/auth/superadmin/devices/${id}`, { method: "DELETE", headers: authHeaders() });
    setBusy(false);
    if (r.ok) { toast({ title: "تم إلغاء ثقة الجهاز" }); fetchAll(); }
  }

  async function decideApproval(token: string, decision: "approve" | "reject") {
    setBusy(true);
    const r = await fetch(`${API_BASE}/api/auth/superadmin/device-approvals/${token}/decide`, {
      method: "POST", headers: authHeaders(), body: JSON.stringify({ decision }),
    });
    setBusy(false);
    if (r.ok) { toast({ title: decision === "approve" ? "تم الاعتماد" : "تم الرفض" }); fetchAll(); }
  }

  async function generateCodes() {
    if (!confirm("إنشاء رموز جديدة سيُلغي القديمة. متابعة؟")) return;
    setBusy(true);
    const r = await fetch(`${API_BASE}/api/auth/superadmin/recovery-codes/regenerate`, {
      method: "POST", headers: authHeaders(),
    });
    setBusy(false);
    if (r.ok) {
      const j = await r.json();
      setNewCodes(j.codes ?? []);
      fetchAll();
      toast({ title: "تم إنشاء رموز جديدة — احفظها الآن!" });
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (pwNew !== pwNew2) { toast({ title: "كلمتا المرور غير متطابقتين", variant: "destructive" }); return; }
    setBusy(true);
    const r = await fetch(`${API_BASE}/api/auth/superadmin/change-password`, {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({ currentPassword: pwOld, newPassword: pwNew }),
    });
    setBusy(false);
    if (r.ok) {
      toast({ title: "تم تغيير كلمة المرور" });
      setPwOld(""); setPwNew(""); setPwNew2("");
    } else {
      toast({ title: "فشل", description: (await r.json()).error, variant: "destructive" });
    }
  }

  async function createSuperAdmin(e: React.FormEvent) {
    e.preventDefault();
    if (naPassword !== naPassword2) {
      toast({ title: "كلمتا المرور غير متطابقتين", variant: "destructive" });
      return;
    }
    if (!naCurrentPw) {
      toast({ title: "أدخل كلمة المرور الحالية لتأكيد الإجراء", variant: "destructive" });
      return;
    }
    setBusy(true);
    const r = await fetch(`${API_BASE}/api/auth/superadmin/users`, {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({
        name: naName.trim(),
        username: naUsername.trim().toLowerCase(),
        email: naEmail.trim().toLowerCase(),
        password: naPassword,
        currentPassword: naCurrentPw,
      }),
    });
    setBusy(false);
    if (r.ok) {
      toast({ title: "تم إنشاء حساب السوبر أدمن بنجاح" });
      setNaName(""); setNaUsername(""); setNaEmail(""); setNaPassword(""); setNaPassword2(""); setNaCurrentPw("");
      fetchAll();
    } else {
      const err = await r.json().catch(() => ({}));
      toast({ title: "فشل الإنشاء", description: err.error ?? "حدث خطأ غير متوقع", variant: "destructive" });
    }
  }

  function copyAll() {
    if (!newCodes) return;
    navigator.clipboard.writeText(newCodes.join("\n"));
    toast({ title: "تم النسخ" });
  }

  function downloadCodes() {
    if (!newCodes) return;
    const blob = new Blob([
      `رموز استرجاع SuperAdmin\nالحساب: ${user?.username}\nأُنشئت: ${new Date().toLocaleString("ar-SA")}\n\n` +
      newCodes.join("\n") +
      `\n\nاحتفظ بهذه الرموز في مكان آمن. كل رمز يُستخدم مرة واحدة فقط.\n`,
    ], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `superadmin-recovery-codes-${user?.username}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ── Render ───────────────────────────────────────────────────────────
  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-primary" />
            مركز أمان السوبر أدمن
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            إدارة جلسات الدخول، الأجهزة الموثوقة، رموز الاسترجاع، والسجل الأمني.
          </p>
        </div>
        <Button variant="outline" onClick={fetchAll} className="gap-1">
          <RefreshCw className="h-4 w-4" /> تحديث
        </Button>
      </div>

      {/* Status cards */}
      {status && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Card title="الجلسات النشطة" value={status.activeSessions} icon={<History className="h-4 w-4" />} />
          <Card title="الأجهزة الموثوقة" value={status.trustedDevices} icon={<Smartphone className="h-4 w-4" />} />
          <Card title="رموز الاسترجاع المتبقية" value={status.unusedRecoveryCodes} icon={<KeyRound className="h-4 w-4" />}
            warn={status.unusedRecoveryCodes < 3} />
          <Card title="البريد"
            value={status.emailConfigured ? "مُفعّل" : "غير مُفعّل"}
            icon={status.emailConfigured ? <MailCheck className="h-4 w-4 text-green-600" /> : <MailX className="h-4 w-4 text-amber-600" />}
            warn={!status.emailConfigured} />
          <Card title="Turnstile"
            value={status.turnstileEnabled ? "مُفعّل" : "غير مُفعّل"}
            icon={<ShieldCheck className={`h-4 w-4 ${status.turnstileEnabled ? "text-green-600" : "text-amber-600"}`} />}
            warn={!status.turnstileEnabled} />
        </div>
      )}

      {/* Pending approvals banner */}
      {pending.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
          <div className="flex items-center gap-2 font-medium text-amber-900 mb-2">
            <AlertTriangle className="h-4 w-4" />
            طلبات اعتماد جهاز جديد ({pending.length})
          </div>
          <div className="space-y-2">
            {pending.map(p => (
              <div key={p.id} className="bg-white rounded border border-amber-200 p-3 flex items-center justify-between gap-3">
                <div className="text-xs">
                  <div className="font-mono">IP: {p.requestingIp}</div>
                  <div className="text-muted-foreground truncate max-w-xs">{p.requestingUa}</div>
                  <div className="text-muted-foreground">طُلب: {new Date(p.createdAt).toLocaleString("ar-SA")}</div>
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button size="sm" variant="default" onClick={() => decideApproval(p.approvalToken, "approve")} disabled={busy}>
                    <Check className="h-3 w-3" /> اعتماد
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => decideApproval(p.approvalToken, "reject")} disabled={busy}>
                    <X className="h-3 w-3" /> رفض
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">نظرة عامة</TabsTrigger>
          <TabsTrigger value="sessions">الجلسات</TabsTrigger>
          <TabsTrigger value="devices">الأجهزة</TabsTrigger>
          <TabsTrigger value="recovery">رموز الاسترجاع</TabsTrigger>
          <TabsTrigger value="history">سجل الدخول</TabsTrigger>
          <TabsTrigger value="password">كلمة المرور</TabsTrigger>
          <TabsTrigger value="accounts">حسابات السوبر أدمن</TabsTrigger>
        </TabsList>

        {/* Overview */}
        <TabsContent value="overview" className="space-y-3">
          <div className="bg-card border rounded-lg p-4">
            <h3 className="font-medium mb-2">ملخص</h3>
            <ul className="text-sm space-y-1 text-muted-foreground list-disc pr-5">
              <li>تأمين متعدد الطبقات: كلمة مرور + رمز بريد إلكتروني (60 ثانية) + جهاز موثوق + Turnstile.</li>
              <li>يتم إخطارك عبر البريد عند: جهاز جديد، محاولات فاشلة، تغيير كلمة المرور، طلبات اعتماد.</li>
              <li>تُحسب درجة المخاطرة (IP جديد، جهاز جديد، توقيت غير معتاد، محاولات فاشلة سابقة).</li>
              <li>يمكنك إنهاء الجلسات وإلغاء ثقة الأجهزة في أي وقت.</li>
              <li>احتفظ برموز الاسترجاع في مكان آمن — كل رمز يُستخدم مرة واحدة.</li>
            </ul>
          </div>
        </TabsContent>

        {/* Sessions */}
        <TabsContent value="sessions" className="space-y-3">
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={revokeAllSessions} disabled={busy} className="gap-1">
              <X className="h-3 w-3" /> إنهاء كل الجلسات الأخرى
            </Button>
          </div>
          <div className="bg-card border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted text-xs">
                <tr><th className="p-2 text-right">الجهاز</th><th className="p-2 text-right">IP</th><th className="p-2 text-right">آخر نشاط</th><th className="p-2 text-right">إجراء</th></tr>
              </thead>
              <tbody>
                {sessions.length === 0 && <tr><td colSpan={4} className="p-4 text-center text-muted-foreground">لا توجد جلسات.</td></tr>}
                {sessions.map(s => (
                  <tr key={s.id} className="border-t">
                    <td className="p-2">
                      {s.deviceName || "—"}
                      {s.current && <span className="mr-2 text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded">الحالية</span>}
                    </td>
                    <td className="p-2 font-mono text-xs">{s.ip}</td>
                    <td className="p-2 text-xs text-muted-foreground">{new Date(s.lastSeenAt).toLocaleString("ar-SA")}</td>
                    <td className="p-2">
                      {!s.current && (
                        <Button size="sm" variant="ghost" onClick={() => revokeSession(s.id)} disabled={busy}>
                          <X className="h-3 w-3" /> إنهاء
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>

        {/* Devices */}
        <TabsContent value="devices" className="space-y-3">
          <div className="bg-card border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted text-xs">
                <tr><th className="p-2 text-right">الجهاز</th><th className="p-2 text-right">IP</th><th className="p-2 text-right">آخر استخدام</th><th className="p-2 text-right">إجراء</th></tr>
              </thead>
              <tbody>
                {devices.length === 0 && <tr><td colSpan={4} className="p-4 text-center text-muted-foreground">لا توجد أجهزة موثوقة.</td></tr>}
                {devices.map(d => (
                  <tr key={d.id} className="border-t">
                    <td className="p-2">{d.deviceName || "—"}</td>
                    <td className="p-2 font-mono text-xs">{d.ip}</td>
                    <td className="p-2 text-xs text-muted-foreground">
                      {d.lastUsedAt ? new Date(d.lastUsedAt).toLocaleString("ar-SA") : "—"}
                    </td>
                    <td className="p-2">
                      <Button size="sm" variant="ghost" onClick={() => revokeDevice(d.id)} disabled={busy}>
                        <X className="h-3 w-3" /> إلغاء الثقة
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>

        {/* Recovery codes */}
        <TabsContent value="recovery" className="space-y-3">
          <div className="bg-card border rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium">رموز الاسترجاع</h3>
                <p className="text-xs text-muted-foreground">المتبقية: {recoveryCodes.filter(c => !c.usedAt).length} / {recoveryCodes.length}</p>
              </div>
              <Button onClick={generateCodes} disabled={busy} className="gap-1">
                <RefreshCw className="h-4 w-4" /> إنشاء رموز جديدة
              </Button>
            </div>

            {newCodes && (
              <div className="bg-amber-50 border border-amber-300 rounded-lg p-4 space-y-3">
                <div className="text-sm font-medium text-amber-900 flex items-center gap-1">
                  <AlertTriangle className="h-4 w-4" />
                  هذه آخر مرة تظهر هذه الرموز. احفظها الآن!
                </div>
                <div className="grid grid-cols-2 gap-2 font-mono text-sm">
                  {newCodes.map((c, i) => (
                    <div key={i} className="bg-white rounded p-2 text-center" dir="ltr">{c}</div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={copyAll} className="gap-1"><Copy className="h-3 w-3" /> نسخ الكل</Button>
                  <Button size="sm" variant="outline" onClick={downloadCodes} className="gap-1"><Download className="h-3 w-3" /> تنزيل</Button>
                  <Button size="sm" variant="ghost" onClick={() => setNewCodes(null)} className="ml-auto">إخفاء</Button>
                </div>
              </div>
            )}

            <div className="text-xs text-muted-foreground">
              لا نعرض الرموز الكاملة بعد إنشائها — يمكنك إنشاء مجموعة جديدة في أي وقت (تُلغي القديمة).
            </div>
          </div>
        </TabsContent>

        {/* Login history */}
        <TabsContent value="history" className="space-y-3">
          <div className="bg-card border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted text-xs">
                <tr>
                  <th className="p-2 text-right">الوقت</th>
                  <th className="p-2 text-right">المستخدم</th>
                  <th className="p-2 text-right">IP</th>
                  <th className="p-2 text-right">النتيجة</th>
                  <th className="p-2 text-right">السبب</th>
                </tr>
              </thead>
              <tbody>
                {history.length === 0 && <tr><td colSpan={5} className="p-4 text-center text-muted-foreground">لا يوجد سجل.</td></tr>}
                {history.map(a => (
                  <tr key={a.id} className="border-t">
                    <td className="p-2 text-xs whitespace-nowrap">{new Date(a.createdAt).toLocaleString("ar-SA")}</td>
                    <td className="p-2 text-xs">{a.username || "—"}</td>
                    <td className="p-2 font-mono text-xs">{a.ip}</td>
                    <td className="p-2">
                      <span className={`text-xs px-2 py-0.5 rounded ${a.success ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
                        {a.success ? "نجاح" : "فشل"}
                      </span>
                    </td>
                    <td className="p-2 text-xs text-muted-foreground">{a.outcome}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>

        {/* Change password */}
        <TabsContent value="password" className="space-y-3">
          <form onSubmit={changePassword} className="bg-card border rounded-lg p-4 space-y-3 max-w-md">
            <h3 className="font-medium">تغيير كلمة المرور</h3>
            <div>
              <label className="text-sm">كلمة المرور الحالية</label>
              <Input type="password" value={pwOld} onChange={e => setPwOld(e.target.value)} required />
            </div>
            <div>
              <label className="text-sm">كلمة المرور الجديدة</label>
              <Input type="password" value={pwNew} onChange={e => setPwNew(e.target.value)} minLength={10} required />
              <p className="text-xs text-muted-foreground mt-1">10 أحرف على الأقل.</p>
            </div>
            <div>
              <label className="text-sm">تأكيد كلمة المرور</label>
              <Input type="password" value={pwNew2} onChange={e => setPwNew2(e.target.value)} required />
            </div>
            <Button type="submit" disabled={busy}>تغيير</Button>
            <p className="text-xs text-muted-foreground">سيتم إنهاء كل جلساتك الأخرى وإرسال تنبيه إلى بريدك.</p>
          </form>
        </TabsContent>

        {/* SuperAdmin accounts */}
        <TabsContent value="accounts" className="space-y-4">
          {/* Existing SuperAdmin accounts */}
          <div className="bg-card border rounded-lg p-4">
            <h3 className="font-medium flex items-center gap-2 mb-3">
              <Users className="h-4 w-4" />
              الحسابات الحالية ({saUsers.length})
            </h3>
            {saUsers.length === 0 ? (
              <p className="text-sm text-muted-foreground">لا توجد حسابات.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground border-b">
                    <tr>
                      <th className="text-right p-2">الاسم</th>
                      <th className="text-right p-2">اسم المستخدم</th>
                      <th className="text-right p-2">البريد</th>
                      <th className="text-right p-2">الحالة</th>
                      <th className="text-right p-2">آخر دخول</th>
                      <th className="text-right p-2">تاريخ الإنشاء</th>
                    </tr>
                  </thead>
                  <tbody>
                    {saUsers.map(u => (
                      <tr key={u.id} className="border-b last:border-0">
                        <td className="p-2">{u.nameAr || u.nameEn || "—"}</td>
                        <td className="p-2 font-mono text-xs">{u.username}{u.id === user?.id && <span className="mr-2 text-xs text-primary">(أنت)</span>}</td>
                        <td className="p-2 text-xs">{u.email || "—"}</td>
                        <td className="p-2">
                          {u.isActive ? (
                            <span className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-2 py-0.5">مُفعّل</span>
                          ) : (
                            <span className="text-xs text-muted-foreground bg-muted rounded px-2 py-0.5">معطّل</span>
                          )}
                        </td>
                        <td className="p-2 text-xs text-muted-foreground">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString("ar-SA") : "—"}</td>
                        <td className="p-2 text-xs text-muted-foreground">{new Date(u.createdAt).toLocaleString("ar-SA")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Create new SuperAdmin */}
          <form onSubmit={createSuperAdmin} className="bg-card border rounded-lg p-4 space-y-3 max-w-xl">
            <h3 className="font-medium flex items-center gap-2">
              <UserPlus className="h-4 w-4" />
              إنشاء حساب سوبر أدمن جديد
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-sm">الاسم الكامل <span className="text-destructive">*</span></label>
                <Input value={naName} onChange={e => setNaName(e.target.value)} placeholder="مثال: محمد أحمد" required />
              </div>
              <div>
                <label className="text-sm">اسم المستخدم <span className="text-destructive">*</span></label>
                <Input value={naUsername} onChange={e => setNaUsername(e.target.value)} placeholder="admin2" pattern="[a-zA-Z0-9._\-]{3,32}" required />
                <p className="text-xs text-muted-foreground mt-1">3-32 حرفًا، أحرف إنجليزية صغيرة وأرقام و . _ -</p>
              </div>
              <div className="md:col-span-2">
                <label className="text-sm">البريد الإلكتروني</label>
                <Input type="email" value={naEmail} onChange={e => setNaEmail(e.target.value)} placeholder="user@example.com" dir="ltr" />
                <p className="text-xs text-muted-foreground mt-1">اختياري — يُستخدم لاستقبال رمز التحقق وتنبيهات الأمان.</p>
              </div>
              <div>
                <label className="text-sm">كلمة المرور <span className="text-destructive">*</span></label>
                <Input type="password" value={naPassword} onChange={e => setNaPassword(e.target.value)} minLength={10} required />
                <p className="text-xs text-muted-foreground mt-1">10 أحرف فأكثر.</p>
              </div>
              <div>
                <label className="text-sm">تأكيد كلمة المرور <span className="text-destructive">*</span></label>
                <Input type="password" value={naPassword2} onChange={e => setNaPassword2(e.target.value)} required />
              </div>
            </div>

            {/* Step-up auth: confirm with current password */}
            <div className="border-t pt-3 mt-2">
              <label className="text-sm flex items-center gap-1">
                <ShieldCheck className="h-3.5 w-3.5 text-primary" />
                كلمة مرورك الحالية <span className="text-destructive">*</span>
              </label>
              <Input type="password" value={naCurrentPw} onChange={e => setNaCurrentPw(e.target.value)} required autoComplete="current-password" className="max-w-xs" />
              <p className="text-xs text-muted-foreground mt-1">
                نطلب كلمة مرورك الحالية كإجراء أمان إضافي قبل إنشاء حساب سوبر أدمن جديد.
              </p>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <Button type="submit" disabled={busy} className="gap-1">
                <UserPlus className="h-4 w-4" /> إنشاء الحساب
              </Button>
              <p className="text-xs text-muted-foreground">يُسجَّل الإجراء في سجل التدقيق. (الحد: 5 حسابات/الساعة)</p>
            </div>
          </form>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Card({ title, value, icon, warn }: { title: string; value: string | number; icon: React.ReactNode; warn?: boolean }) {
  return (
    <div className={`bg-card border rounded-lg p-3 ${warn ? "border-amber-300" : ""}`}>
      <div className="flex items-center gap-1 text-xs text-muted-foreground">{icon} {title}</div>
      <div className={`text-xl font-bold mt-1 ${warn ? "text-amber-700" : ""}`}>{value}</div>
    </div>
  );
}
