import { useEffect, useRef, useState, type SyntheticEvent } from "react";
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
  Sparkles, TrendingUp, BarChart3, Brain, Globe2, Zap, LayoutGrid,
} from "lucide-react";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { CountrySelector } from "@/components/CountrySelector";
import { DemoProvisioningOverlay } from "@/components/DemoProvisioningOverlay";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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

  // ── Agent-domain branding ─────────────────────────────────────────────
  // When the login page is served from a registered agent (reseller)
  // domain, we show the AGENT's system name + logo instead of the Zacode
  // brand, and we hide self-signup entirely (server also blocks /register
  // for agent hosts). Best-effort — any failure falls back to default brand.
  const [agentBrand, setAgentBrand] = useState<{ isAgentDomain: boolean; brandName?: string | null; brandLogoUrl?: string | null; brandColor?: string | null } | null>(null);
  // Tracks whether the branding probe finished (either way). App-download
  // badges must NOT render until we KNOW the host is not an agent domain —
  // otherwise they'd flash on reseller login pages while /api/branding is
  // still in flight.
  const [brandingResolved, setBrandingResolved] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE}/api/branding?host=${encodeURIComponent(window.location.hostname)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (alive && j?.isAgentDomain) setAgentBrand(j); })
      .catch(() => {})
      .finally(() => { if (alive) setBrandingResolved(true); });
    return () => { alive = false; };
  }, []);
  const isAgentDomain = !!agentBrand?.isAgentDomain;
  const defaultLogo = `${import.meta.env.BASE_URL}favicon.svg`;
  const loginLogo = isAgentDomain && agentBrand?.brandLogoUrl ? agentBrand.brandLogoUrl : defaultLogo;
  const fallbackLogo = (event: SyntheticEvent<HTMLImageElement>) => {
    if (event.currentTarget.getAttribute("src") !== defaultLogo) event.currentTarget.src = defaultLogo;
  };
  // On agent domains, every marketing string that mentions the Zacode brand
  // is rewritten to the agent's own brand name — the reseller's page must
  // never advertise the upstream platform.
  const brandize = (s: string) =>
    isAgentDomain && agentBrand?.brandName
      ? s.replace(/زاكود المحاسبي|زاكود|ZacodERP|ZACODERP|Zacode/gi, agentBrand.brandName)
      : s;

  // ── Mobile app download links (login-page badges) ────────────────────
  // Public endpoint; rows exist only after SuperAdmin configures them in
  // إدارة أجهزة POS ← الإصدارات. Missing platform → its badge is hidden.
  const [mobileApps, setMobileApps] = useState<{ platform: string; latestVersion: string; downloadUrl: string }[]>([]);
  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE}/api/public/download/mobile-apps`)
      .then(r => (r.ok ? r.json() : []))
      .then(j => { if (alive && Array.isArray(j)) setMobileApps(j); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const androidApp = mobileApps.find(a => a.platform === "android");
  const iosApp = mobileApps.find(a => a.platform === "ios");

  // After a successful login we usually go to the home dashboard, but if
  // the user got here via a deep-link redirect (e.g. opened
  // /accounting in a fresh tab while logged out), App.tsx forwards
  // them to /login?redirect=<original-path>. Honor that target so the
  // user lands on the page they actually wanted.
  const goAfterLogin = () => {
    let target = "/";
    try {
      const sp = new URLSearchParams(window.location.search);
      const raw = sp.get("redirect");
      if (raw) {
        // Same open-redirect guard as App.tsx#safeRedirectTarget:
        // must be a single-leading-slash in-app path, no scheme,
        // no protocol-relative "//".
        if (raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("://")) {
          target = raw;
        }
      }
    } catch { /* noop */ }
    setLocation(target);
  };

  // Common form state
  // companyCode is the public, human-friendly tenant code shown to the
  // user at registration (e.g. "ZTC-1042"). The new login form
  // disambiguates duplicate usernames across companies via this field.
  // We pre-fill from localStorage so returning users on the same browser
  // don't have to retype it. SuperAdmin path leaves it empty; the
  // server's 409 useSuperAdminFlow hint still pivots them automatically.
  const LAST_COMPANY_CODE_KEY = "zatca_last_company_code";
  const [companyCode, setCompanyCode] = useState<string>(() => {
    try { return localStorage.getItem(LAST_COMPANY_CODE_KEY) ?? ""; }
    catch { return ""; }
  });
  // Login mode: regular tenant (company code + username) vs trainee
  // (متدرب) — trainees log in with email + password ONLY, no company code;
  // the server resolves them via the is_trainee username lookup.
  const [loginMode, setLoginMode] = useState<"company" | "trainee">("company");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [demoPhone, setDemoPhone] = useState("");
  const [showDemoPhoneConfirm, setShowDemoPhoneConfirm] = useState(false);
  const [demoPhoneLoading, setDemoPhoneLoading] = useState(false);
  const [demoPhoneError, setDemoPhoneError] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showDemoPreparation, setShowDemoPreparation] = useState(false);
  const [demoPreparationProgress, setDemoPreparationProgress] = useState(0);
  const [showDemoTransfer, setShowDemoTransfer] = useState(false);
  const [demoTransferLoading, setDemoTransferLoading] = useState(false);
  const [demoTransferError, setDemoTransferError] = useState("");
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
      goAfterLogin();
    }
  };

  // Never show raw server internals in the red error box. A backend fault on
  // an agent-domain server once returned a giant SQL/permission-keys blob as
  // `error`, which was rendered verbatim here. Anything long or SQL/JSON-like
  // collapses to a short friendly message.
  // After a publish, agent servers pull the new release and restart; for a
  // couple of minutes the first login attempt fails with a network error or a
  // gateway 502/503/504. Showing the generic "فشل تسجيل الدخول" there misleads
  // users into thinking their credentials are wrong — surface a clear
  // "server is updating" message instead.
  const isServerUnreachable = (err: any): boolean => {
    const status = err?.status;
    if (status === 502 || status === 503 || status === 504) return true;
    if (typeof status === "number") return false; // real server response
    const m = String(err?.message ?? "");
    return err instanceof TypeError ||
      /failed to fetch|load failed|networkerror|network request failed|fetch failed|timeout|timed out|econnrefused/i.test(m);
  };
  const SERVER_UPDATING_MSG = t(
    "auth.serverUpdating",
    "الخادم يتم تحديثه الآن — بياناتك صحيحة، انتظر دقيقة ثم حاول مرة أخرى.",
  );

  const friendlyError = (msg: unknown, fallback: string): string => {
    const s = typeof msg === "string" ? msg.trim() : "";
    if (!s) return fallback;
    if (s.length > 300 || /["'{\[].{80,}/s.test(s) ||
        /select |insert |column |relation |syntax error|constraint/i.test(s)) {
      return t("auth.serverError", "حدث خطأ في الخادم. حاول مرة أخرى أو تواصل مع الدعم.");
    }
    return s;
  };

  const checkDemoPreparation = async (
    cleanUsername: string,
    cleanCompanyCode: string,
    phone = "",
  ): Promise<{ needsPreparation: boolean; transferRequired: boolean; phoneRequired: boolean }> => {
    if (!cleanCompanyCode || loginMode !== "company") {
      return { needsPreparation: false, transferRequired: false, phoneRequired: false };
    }
    let legacyDeviceToken = "";
    try {
      const stored = localStorage.getItem("zatca_demo_device_token") ?? "";
      if (/^[A-Za-z0-9_-]{24,256}$/.test(stored)) legacyDeviceToken = stored;
    } catch { /* HttpOnly cookie remains the primary device identity */ }

    try {
      const response = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: cleanUsername,
          password,
          companyCode: cleanCompanyCode,
          intent: "check_demo_preparation",
          ...(phone.trim() ? { demoPhone: phone.trim() } : {}),
          ...(legacyDeviceToken ? { demoDeviceToken: legacyDeviceToken } : {}),
        }),
      });
      if (!response.ok) return { needsPreparation: false, transferRequired: false, phoneRequired: false };
      const data = await response.json().catch(() => ({}));
      return {
        needsPreparation: data.needsPreparation === true,
        transferRequired: data.transferRequired === true,
        phoneRequired: data.phoneRequired === true,
      };
    } catch {
      // The real login request below remains the source of truth for errors.
      return { needsPreparation: false, transferRequired: false, phoneRequired: false };
    }
  };

  const rememberCompanyCode = (cleanCompanyCode: string) => {
    if (!cleanCompanyCode) return;
    try { localStorage.setItem(LAST_COMPANY_CODE_KEY, cleanCompanyCode); }
    catch { /* private mode / quota — non-fatal */ }
  };

  const confirmDemoSessionTransfer = async () => {
    const cleanCompanyCode = companyCode.trim().toUpperCase();
    const cleanUsername = username.trim();
    setDemoTransferLoading(true);
    setDemoTransferError("");
    try {
      await login(cleanUsername, password, cleanCompanyCode, {
        confirmDemoSessionTransfer: true,
        demoPhone,
      });
      rememberCompanyCode(cleanCompanyCode);
      setShowDemoTransfer(false);
      goAfterLogin();
    } catch (err: any) {
      setDemoTransferError(
        isServerUnreachable(err)
          ? SERVER_UPDATING_MSG
          : friendlyError(err?.message, t("auth.loginError", "فشل تسجيل الدخول")),
      );
    } finally {
      setDemoTransferLoading(false);
    }
  };

  const confirmDemoPhoneAndLogin = async () => {
    const phone = demoPhone.trim();
    if (!/^[+\d][\d\s()-]{6,24}$/.test(phone)) {
      setDemoPhoneError("أدخل رقم هاتف صحيحًا للمتابعة");
      return;
    }
    const cleanCompanyCode = companyCode.trim().toUpperCase();
    const cleanUsername = username.trim();
    setDemoPhoneLoading(true);
    setDemoPhoneError("");
    try {
      const preflight = await checkDemoPreparation(cleanUsername, cleanCompanyCode, phone);
      if (preflight.phoneRequired) {
        setDemoPhoneError("تعذر تأكيد رقم الهاتف. راجع الرقم وحاول مرة أخرى.");
        return;
      }
      if (preflight.transferRequired) {
        setShowDemoPhoneConfirm(false);
        setShowDemoTransfer(true);
        return;
      }
      if (preflight.needsPreparation) {
        setDemoPreparationProgress(0);
        setShowDemoPreparation(true);
      }
      await login(cleanUsername, password, cleanCompanyCode, { demoPhone: phone });
      rememberCompanyCode(cleanCompanyCode);
      setDemoPreparationProgress(100);
      setShowDemoPhoneConfirm(false);
      goAfterLogin();
    } catch (err: any) {
      if (err?.status === 409 && err?.data?.code === "DEMO_SESSION_TRANSFER_REQUIRED") {
        setShowDemoPhoneConfirm(false);
        setShowDemoTransfer(true);
        return;
      }
      setDemoPhoneError(
        isServerUnreachable(err)
          ? SERVER_UPDATING_MSG
          : friendlyError(err?.message, t("auth.loginError", "فشل تسجيل الدخول")),
      );
    } finally {
      setShowDemoPreparation(false);
      setDemoPhoneLoading(false);
    }
  };

  // ── Submit credentials ─────────────────────────────────────────────────
  const submitCreds = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(""); setInfo("");
    setLoading(true);
    let preparationShownForAttempt = false;
    let preparationStartedAt = 0;
    let loginSucceeded = false;
    try {
      // If we're already in SA mode (e.g. user clicked "أنا سوبر أدمن" first,
      // or Turnstile required them to retry), go straight to SA login.
      if (isSuperAdminFlow) {
        await performSuperAdminLogin();
        return;
      }

      // Try the universal login endpoint first. We forward the
      // companyCode the user typed; on success we remember it for the
      // next visit so returning users only have to type it once.
      try {
        const trimmedCode = loginMode === "trainee" ? "" : companyCode.trim().toUpperCase();
        const trimmedUsername = username.trim();
        const demoPreflight = await checkDemoPreparation(trimmedUsername, trimmedCode);
        if (demoPreflight.phoneRequired) {
          setDemoPhone("");
          setDemoPhoneError("");
          setShowDemoPhoneConfirm(true);
          return;
        }
        if (demoPreflight.transferRequired) {
          setDemoTransferError("");
          setShowDemoTransfer(true);
          return;
        }
        if (demoPreflight.needsPreparation) {
          preparationShownForAttempt = true;
          preparationStartedAt = Date.now();
          setDemoPreparationProgress(0);
          setShowDemoPreparation(true);
        }

        await login(trimmedUsername, password, trimmedCode, { demoPhone });
        rememberCompanyCode(trimmedCode);
        if (preparationShownForAttempt) {
          setDemoPreparationProgress(100);
          const elapsed = Date.now() - preparationStartedAt;
          await new Promise(resolve => window.setTimeout(resolve, Math.max(250, 900 - elapsed)));
        }
        loginSucceeded = true;
        goAfterLogin();
        return;
      } catch (err: any) {
        if (err?.status === 428 && err?.data?.code === "DEMO_PHONE_REQUIRED") {
          setDemoPhone("");
          setDemoPhoneError("");
          setShowDemoPhoneConfirm(true);
          return;
        }
        if (err?.status === 409 && err?.data?.code === "DEMO_SESSION_TRANSFER_REQUIRED") {
          setDemoTransferError("");
          setShowDemoTransfer(true);
          return;
        }
        // 409 + useSuperAdminFlow signals: this account requires the SA flow.
        const isSAHint = err?.status === 409 && err?.data?.useSuperAdminFlow === true;
        if (!isSAHint) {
          setError(
            isServerUnreachable(err)
              ? SERVER_UPDATING_MSG
              : friendlyError(err?.message, t("auth.loginError", "فشل تسجيل الدخول")),
          );
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
      setError(
        isServerUnreachable(err)
          ? SERVER_UPDATING_MSG
          : friendlyError(err?.message, t("auth.loginError", "فشل تسجيل الدخول")),
      );
    } finally {
      setLoading(false);
      if (!loginSucceeded) {
        setShowDemoPreparation(false);
        setDemoPreparationProgress(0);
      }
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
      goAfterLogin();
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
      goAfterLogin();
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
      <DemoProvisioningOverlay
        isVisible={showDemoPreparation}
        progress={demoPreparationProgress}
      />
      <AlertDialog
        open={showDemoPhoneConfirm}
        onOpenChange={(open) => {
          if (demoPhoneLoading) return;
          setShowDemoPhoneConfirm(open);
          if (!open) setDemoPhoneError("");
        }}
      >
        <AlertDialogContent dir="rtl" data-testid="demo-phone-dialog">
          <AlertDialogHeader className="text-right sm:text-right">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary sm:mx-0">
              <Smartphone className="h-6 w-6" />
            </div>
            <AlertDialogTitle>تأكيد رقم الهاتف للديمو</AlertDialogTitle>
            <AlertDialogDescription className="text-right leading-6">
              أدخل رقم هاتفك لحفظ بيئة الديمو الخاصة بك واستعادتها عند الدخول من جهاز آخر.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium">رقم الهاتف</label>
            <Input
              value={demoPhone}
              onChange={(event) => {
                setDemoPhone(event.target.value);
                setDemoPhoneError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void confirmDemoPhoneAndLogin();
                }
              }}
              placeholder="05xxxxxxxx"
              dir="ltr"
              inputMode="tel"
              autoFocus
              disabled={demoPhoneLoading}
              data-testid="demo-phone-input"
            />
          </div>
          {demoPhoneError && (
            <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
              {demoPhoneError}
            </div>
          )}
          <AlertDialogFooter className="gap-2 sm:space-x-0">
            <AlertDialogCancel disabled={demoPhoneLoading}>إلغاء</AlertDialogCancel>
            <AlertDialogAction
              disabled={demoPhoneLoading || !demoPhone.trim()}
              onClick={(event) => {
                event.preventDefault();
                void confirmDemoPhoneAndLogin();
              }}
              data-testid="demo-phone-confirm"
              className="gap-2"
            >
              {demoPhoneLoading && <Loader2 className="h-4 w-4 animate-spin" />}
              {demoPhoneLoading ? "جارٍ تجهيز الديمو..." : "تأكيد والدخول"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={showDemoTransfer}
        onOpenChange={(open) => {
          if (demoTransferLoading) return;
          setShowDemoTransfer(open);
          if (!open) setDemoTransferError("");
        }}
      >
        <AlertDialogContent dir="rtl" data-testid="demo-session-transfer-dialog">
          <AlertDialogHeader className="text-right sm:text-right">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-700 sm:mx-0">
              <Smartphone className="h-6 w-6" />
            </div>
            <AlertDialogTitle>نقل جلسة الديمو إلى هذا المتصفح؟</AlertDialogTitle>
            <AlertDialogDescription className="text-right leading-6">
              يوجد تسجيل ديمو نشط في متصفح آخر. عند المتابعة سيتم تسجيل الخروج من
              المتصفح السابق وفتح الحساب هنا، مع الاحتفاظ ببيانات الديمو الحالية.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {demoTransferError && (
            <div
              className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive"
              data-testid="demo-session-transfer-error"
            >
              {demoTransferError}
            </div>
          )}
          <AlertDialogFooter className="gap-2 sm:space-x-0">
            <AlertDialogCancel
              disabled={demoTransferLoading}
              data-testid="demo-session-transfer-cancel"
            >
              إبقاء الجلسة السابقة
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={demoTransferLoading}
              onClick={(event) => {
                event.preventDefault();
                void confirmDemoSessionTransfer();
              }}
              data-testid="demo-session-transfer-confirm"
              className="gap-2"
            >
              {demoTransferLoading
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <RefreshCw className="h-4 w-4" />}
              {demoTransferLoading ? "جارٍ نقل الجلسة..." : "نقل الجلسة والدخول"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <div className="w-full max-w-6xl">
        <div className="flex justify-end items-center gap-2 mb-4">
          {/* Country picker is normally hidden — auto-detection (cookie →
              CF-IPCountry → Geo-IP) handles 99% of visitors. We only
              surface the manual override when detection fell through to
              the GLOBAL sentinel, so the user has a way out without
              cluttering the UI for everyone else. */}
          {visitorCountry === "GLOBAL" && (
            <CountrySelector variant="compact" testId="login-country-selector" />
          )}
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
              <img
                src={loginLogo}
                onError={fallbackLogo}
                alt={isAgentDomain ? (agentBrand?.brandName ?? "") : "زاكود Zacode"}
                className={isAgentDomain && agentBrand?.brandLogoUrl
                  ? "inline-block w-full max-w-[240px] h-28 sm:h-36 rounded-2xl mb-3 shadow-lg object-contain bg-white p-2"
                  : "inline-block h-14 w-14 rounded-2xl mb-3 shadow-lg object-contain bg-white"}
                data-testid="login-brand-mark"
              />
              <h1 className="text-2xl lg:text-3xl font-bold text-foreground">
                {brandingResolved ? (isAgentDomain && agentBrand?.brandName ? agentBrand.brandName : t("auth.appName")) : "\u00A0"}
              </h1>
              {/* Subtitle + country welcome + compliance pill — Zacode
                  marketing copy, hidden entirely on agent domains. */}
              {brandingResolved && !isAgentDomain && (<>
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
              </>)}
            </div>

            {/* Marketing cards — hidden entirely on agent (white-label) domains.
                Also hidden until the branding probe resolves, so reseller
                pages never flash the Zacode marketing content. */}
            {brandingResolved && !isAgentDomain && (<>
            {/* Tagline / parent product intro */}
            <div className="bg-card border border-border rounded-2xl p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <Sparkles className="h-4 w-4 text-primary" />
                <span className="text-xs font-bold tracking-wide text-primary uppercase">ZacodERP</span>
              </div>
              <p className="text-sm text-foreground leading-relaxed">
                {brandize(t("auth.intro.lead"))}
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
            </>)}
          </aside>

          {/* ─── FORM COLUMN ──────────────────────────────────────────── */}
          <main className="order-1 lg:order-2 w-full lg:sticky lg:top-8 space-y-4">
            {/* Mobile-only welcome hero — gives PWA users a friendly,
                branded landing before the form. Desktop already has the
                full intro column on the left, so we hide this on lg+. */}
            <div className="lg:hidden relative overflow-hidden rounded-3xl bg-gradient-to-br from-primary via-emerald-600 to-teal-600 p-6 text-white shadow-xl">
              <div className="absolute -top-16 -end-16 h-44 w-44 rounded-full bg-white/10 blur-2xl" />
              <div className="absolute -bottom-12 -start-10 h-36 w-36 rounded-full bg-white/10 blur-2xl" />
              <div className="relative flex items-center gap-3">
                <div className={`${isAgentDomain && agentBrand?.brandLogoUrl ? "h-20 w-20 sm:h-24 sm:w-24" : "h-14 w-14"} rounded-2xl bg-white/95 p-2 shadow-lg ring-1 ring-white/40 shrink-0`}>
                  <img
                    src={loginLogo}
                    onError={fallbackLogo}
                    alt={isAgentDomain ? (agentBrand?.brandName ?? "") : "زاكود"}
                    className="h-full w-full object-contain"
                  />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] font-bold tracking-widest text-white/80 uppercase">{brandingResolved ? (isAgentDomain ? (agentBrand?.brandName ?? "") : "ZacodERP") : "\u00A0"}</p>
                  <h1 className="text-xl font-extrabold leading-tight truncate">أهلاً بعودتك 👋</h1>
                  <p className="text-xs text-white/85 mt-0.5">سجّل دخولك للمتابعة</p>
                </div>
              </div>
              <div className="relative mt-4 flex flex-wrap gap-1.5">
                <span className="inline-flex items-center gap-1 rounded-full bg-white/20 backdrop-blur px-2.5 py-1 text-[11px] font-semibold">
                  <ShieldCheck className="h-3 w-3" />
                  {visitorCountry === "SA" ? "متوافق مع زاتكا" : countryInfo.policyAr}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-white/20 backdrop-blur px-2.5 py-1 text-[11px] font-semibold">
                  <Sparkles className="h-3 w-3" />
                  ذكاء اصطناعي
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-white/20 backdrop-blur px-2.5 py-1 text-[11px] font-semibold">
                  <Zap className="h-3 w-3" />
                  سريع وآمن
                </span>
              </div>
            </div>

            <div className="bg-card border border-border rounded-2xl shadow-xl p-6 sm:p-8 space-y-6">
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
                : (brandingResolved ? brandize(t("auth.loginSubtitle")) : "\u00A0"))}
              {step === "otp" && t("auth.sa.otpSubtitle", "أدخل الرمز المُرسل إلى بريدك المسجل.")}
              {step === "device-approval" && t("auth.sa.deviceSubtitle", "أرسلنا رابط الموافقة إلى بريدك. اعتمد الجهاز من جهاز موثوق ثم عد إلى هنا.")}
              {step === "recovery-code" && t("auth.sa.recoverySubtitle", "أدخل أحد رموز الاسترجاع المخزنة لديك.")}
              {step === "blocked" && t("auth.sa.blockedSubtitle", "تواصل مع المسؤول.")}
            </p>
          </div>

          {/* ── STEP: creds ─────────────────────────────────────────── */}
          {(step === "creds" || step === "blocked") && (
            <form onSubmit={submitCreds} className="space-y-4">
              {/* Login-mode switch: شركة vs تدريب. Trainees authenticate by
                  email + password only (no company code). Hidden in SA flow. */}
              {!isSuperAdminFlow && (
                <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" data-testid="login-mode-switch">
                  <button
                    type="button"
                    onClick={() => setLoginMode("company")}
                    className={`rounded-md py-1.5 text-sm font-semibold transition ${loginMode === "company" ? "bg-card shadow text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    data-testid="login-mode-company"
                  >
                    حساب شركة
                  </button>
                  <button
                    type="button"
                    onClick={() => setLoginMode("trainee")}
                    className={`rounded-md py-1.5 text-sm font-semibold transition ${loginMode === "trainee" ? "bg-card shadow text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    data-testid="login-mode-trainee"
                  >
                    تدريب
                  </button>
                </div>
              )}

              {/* Company code identifies the tenant. Only shown for the
                  regular tenant flow — SuperAdmin pivots to its own UI
                  and doesn't need a company code; trainees don't have one. */}
              {!isSuperAdminFlow && loginMode === "company" && (
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">
                    كود الشركة <span className="text-destructive">*</span>
                  </label>
                  <Input
                    value={companyCode}
                    onChange={e => setCompanyCode(e.target.value.toUpperCase())}
                    placeholder="ZTC-1042"
                    dir="ltr"
                    className="text-left font-mono tracking-wider uppercase"
                    autoComplete="off"
                    disabled={step === "blocked"}
                    data-testid="login-company-code"
                  />
                </div>
              )}

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">
                  {!isSuperAdminFlow && loginMode === "trainee" ? "البريد الإلكتروني" : t("auth.username")}
                </label>
                <Input
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  placeholder={!isSuperAdminFlow && loginMode === "trainee" ? "you@example.com" : "admin"}
                  dir="ltr"
                  className="text-left"
                  autoComplete="username"
                  required
                  disabled={step === "blocked"}
                />
                {!isSuperAdminFlow && loginMode === "trainee" && (
                  <p className="text-xs text-muted-foreground">
                    سجّل دخولك ببريدك الإلكتروني وكلمة المرور — لا حاجة لكود شركة.
                  </p>
                )}
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
          {step === "creds" && !isSuperAdminFlow && !isAgentDomain && (
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

              {/* Mobile app download badges — stacked, shown only when the
                  SuperAdmin configured links (hidden on agent domains). */}
              {step === "creds" && brandingResolved && !isAgentDomain && (androidApp || iosApp) && (
                <div className="mt-6 flex flex-col items-center gap-2" data-testid="login-app-downloads">
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Smartphone className="h-3.5 w-3.5" />
                    حمّل تطبيق الجوال وأصدر فواتيرك من أي مكان
                  </p>
                  <div className="flex flex-col gap-2 w-full max-w-[240px]">
                    {androidApp && (
                      <a
                        href={androidApp.downloadUrl}
                        target="_blank" rel="noreferrer"
                        data-testid="login-download-android"
                        className="flex items-center gap-3 rounded-xl bg-gray-900 text-white px-4 py-2.5 hover:bg-gray-800 transition-colors shadow-md"
                      >
                        <svg viewBox="0 0 24 24" className="h-6 w-6 shrink-0" fill="currentColor" aria-hidden>
                          <path d="M3.6 1.8 13.7 12 3.6 22.2c-.3-.3-.5-.8-.5-1.3V3.1c0-.5.2-1 .5-1.3Zm11.5 8.8 2.6-2.6-11-6.3c-.4-.2-.8-.3-1.2-.2l9.6 9.1Zm3.9 1.4 2.3 1.3c.9.5.9 1.8 0 2.3l-2.3 1.3-2.9-2.4 2.9-2.5Zm-3.9 3.5-9.6 9.1c.4.1.8 0 1.2-.2l11-6.3-2.6-2.6Z"/>
                        </svg>
                        <span className="text-start leading-tight">
                          <span className="block text-[10px] opacity-80">متوفر لأجهزة</span>
                          <span className="block text-sm font-semibold">Android</span>
                        </span>
                      </a>
                    )}
                    {iosApp && (
                      <a
                        href={iosApp.downloadUrl}
                        target="_blank" rel="noreferrer"
                        data-testid="login-download-ios"
                        className="flex items-center gap-3 rounded-xl bg-gray-900 text-white px-4 py-2.5 hover:bg-gray-800 transition-colors shadow-md"
                      >
                        <svg viewBox="0 0 24 24" className="h-6 w-6 shrink-0" fill="currentColor" aria-hidden>
                          <path d="M16.4 12.9c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.8-3.5.8-.7 0-1.9-.8-3.1-.8-1.6 0-3.1.9-3.9 2.4-1.7 2.9-.4 7.2 1.2 9.5.8 1.2 1.7 2.5 3 2.4 1.2 0 1.7-.8 3.1-.8 1.4 0 1.9.8 3.1.8 1.3 0 2.1-1.2 2.9-2.3.9-1.3 1.3-2.6 1.3-2.7-.1 0-2.6-1-2.7-4Zm-2.5-7.2c.6-.8 1.1-1.9 1-3-.9 0-2.1.6-2.8 1.4-.6.7-1.2 1.9-1 3 1.1.1 2.1-.6 2.8-1.4Z"/>
                        </svg>
                        <span className="text-start leading-tight">
                          <span className="block text-[10px] opacity-80">متوفر لأجهزة</span>
                          <span className="block text-sm font-semibold">iPhone — iOS</span>
                        </span>
                      </a>
                    )}
                  </div>
                </div>
              )}

              <p className="text-center text-xs text-muted-foreground mt-6">
                {brandingResolved ? <>© 2026 {brandize(t("auth.appName"))} — {t("auth.rights")}</> : "\u00A0"}
              </p>
            </main>
          </div>
        </div>
      </div>
  );
}
