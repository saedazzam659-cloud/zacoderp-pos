import { useState } from "react";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { LogIn, Eye, EyeOff, ShieldCheck, Loader2 } from "lucide-react";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";

export default function Login() {
  const { t } = useTranslation();
  const [, setLocation] = useLocation();
  const { login } = useAuth();
  const { toast: _toast } = useToast();
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
      setError(err.message ?? t("auth.loginError"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-muted flex items-center justify-center p-4">
      <div className="w-full max-w-md">

        {/* Top bar with language switcher */}
        <div className="flex justify-end mb-2">
          <LanguageSwitcher variant="compact" />
        </div>

        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground text-2xl font-bold mb-4 shadow-lg">
            Z
          </div>
          <h1 className="text-3xl font-bold text-foreground">{t("auth.appName")}</h1>
          <p className="text-muted-foreground mt-2 text-sm">{t("auth.appSubtitle")}</p>
          <div className="flex items-center justify-center gap-1 mt-2 text-xs text-green-700 bg-green-50 border border-green-200 rounded-full px-3 py-1 w-fit mx-auto">
            <ShieldCheck className="h-3 w-3" />
            {t("auth.zatcaCompliant")}
          </div>
        </div>

        {/* Card */}
        <div className="bg-card border border-border rounded-2xl shadow-xl p-8 space-y-6">
          <div>
            <h2 className="text-xl font-semibold text-foreground">{t("auth.login")}</h2>
            <p className="text-sm text-muted-foreground mt-1">{t("auth.loginSubtitle")}</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">{t("auth.username")}</label>
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
              <label className="text-sm font-medium text-foreground">{t("auth.password")}</label>
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
              {loading ? t("common.loading") : t("auth.login")}
            </Button>
          </form>

          <div className="text-center text-sm text-muted-foreground border-t pt-4">
            {t("auth.noAccount")}{" "}
            <a href="/register" onClick={e => { e.preventDefault(); setLocation("/register"); }}
              className="text-primary font-medium hover:underline">
              {t("auth.createAccount")}
            </a>
          </div>
        </div>

        <p className="text-center text-xs text-muted-foreground mt-6">
          © 2026 {t("auth.appName")} — {t("auth.rights")}
        </p>
      </div>
    </div>
  );
}
