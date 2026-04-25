import { useState } from "react";
import { useLocation, useRoute } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { KeyRound, Loader2, ShieldCheck, AlertTriangle, Copy, Download, Check } from "lucide-react";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function RecoverSuperAdmin() {
  const [, setLocation] = useLocation();
  const [matchToken, paramsToken] = useRoute("/recover-superadmin/:token");
  const { setSession } = useAuth();
  const { toast } = useToast();

  // Request-link form
  const [username, setUsername] = useState("");
  const [reqLoading, setReqLoading] = useState(false);
  const [reqMsg, setReqMsg] = useState("");

  // Confirm-link
  const [pwOld, setPwOld] = useState(""); const [pwNew, setPwNew] = useState(""); const [pwNew2, setPwNew2] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [newCodes, setNewCodes] = useState<string[] | null>(null);

  // ── Mode 1: request link ────────────────────────────────────────────
  async function requestLink(e: React.FormEvent) {
    e.preventDefault();
    setReqLoading(true); setReqMsg("");
    try {
      const r = await fetch(`${API_BASE}/api/auth/superadmin/recovery/request-link`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim() }),
      });
      const j = await r.json();
      setReqMsg(j.message || "تم الإرسال إذا كان الحساب موجودًا.");
    } catch (err: any) {
      setReqMsg(err?.message || "حدث خطأ");
    } finally {
      setReqLoading(false);
    }
  }

  // ── Mode 2: confirm token ───────────────────────────────────────────
  async function confirmToken(e: React.FormEvent) {
    e.preventDefault();
    setError(""); setBusy(true);
    if (pwNew !== pwNew2) { setError("كلمتا المرور الجديدتان غير متطابقتين"); setBusy(false); return; }
    try {
      const r = await fetch(`${API_BASE}/api/auth/superadmin/recovery/link/${paramsToken?.token}/use`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        // Backend requires the account password to confirm ownership.
        // newPassword is currently unused on the server (account recovery
        // does not rotate the password — it only resets devices/sessions).
        body: JSON.stringify({ password: pwOld }),
      });
      const j = await r.json();
      if (!r.ok) { setError(j.error || "فشل التأكيد"); return; }
      setNewCodes(j.recoveryCodes ?? []);
      // Install session so they can navigate without re-logging in.
      if (j.token && j.user) {
        setSession({ token: j.token, sessionId: j.sessionId ?? null, user: j.user });
      }
      toast({ title: "تم استرجاع الحساب — احفظ الرموز الجديدة." });
    } catch (err: any) {
      setError(err?.message || "حدث خطأ");
    } finally {
      setBusy(false);
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
      `رموز استرجاع SuperAdmin (إنشاء بعد الاسترجاع)\nأُنشئت: ${new Date().toLocaleString("ar-SA")}\n\n` +
      newCodes.join("\n"),
    ], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `superadmin-recovery-codes.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-muted flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500 text-white mb-4 shadow-lg">
            <KeyRound className="h-7 w-7" />
          </div>
          <h1 className="text-2xl font-bold">استرجاع حساب السوبر أدمن</h1>
        </div>

        <div className="bg-card border border-border rounded-2xl shadow-xl p-8 space-y-6">
          {!matchToken && !newCodes && (
            <form onSubmit={requestLink} className="space-y-4">
              <div className="text-sm text-muted-foreground">
                أدخل اسم المستخدم لإرسال رابط استرجاع إلى البريد المسجل. الرابط صالح لمدة 30 دقيقة.
              </div>
              <div>
                <label className="text-sm font-medium">اسم المستخدم</label>
                <Input value={username} onChange={e => setUsername(e.target.value)} dir="ltr" className="text-left" required />
              </div>
              <Button type="submit" className="w-full gap-2" disabled={reqLoading}>
                {reqLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                إرسال رابط الاسترجاع
              </Button>
              {reqMsg && (
                <div className="text-sm text-blue-700 bg-blue-50 border border-blue-200 rounded-lg p-3">{reqMsg}</div>
              )}
              <div className="text-center text-xs">
                <a href="/login" onClick={e => { e.preventDefault(); setLocation("/login"); }} className="text-muted-foreground hover:text-foreground">
                  العودة إلى تسجيل الدخول
                </a>
              </div>
            </form>
          )}

          {matchToken && !newCodes && (
            <form onSubmit={confirmToken} className="space-y-4">
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900 flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <div>
                  هذا الإجراء سيُنشئ رموز استرجاع جديدة ويُلغي كل الجلسات والأجهزة الموثوقة. هذا الجهاز سيُعتبر موثوقًا.
                </div>
              </div>
              <div>
                <label className="text-sm font-medium">كلمة المرور الحالية</label>
                <Input type="password" value={pwOld} onChange={e => setPwOld(e.target.value)} required />
              </div>
              <div>
                <label className="text-sm font-medium">كلمة مرور جديدة (اختياري — اتركها كما هي)</label>
                <Input type="password" value={pwNew} onChange={e => setPwNew(e.target.value)} />
              </div>
              <div>
                <label className="text-sm font-medium">تأكيد كلمة المرور الجديدة</label>
                <Input type="password" value={pwNew2} onChange={e => setPwNew2(e.target.value)} />
              </div>
              {error && (
                <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-3">{error}</div>
              )}
              <Button type="submit" className="w-full gap-2" disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                تأكيد الاسترجاع
              </Button>
            </form>
          )}

          {newCodes && (
            <div className="space-y-3">
              <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 text-sm font-medium text-amber-900 flex items-center gap-1">
                <Check className="h-4 w-4" /> تم الاسترجاع — احفظ الرموز التالية الآن:
              </div>
              <div className="grid grid-cols-2 gap-2 font-mono text-sm">
                {newCodes.map((c, i) => (
                  <div key={i} className="bg-muted rounded p-2 text-center" dir="ltr">{c}</div>
                ))}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={copyAll} className="gap-1"><Copy className="h-3 w-3" /> نسخ</Button>
                <Button size="sm" variant="outline" onClick={downloadCodes} className="gap-1"><Download className="h-3 w-3" /> تنزيل</Button>
                <Button size="sm" className="ml-auto" onClick={() => setLocation("/")}>إلى لوحة التحكم</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
