import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Handshake, Loader2, AlertCircle } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─────────────────────────────────────────────────────────────────────────
// Reseller (Agent) portal login — Task #237.
//
// Resellers authenticate against /api/reseller/login (NOT /api/auth/login):
// they are a distinct identity living in the `resellers` table. On success we
// install the returned token via the shared AuthContext setSession(); the
// /api/auth/me endpoint already resolves reseller tokens (role:"reseller"),
// so the rest of the app boots into the portal branch automatically.
// ─────────────────────────────────────────────────────────────────────────

export default function ResellerLogin() {
  const { setSession } = useAuth() as any;
  const [, navigate] = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/reseller/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "تعذّر تسجيل الدخول");
        return;
      }
      setSession({
        token: data.token,
        sessionId: data.user?.sessionId ?? null,
        user: {
          ...data.user,
          resellerPermissions: data.user?.permissions ?? {},
        },
      });
      navigate("/reseller");
    } catch {
      setError("تعذّر الاتصال بالخادم");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div dir="rtl" className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100 p-4">
      <Card className="w-full max-w-md shadow-xl border-slate-200">
        <CardContent className="p-8">
          <div className="flex flex-col items-center mb-6">
            <div className="h-14 w-14 rounded-2xl bg-primary/10 flex items-center justify-center mb-3">
              <Handshake className="h-7 w-7 text-primary" />
            </div>
            <h1 className="text-xl font-bold text-slate-800">بوابة الموزّعين</h1>
            <p className="text-sm text-slate-500 mt-1">تسجيل دخول الوكلاء والموزّعين</p>
          </div>

          {error && (
            <div className="mb-4 flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <Label htmlFor="r-username">اسم المستخدم</Label>
              <Input
                id="r-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
                className="mt-1"
                data-testid="input-reseller-username"
              />
            </div>
            <div>
              <Label htmlFor="r-password">كلمة المرور</Label>
              <Input
                id="r-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                className="mt-1"
                data-testid="input-reseller-password"
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading} data-testid="button-reseller-login">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "تسجيل الدخول"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
