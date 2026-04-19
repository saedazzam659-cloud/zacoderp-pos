import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { LogIn, Eye, EyeOff, ShieldCheck, Loader2 } from "lucide-react";

export default function Login() {
  const [, setLocation] = useLocation();
  const { login } = useAuth();
  const { toast } = useToast();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(username.trim(), password);
      setLocation("/");
    } catch (err: any) {
      setError(err.message ?? "حدث خطأ. حاول مرة أخرى.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-muted flex items-center justify-center p-4" dir="rtl">
      <div className="w-full max-w-md">

        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground text-2xl font-bold mb-4 shadow-lg">
            Z
          </div>
          <h1 className="text-3xl font-bold text-foreground">نظام الفاتورة الإلكترونية</h1>
          <p className="text-muted-foreground mt-2 text-sm">متوافق مع هيئة الزكاة والدخل والجمارك</p>
          <div className="flex items-center justify-center gap-1 mt-2 text-xs text-green-700 bg-green-50 border border-green-200 rounded-full px-3 py-1 w-fit mx-auto">
            <ShieldCheck className="h-3 w-3" />
            ZATCA Compliant
          </div>
        </div>

        {/* Card */}
        <div className="bg-card border border-border rounded-2xl shadow-xl p-8 space-y-6">
          <div>
            <h2 className="text-xl font-semibold text-foreground">تسجيل الدخول</h2>
            <p className="text-sm text-muted-foreground mt-1">أدخل بيانات حسابك للوصول إلى لوحة التحكم</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">اسم المستخدم</label>
              <Input
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="admin"
                dir="ltr"
                className="text-left"
                autoComplete="username"
                required
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">كلمة المرور</label>
              <div className="relative">
                <Input
                  type={showPass ? "text" : "password"}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  dir="ltr"
                  className="text-left pl-10"
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPass(!showPass)}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-3">
                {error}
              </div>
            )}

            <Button type="submit" className="w-full gap-2" disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
              {loading ? "جاري تسجيل الدخول..." : "تسجيل الدخول"}
            </Button>
          </form>

          <div className="text-center text-sm text-muted-foreground border-t pt-4">
            ليس لديك حساب؟{" "}
            <a href="/register" onClick={e => { e.preventDefault(); setLocation("/register"); }}
              className="text-primary font-medium hover:underline">
              إنشاء حساب جديد
            </a>
          </div>
        </div>

        <p className="text-center text-xs text-muted-foreground mt-6">
          © 2026 نظام الفاتورة الإلكترونية — جميع الحقوق محفوظة
        </p>
      </div>
    </div>
  );
}
