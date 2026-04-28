import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  LogIn, Eye, EyeOff, ShieldCheck, Loader2, ShieldAlert, Mail,
  KeyRound, Smartphone, RefreshCw, ArrowLeft, Clock,
  Wallet, Boxes, ShoppingCart, Truck, Users, Factory,
  Landmark, Building2, FolderKanban, HardHat, Wrench, Hotel, Hospital,
  Sparkles, TrendingUp, BarChart3, Brain, Globe2, Zap, LayoutGrid, Play,
} from "lucide-react";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { CountrySelector } from "@/components/CountrySelector";
import { useVisitorCountry } from "@/lib/useVisitorCountry";
import { getCountryByCode } from "@/lib/countries";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: {
        sitekey: string;
        callback: (token: string) => void;
        "error-callback"?: () => void;
        "expired-callback"?: () => void;
        theme?: "light" | "dark";
      }) => string;
      reset: (id?: string) => void;
      remove: (id?: string) => void;
    };
    onTurnstileLoaded?: () => void;
  }
}

type Step = "creds" | "otp" | "device-approval" | "recovery-code" | "blocked";

interface OtpStartPayload {
  challengeToken: string;
  hint?: string;          // masked email
  otpExpiresInSec: number;
  riskLevel?: "low" | "medium" | "high";
  newDevice?: boolean;
}

interface DeviceApprovalPayload {
  approvalToken: string;
  expiresInSec: number;
}

const TURNSTILE_SITE_KEY = (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) ?? "";

export default function Login() {
  const { t } = useTranslation();
  const [, setLocation] = useLocation();
  const { login, setSession } = useAuth();
  const { toast } = useToast();

  // Common form state
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  // Flow state
  const [step, setStep] = useState<Step>("creds");
  const [isSuperAdminFlow, setIsSuperAdminFlow] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string>("");
  const turnstileMountRef = useRef<HTMLDivElement | null>(null);
  const turnstileWidgetIdRef = useRef<string | null>(null);

  // OTP state
  const [otp, setOtp] = useState<OtpStartPayload | null>(null);
  const [otpCode, setOtpCode] = useState("");
  const [otpRemaining, setOtpRemaining] = useState(0);

  // Device approval state
  const [approval, setApproval] = useState<DeviceApprovalPayload | null>(null);
  const [approvalStatus, setApprovalStatus] = useState<string>("pending");

  // Recovery code state
  const [recoveryCode, setRecoveryCode] = useState("");

  // ── Load Turnstile script when SA flow becomes active ──────────────────
  useEffect(() => {
    if (!isSuperAdminFlow || !TURNSTILE_SITE_KEY) return;
    if (window.turnstile) { renderTurnstile(); return; }

    const existing = document.getElementById("cf-turnstile-script");
    if (existing) {
      // Already loading; render when ready
      const onReady = () => renderTurnstile();
      window.onTurnstileLoaded = onReady;
      return;
    }
    const s = document.createElement("script");
    s.id = "cf-turnstile-script";
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoaded&render=explicit";
    s.async = true; s.defer = true;
    window.onTurnstileLoaded = () => renderTurnstile();
    document.head.appendChild(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuperAdminFlow, step]);

  function renderTurnstile() {
    if (!window.turnstile || !turnstileMountRef.current || turnstileWidgetIdRef.current) return;
    try {
      turnstileWidgetIdRef.current = window.turnstile.render(turnstileMountRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: (tk) => setTurnstileToken(tk),
        "error-callback": () => setTurnstileToken(""),
        "expired-callback": () => setTurnstileToken(""),
        theme: "light",
      });
    } catch { /* widget may have already been mounted */ }
  }

  function resetTurnstile() {
    setTurnstileToken("");
    if (window.turnstile && turnstileWidgetIdRef.current) {
      try { window.turnstile.reset(turnstileWidgetIdRef.current); } catch { /* ignore */ }
    }
  }

  // ── OTP countdown ──────────────────────────────────────────────────────
  useEffect(() => {
    if (step !== "otp" || otpRemaining <= 0) return;
    const id = setInterval(() => setOtpRemaining(s => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [step, otpRemaining]);

  // ── Device-approval polling ────────────────────────────────────────────
  useEffect(() => {
    if (step !== "device-approval" || !approval) return;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const r = await fetch(`${API_BASE}/api/auth/superadmin/device-approvals/${approval.approvalToken}/status`, {
          credentials: "include",
        });
        const j = await r.json().catch(() => ({}));
        if (j?.status) setApprovalStatus(j.status);
        if (j?.status === "approved") {
          setInfo(t("auth.sa.deviceApprovedRetry", "تم اعتماد الجهاز. أعد إدخال كلمة المرور للمتابعة."));
          setStep("creds");
          stopped = true;
        }
        if (j?.status === "rejected" || j?.status === "expired") {
          setError(j?.status === "rejected"
            ? t("auth.sa.deviceRejected", "تم رفض الجهاز من جهاز موثوق آخر.")
            : t("auth.sa.deviceExpired", "انتهت صلاحية طلب الموافقة. أعد المحاولة."));
          setStep("creds");
          stopped = true;
        }
      } catch { /* keep polling */ }
    };
    const id = setInterval(tick, 4000);
    tick();
    return () => { stopped = true; clearInterval(id); };
  }, [step, approval, t]);

  // ── Perform the SuperAdmin login proper ────────────────────────────────
  // Extracted so it can be called both directly (when the form is already in
  // SA mode) and chained automatically right after the universal /auth/login
  // call returns 409 + useSuperAdminFlow — so the user only needs one click.
  const performSuperAdminLogin = async (): Promise<void> => {
    const r = await fetch(`${API_BASE}/api/auth/superadmin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: username.trim(),
        password,
        turnstileToken: turnstileToken || undefined,
      }),
    });
    const j = await r.json().catch(() => ({}));

    if (r.status === 403 && j.blocked) {
      setStep("blocked");
      setError(j.error || t("auth.sa.blocked", "تم حظر المحاولة لأسباب أمنية."));
      return;
    }
    if (!r.ok) {
      setError(j.error || t("auth.loginError", "فشل تسجيل الدخول"));
      resetTurnstile();
      return;
    }
    if (j.requiresDeviceApproval) {
      setApproval({ approvalToken: j.approvalToken, expiresInSec: j.expiresInSec ?? 900 });
      setApprovalStatus("pending");
      setStep("device-approval");
      return;
    }
    if (j.requiresOtp) {
      setOtp({
        challengeToken: j.challengeToken,
        hint: j.hint,
        otpExpiresInSec: j.otpExpiresInSec ?? 60,
        riskLevel: j.riskLevel,
        newDevice: j.newDevice,
      });
      setOtpRemaining(j.otpExpiresInSec ?? 60);
      setOtpCode("");
      setStep("otp");
      return;
    }
    // Edge-case: server returned a full session immediately
    if (j.token && j.user) {
      setSession({ token: j.token, sessionId: j.sessionId ?? null, user: j.user });
      setLocation("/");
    }
  };

  // ── Submit credentials ─────────────────────────────────────────────────
  const submitCreds = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(""); setInfo("");
    setLoading(true);
    try {
      // If we're already in SA mode (e.g. user clicked "أنا سوبر أدمن" first,
      // or Turnstile required them to retry), go straight to SA login.
      if (isSuperAdminFlow) {
        await performSuperAdminLogin();
        return;
      }

      // Try the universal login endpoint first.
      try {
        await login(username.trim(), password);
        setLocation("/");
        return;
      } catch (err: any) {
        // 409 + useSuperAdminFlow signals: this account requires the SA flow.
        const isSAHint = err?.status === 409 && err?.data?.useSuperAdminFlow === true;
        if (!isSAHint) {
          setError(err?.message || t("auth.loginError", "فشل تسجيل الدخول"));
          return;
        }
        // Switch the UI into SA mode for any future actions.
        setIsSuperAdminFlow(true);

        // If Turnstile is required but not yet solved, stop here and let the
        // user solve the captcha — they'll click login again.
        if (TURNSTILE_SITE_KEY && !turnstileToken) {
          setInfo(t("auth.sa.detected", "هذا حساب سوبر أدمن — أكمل التحقق ثم اضغط دخول."));
          return;
        }

        // Otherwise chain straight into the SA login so the user only had to
        // click once.
        await performSuperAdminLogin();
      }
    } catch (err: any) {
      setError(err?.message || t("auth.loginError", "فشل تسجيل الدخول"));
    } finally {
      setLoading(false);
    }
  };

  // ── Submit OTP ─────────────────────────────────────────────────────────
  const submitOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otp) return;
    setError(""); setInfo("");
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/api/auth/superadmin/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeToken: otp.challengeToken, code: otpCode.trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(j.error || t("auth.sa.otpInvalid", "الرمز غير صحيح"));
        return;
      }
      setSession({ token: j.token, sessionId: j.sessionId ?? null, user: j.user });
      toast({ title: t("auth.sa.welcome", "أهلًا بعودتك") });
      setLocation("/");
    } catch (err: any) {
      setError(err?.message || t("auth.sa.otpInvalid", "الرمز غير صحيح"));
    } finally {
      setLoading(false);
    }
  };

  // ── Resend OTP ─────────────────────────────────────────────────────────
  const resendOtp = async () => {
    if (!otp || otpRemaining > 0) return;
    setError("");
    try {
      const r = await fetch(`${API_BASE}/api/auth/superadmin/resend-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeToken: otp.challengeToken }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || t("auth.sa.resendFailed", "فشل إعادة الإرسال")); return; }
      setOtpRemaining(j.otpExpiresInSec ?? 60);
      setInfo(t("auth.sa.resent", "أُرسل رمز جديد إلى بريدك."));
    } catch (err: any) {
      setError(err?.message || "");
    }
  };

  // ── Submit Recovery Code ───────────────────────────────────────────────
  const submitRecoveryCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(""); setInfo("");
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/api/auth/superadmin/use-recovery-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim(),
          password,
          recoveryCode: recoveryCode.trim().toUpperCase(),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || t("auth.sa.recoveryInvalid", "الرمز غير صحيح")); return; }
      setSession({ token: j.token, sessionId: j.sessionId ?? null, user: j.user });
      toast({ title: t("auth.sa.welcome", "أهلًا بعودتك") });
      setLocation("/");
    } catch (err: any) {
      setError(err?.message || "");
    } finally {
      setLoading(false);
    }
  };

  // ── Render helpers ─────────────────────────────────────────────────────
  function backToCreds() {
    setStep("creds"); setError(""); setInfo("");
    setOtp(null); setOtpCode(""); setApproval(null); setApprovalStatus("pending");
    setRecoveryCode("");
    resetTurnstile();
  }

  const formatSec = (s: number) => {
    const m = Math.floor(s / 60), ss = s % 60;
    return `${m}:${ss.toString().padStart(2, "0")}`;
  };

  // ── Layout ─────────────────────────────────────────────────────────────
  // Two-column "classic" layout:
  //   • Intro column (visual right in RTL): brand, ERP module grid,
  //     AI capabilities strip, and vision/mission micro-cards.
  //   • Form column (visual left in RTL): existing login flow card.
  // On screens narrower than `lg` we collapse to a single column with the
  // form FIRST (it's the primary action) and the intro stacked below it.
  // Logical grouping: financial → inventory → commercial → operations →
  // HR → industry verticals. The grid below collapses to 2 cols on mobile
  // and 3 cols on tablets+ so the list remains readable at any width.
  // Visitor country drives the welcome line + compliance pill in the
  // brand block. Auto-detected on first paint; user can override via the
  // CountrySelector at the top of the page.
  const [visitorCountry] = useVisitorCountry();
  // Click-to-play poster pattern, mirrors the Home hero. The iframe
  // is heavy (Framer Motion + GSAP scenes) so we defer its mount until
  // the visitor actually hits Play. Same standalone artifact as Home.
  const [videoStarted, setVideoStarted] = useState(false);
  const countryInfo = getCountryByCode(visitorCountry);

  const modules = [
    { icon: Wallet,        label: t("auth.intro.modules.accounting") },
    { icon: Landmark,      label: t("auth.intro.modules.banks") },
    { icon: Building2,     label: t("auth.intro.modules.fixedAssets") },
    { icon: Boxes,         label: t("auth.intro.modules.inventory") },
    { icon: ShoppingCart,  label: t("auth.intro.modules.sales") },
    { icon: Truck,         label: t("auth.intro.modules.purchases") },
    { icon: Factory,       label: t("auth.intro.modules.production") },
    { icon: FolderKanban,  label: t("auth.intro.modules.projects") },
    { icon: HardHat,       label: t("auth.intro.modules.contracting") },
    { icon: Wrench,        label: t("auth.intro.modules.maintenance") },
    { icon: Users,         label: t("auth.intro.modules.hr") },
    { icon: Hotel,         label: t("auth.intro.modules.hotels") },
    { icon: Hospital,      label: t("auth.intro.modules.hospitals") },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-muted flex items-center justify-center p-4 py-8">
      <div className="w-full max-w-6xl">
        <div className="flex justify-end items-center gap-2 mb-4">
          <CountrySelector variant="compact" testId="login-country-selector" />
          <LanguageSwitcher variant="compact" />
        </div>

        <div className="grid lg:grid-cols-[1.05fr_minmax(360px,440px)] gap-8 lg:gap-12 items-start">
          {/* ─── INTRO COLUMN ─────────────────────────────────────────── */}
          <aside className="order-2 lg:order-1 space-y-6">
            {/* Brand block — includes a country-aware welcome line that
                swaps out the regulator/policy text per visitor (CF-IPCountry
                or manual selector). For SA visitors the row keeps the
                existing "ZATCA compliant" pill; for other countries we
                substitute the local compliance summary from countries.ts. */}
            <div className="text-center lg:text-start">
              <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground text-2xl font-bold mb-3 shadow-lg">
                Z
              </div>
              <h1 className="text-2xl lg:text-3xl font-bold text-foreground">{t("auth.appName")}</h1>
              <p className="text-muted-foreground mt-1 text-sm">{t("auth.appSubtitle")}</p>
              <p className="text-xs text-muted-foreground mt-2" data-testid="login-country-welcome">
                مرحباً بزوّارنا من {countryInfo.nameAr} — العملة الافتراضية {countryInfo.currency.nameAr} ({countryInfo.currency.symbol}).
              </p>
              <div
                className="flex items-center gap-1 mt-3 text-xs text-green-700 bg-green-50 border border-green-200 rounded-full px-3 py-1 w-fit mx-auto lg:mx-0"
                data-testid="login-country-policy"
              >
                <ShieldCheck className="h-3 w-3" />
                {visitorCountry === "SA" ? t("auth.zatcaCompliant") : countryInfo.policyAr}
              </div>
            </div>

            {/* Tagline / parent product intro */}
            <div className="bg-card border border-border rounded-2xl p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <Sparkles className="h-4 w-4 text-primary" />
                <span className="text-xs font-bold tracking-wide text-primary uppercase">ZacodERP</span>
              </div>
              <p className="text-sm text-foreground leading-relaxed">
                {t("auth.intro.lead")}
              </p>
            </div>

            {/* ERP modules grid */}
            <div className="bg-card border border-border rounded-2xl p-5 shadow-sm">
              <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
                <LayoutGrid className="h-4 w-4 text-primary" />
                {t("auth.intro.modulesTitle")}
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                {modules.map(({ icon: Icon, label }) => (
                  <div
                    key={label}
                    className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-sm hover:border-primary/40 hover:bg-primary/5 transition-colors"
                  >
                    <Icon className="h-4 w-4 text-primary shrink-0" />
                    <span className="text-foreground">{label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Ease-of-use + AI video — same artifact as Home so the
                positioning stays consistent between the marketing page
                and the auth page. Click-to-play to keep the form-side
                of the screen snappy. */}
            <div
              className="relative aspect-video rounded-2xl overflow-hidden border shadow-lg bg-gradient-to-br from-slate-900 via-primary/30 to-slate-900"
              data-testid="login-video"
            >
              {videoStarted ? (
                <iframe
                  src="/install-guide-video/"
                  title="نظام محاسبة ذكي وسهل الاستخدام"
                  className="absolute inset-0 w-full h-full"
                  allow="autoplay; fullscreen"
                  data-testid="login-video-iframe"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setVideoStarted(true)}
                  className="absolute inset-0 w-full h-full flex flex-col items-center justify-center text-white group"
                  data-testid="login-video-play"
                  aria-label="شغّل الفيديو التعريفي"
                >
                  <span className="absolute inset-0 bg-black/40 group-hover:bg-black/30 transition-colors" />
                  <span className="relative inline-flex h-14 w-14 items-center justify-center rounded-full bg-primary shadow-xl group-hover:scale-110 transition-transform">
                    <Play className="h-6 w-6 ms-1 fill-white text-white" />
                  </span>
                  <span className="relative mt-3 text-sm font-bold text-center px-4">
                    شاهد كيف يجمع نظامنا بين السهولة والذكاء الاصطناعي
                  </span>
                  <span className="relative mt-2 flex flex-wrap justify-center gap-1.5 text-[10px]">
                    <span className="rounded-full bg-white/15 backdrop-blur px-2 py-0.5 inline-flex items-center gap-1">
                      <Sparkles className="h-2.5 w-2.5" /> ذكاء اصطناعي
                    </span>
                    <span className="rounded-full bg-white/15 backdrop-blur px-2 py-0.5 inline-flex items-center gap-1">
                      <Zap className="h-2.5 w-2.5" /> ≤ ٩٠ ث
                    </span>
                  </span>
                </button>
              )}
            </div>

            {/* AI capabilities strip */}
            <div className="bg-gradient-to-br from-primary/10 via-primary/5 to-transparent border border-primary/20 rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <Brain className="h-5 w-5 text-primary" />
                <h3 className="text-sm font-semibold text-foreground">{t("auth.intro.aiTitle")}</h3>
              </div>
              <ul className="space-y-2.5 text-sm text-foreground/80">
                <li className="flex items-start gap-2">
                  <TrendingUp className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <span>{t("auth.intro.aiBullets.financial")}</span>
                </li>
                <li className="flex items-start gap-2">
                  <BarChart3 className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <span>{t("auth.intro.aiBullets.reports")}</span>
                </li>
                <li className="flex items-start gap-2">
                  <Sparkles className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <span>{t("auth.intro.aiBullets.recommendations")}</span>
                </li>
              </ul>
            </div>

            {/* Vision / Mission micro-cards */}
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="border border-border rounded-xl p-4 bg-card/60">
                <div className="flex items-center gap-2 mb-1.5">
                  <Globe2 className="h-4 w-4 text-primary" />
                  <h4 className="text-xs font-semibold text-foreground">{t("auth.intro.visionTitle")}</h4>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {t("auth.intro.visionText")}
                </p>
              </div>
              <div className="border border-border rounded-xl p-4 bg-card/60">
                <div className="flex items-center gap-2 mb-1.5">
                  <Zap className="h-4 w-4 text-primary" />
                  <h4 className="text-xs font-semibold text-foreground">{t("auth.intro.missionTitle")}</h4>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {t("auth.intro.missionText")}
                </p>
              </div>
            </div>
          </aside>

          {/* ─── FORM COLUMN ──────────────────────────────────────────── */}
          <main className="order-1 lg:order-2 w-full lg:sticky lg:top-8">
            <div className="bg-card border border-border rounded-2xl shadow-xl p-8 space-y-6">
          {/* Step header */}
          <div>
            <h2 className="text-xl font-semibold text-foreground flex items-center gap-2">
              {isSuperAdminFlow && <ShieldAlert className="h-5 w-5 text-amber-600" />}
              {step === "creds" && (isSuperAdminFlow ? t("auth.sa.title", "تسجيل دخول السوبر أدمن") : t("auth.login"))}
              {step === "otp" && t("auth.sa.otpTitle", "إدخال رمز التحقق")}
              {step === "device-approval" && t("auth.sa.deviceTitle", "في انتظار اعتماد الجهاز")}
              {step === "recovery-code" && t("auth.sa.recoveryTitle", "استخدام رمز استرجاع")}
              {step === "blocked" && t("auth.sa.blockedTitle", "تم الحظر")}
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {step === "creds" && (isSuperAdminFlow
                ? t("auth.sa.subtitle", "هذا حساب صلاحياته عالية، نطبق تحققًا متعدد الطبقات.")
                : t("auth.loginSubtitle"))}
              {step === "otp" && t("auth.sa.otpSubtitle", "أدخل الرمز المُرسل إلى بريدك المسجل.")}
              {step === "device-approval" && t("auth.sa.deviceSubtitle", "أرسلنا رابط الموافقة إلى بريدك. اعتمد الجهاز من جهاز موثوق ثم عد إلى هنا.")}
              {step === "recovery-code" && t("auth.sa.recoverySubtitle", "أدخل أحد رموز الاسترجاع المخزنة لديك.")}
              {step === "blocked" && t("auth.sa.blockedSubtitle", "تواصل مع المسؤول.")}
            </p>
          </div>

          {/* ── STEP: creds ─────────────────────────────────────────── */}
          {(step === "creds" || step === "blocked") && (
            <form onSubmit={submitCreds} className="space-y-4">
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
                  disabled={step === "blocked"}
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
                    disabled={step === "blocked"}
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

              {/* Turnstile widget — only shown for SA flow when site key configured */}
              {isSuperAdminFlow && TURNSTILE_SITE_KEY && (
                <div className="flex justify-center"><div ref={turnstileMountRef} /></div>
              )}
              {isSuperAdminFlow && !TURNSTILE_SITE_KEY && (
                <div className="text-xs text-muted-foreground bg-muted rounded-md px-3 py-2 flex items-start gap-2">
                  <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>{t("auth.sa.turnstileMissing", "لم يُفعّل Turnstile (إعداد الخادم).")}</span>
                </div>
              )}

              {info && (
                <div className="text-sm text-blue-700 bg-blue-50 border border-blue-200 rounded-lg p-3">
                  {info}
                </div>
              )}
              {error && (
                <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-3">
                  {error}
                </div>
              )}

              <Button
                type="submit"
                className="w-full gap-2"
                disabled={loading || step === "blocked"
                  || (isSuperAdminFlow && !!TURNSTILE_SITE_KEY && !turnstileToken)}
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                {loading ? t("common.loading") : t("auth.login")}
              </Button>

              {isSuperAdminFlow && step !== "blocked" && (
                <div className="flex items-center justify-between text-xs">
                  <button
                    type="button"
                    onClick={() => { setIsSuperAdminFlow(false); resetTurnstile(); setError(""); setInfo(""); }}
                    className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                  >
                    <ArrowLeft className="h-3 w-3" />
                    {t("auth.sa.notSuperAdmin", "لست سوبر أدمن")}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setStep("recovery-code"); setError(""); setInfo(""); }}
                    className="text-primary hover:underline inline-flex items-center gap-1"
                  >
                    <KeyRound className="h-3 w-3" />
                    {t("auth.sa.useRecovery", "استخدام رمز استرجاع")}
                  </button>
                </div>
              )}

              {/* SuperAdmin entry button is hidden by request — superadmins
                  are auto-routed through the multi-factor flow once the
                  backend identifies their account from the credentials. */}
            </form>
          )}

          {/* ── STEP: otp ───────────────────────────────────────────── */}
          {step === "otp" && otp && (
            <form onSubmit={submitOtp} className="space-y-4">
              <div className="bg-muted rounded-lg p-3 text-sm flex items-start gap-2">
                <Mail className="h-4 w-4 mt-0.5 shrink-0" />
                <div>
                  <div className="font-medium">{t("auth.sa.otpSent", "أُرسل رمز التحقق إلى:")}</div>
                  <div className="text-muted-foreground" dir="ltr">{otp.hint || "—"}</div>
                </div>
              </div>

              {otp.newDevice && (
                <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-start gap-2">
                  <Smartphone className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>{t("auth.sa.newDeviceWarn", "هذا جهاز جديد — سنُضيفه إلى الأجهزة الموثوقة بعد التحقق.")}</span>
                </div>
              )}

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">{t("auth.sa.code", "الرمز (٦ أرقام)")}</label>
                <Input
                  value={otpCode}
                  onChange={e => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="000000"
                  dir="ltr"
                  className="text-center text-2xl tracking-[0.5em] font-mono"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  autoFocus
                  required
                />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {otpRemaining > 0
                      ? t("auth.sa.expiresIn", "تنتهي خلال {{t}}", { t: formatSec(otpRemaining) })
                      : t("auth.sa.expired", "انتهت الصلاحية")}
                  </span>
                  <button
                    type="button"
                    onClick={resendOtp}
                    disabled={otpRemaining > 0}
                    className="inline-flex items-center gap-1 text-primary disabled:text-muted-foreground"
                  >
                    <RefreshCw className="h-3 w-3" />
                    {t("auth.sa.resend", "إعادة إرسال")}
                  </button>
                </div>
              </div>

              {error && (
                <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-3">
                  {error}
                </div>
              )}
              {info && (
                <div className="text-sm text-blue-700 bg-blue-50 border border-blue-200 rounded-lg p-3">
                  {info}
                </div>
              )}

              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={backToCreds} className="gap-1">
                  <ArrowLeft className="h-4 w-4" />
                  {t("common.back", "رجوع")}
                </Button>
                <Button type="submit" className="flex-1 gap-2" disabled={loading || otpCode.length !== 6}>
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                  {t("auth.sa.verify", "تحقق")}
                </Button>
              </div>

              <div className="text-center text-xs">
                <button
                  type="button"
                  onClick={() => { setStep("recovery-code"); setError(""); setInfo(""); }}
                  className="text-primary hover:underline inline-flex items-center gap-1"
                >
                  <KeyRound className="h-3 w-3" />
                  {t("auth.sa.useRecoveryInstead", "تعذّر الوصول للبريد؟ استخدم رمز استرجاع")}
                </button>
              </div>
            </form>
          )}

          {/* ── STEP: device approval ───────────────────────────────── */}
          {step === "device-approval" && approval && (
            <div className="space-y-4">
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
                <Smartphone className="h-5 w-5 text-amber-700 mt-0.5 shrink-0" />
                <div className="text-sm">
                  <div className="font-medium text-amber-900">{t("auth.sa.deviceTitle", "في انتظار اعتماد الجهاز")}</div>
                  <p className="text-amber-800 mt-1">
                    {t("auth.sa.deviceBody", "أرسلنا رابط الموافقة إلى بريد السوبر أدمن. افتح الرابط من أي جهاز/جلسة موثوقة لاعتماد هذا الجهاز.")}
                  </p>
                </div>
              </div>

              <div className="text-center text-sm">
                <div className="inline-flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("auth.sa.statusLabel", "الحالة")}: <span className="font-medium">{approvalStatus}</span>
                </div>
              </div>

              {error && (
                <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-3">
                  {error}
                </div>
              )}

              <Button type="button" variant="outline" onClick={backToCreds} className="w-full gap-1">
                <ArrowLeft className="h-4 w-4" />
                {t("common.back", "رجوع")}
              </Button>
            </div>
          )}

          {/* ── STEP: recovery code ─────────────────────────────────── */}
          {step === "recovery-code" && (
            <form onSubmit={submitRecoveryCode} className="space-y-4">
              <div className="bg-muted rounded-lg p-3 text-sm flex items-start gap-2">
                <KeyRound className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{t("auth.sa.recoveryHint", "أدخل بيانات حسابك ورمز استرجاع لاستخدامه مرة واحدة.")}</span>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">{t("auth.username")}</label>
                <Input value={username} onChange={e => setUsername(e.target.value)} dir="ltr" className="text-left" required />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">{t("auth.password")}</label>
                <Input type="password" value={password} onChange={e => setPassword(e.target.value)} dir="ltr" className="text-left" required />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">{t("auth.sa.recoveryCode", "رمز الاسترجاع")}</label>
                <Input
                  value={recoveryCode}
                  onChange={e => setRecoveryCode(e.target.value.toUpperCase())}
                  placeholder="XXXX-XXXX"
                  dir="ltr"
                  className="text-center text-lg tracking-widest font-mono"
                  required
                />
              </div>

              {error && (
                <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-3">
                  {error}
                </div>
              )}

              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={backToCreds} className="gap-1">
                  <ArrowLeft className="h-4 w-4" />
                  {t("common.back", "رجوع")}
                </Button>
                <Button type="submit" className="flex-1 gap-2" disabled={loading}>
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                  {t("auth.sa.useCode", "استخدام الرمز")}
                </Button>
              </div>

              <div className="text-center text-xs">
                <a
                  href="/recover-superadmin"
                  onClick={e => { e.preventDefault(); setLocation("/recover-superadmin"); }}
                  className="text-primary hover:underline"
                >
                  {t("auth.sa.lostAll", "فقدت كل شيء؟ اطلب رابط استرجاع")}
                </a>
              </div>
            </form>
          )}

          {/* Footer (hide for blocked) */}
          {step === "creds" && !isSuperAdminFlow && (
            <div className="text-center text-sm text-muted-foreground border-t pt-4 space-y-2">
              <div>
                {t("auth.noAccount")}{" "}
                <a href="/register" onClick={e => { e.preventDefault(); setLocation("/register"); }}
                  className="text-primary font-medium hover:underline">
                  {t("auth.createAccount")}
                </a>
              </div>
              {/* Public pricing link — surfaces the new top-of-funnel landing
                  page so visitors who hit /login first can still browse plans
                  without committing to an account creation. */}
              <div>
                <a
                  href="/pricing"
                  onClick={e => { e.preventDefault(); setLocation("/pricing"); }}
                  data-testid="login-view-pricing"
                  className="inline-flex items-center gap-1 text-primary font-medium hover:underline"
                >
                  عرض الباقات والأسعار
                </a>
              </div>
            </div>
          )}
        </div>

              <p className="text-center text-xs text-muted-foreground mt-6">
                © 2026 {t("auth.appName")} — {t("auth.rights")}
              </p>
            </main>
          </div>
        </div>
      </div>
  );
}
