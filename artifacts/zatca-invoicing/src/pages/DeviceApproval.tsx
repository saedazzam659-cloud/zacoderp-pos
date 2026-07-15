import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, ShieldCheck, ShieldX, MonitorSmartphone } from "lucide-react";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function DeviceApproval() {
  const [, setLocation] = useLocation();
  const token = useMemo(() => {
    try { return new URLSearchParams(window.location.search).get("token") ?? ""; }
    catch { return ""; }
  }, []);

  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState<"approved" | "rejected" | null>(null);

  async function decide(decision: "approve" | "reject") {
    if (!password) { setError("أدخل كلمة مرور حسابك للتأكيد"); return; }
    setError(""); setBusy(decision);
    try {
      const r = await fetch(`${API_BASE}/api/auth/superadmin/device-approvals/${encodeURIComponent(token)}/public-decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, decision }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || "فشل تنفيذ الطلب"); return; }
      setDone(j.status === "approved" ? "approved" : "rejected");
    } catch (err: any) {
      setError(err?.message || "حدث خطأ في الاتصال");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-muted flex items-center justify-center p-4" dir="rtl">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-600 text-white mb-4 shadow-lg">
            <MonitorSmartphone className="h-7 w-7" />
          </div>
          <h1 className="text-2xl font-bold">اعتماد جهاز جديد</h1>
          <p className="text-sm text-muted-foreground mt-2">
            طلب تسجيل دخول سوبر أدمن من جهاز جديد. أدخل كلمة مرور حسابك لتأكيد هويتك ثم اعتمد الجهاز أو ارفضه.
          </p>
        </div>

        <div className="bg-card border border-border rounded-2xl shadow-xl p-8 space-y-5">
          {!token && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
              الرابط غير مكتمل — افتح الرابط من رسالة البريد كما هو.
            </div>
          )}

          {done === "approved" && (
            <div className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-4 space-y-2">
              <div className="font-semibold flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> تم اعتماد الجهاز بنجاح</div>
              <div>ارجع إلى شاشة تسجيل الدخول على الجهاز الجديد — ستكمل الدخول تلقائيًا خلال ثوانٍ.</div>
            </div>
          )}
          {done === "rejected" && (
            <div className="text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg p-4 space-y-2">
              <div className="font-semibold flex items-center gap-2"><ShieldX className="h-4 w-4" /> تم رفض الجهاز</div>
              <div>لن يُسمح لهذا الجهاز بتسجيل الدخول. إذا لم تكن أنت من حاول الدخول، ننصح بتغيير كلمة المرور فورًا.</div>
            </div>
          )}

          {!done && token && (
            <>
              <div>
                <label className="text-sm font-medium">كلمة مرور حساب السوبر أدمن</label>
                <Input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  dir="ltr"
                  className="text-left mt-1"
                  autoFocus
                />
              </div>
              {error && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{error}</div>
              )}
              <div className="flex gap-3">
                <Button className="flex-1 gap-2" disabled={busy !== null} onClick={() => decide("approve")}>
                  {busy === "approve" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                  اعتماد الجهاز
                </Button>
                <Button variant="destructive" className="flex-1 gap-2" disabled={busy !== null} onClick={() => decide("reject")}>
                  {busy === "reject" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldX className="h-4 w-4" />}
                  رفض
                </Button>
              </div>
              <div className="text-xs text-muted-foreground">
                الطلب صالح لمدة 15 دقيقة من وقت محاولة الدخول. إذا انتهت الصلاحية أعد محاولة تسجيل الدخول ليصلك رابط جديد.
              </div>
            </>
          )}

          <div className="text-center text-xs">
            <a href="/login" onClick={e => { e.preventDefault(); setLocation("/login"); }} className="text-muted-foreground hover:text-foreground">
              العودة إلى تسجيل الدخول
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
