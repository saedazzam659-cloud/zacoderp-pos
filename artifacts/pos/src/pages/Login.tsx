import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  Eye,
  EyeOff,
  Lock,
  User as UserIcon,
  Store,
  ShieldCheck,
  Wifi,
  WifiOff,
  Fingerprint,
  ArrowLeft,
  Sparkles,
  Zap,
  CreditCard,
  Receipt,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  api,
  setToken,
  setStoredUser,
  setPosSessionId,
  getToken,
  getStoredUser,
  type Branch,
  type PosTerminal,
} from "@/lib/api";
import { Cpu, MonitorSmartphone, Loader2, Building2 } from "lucide-react";

// Stable per-browser device fingerprint used to pair this device with a POS
// terminal (machineCode). Stored once in localStorage; never changes unless
// localStorage is cleared.
const POS_DEVICE_KEY = "pos_device_id";
function getDeviceId(): string {
  try {
    let v = localStorage.getItem(POS_DEVICE_KEY);
    if (!v) {
      v = "DEV-" + Math.random().toString(36).slice(2, 10).toUpperCase()
            + "-" + Date.now().toString(36).toUpperCase();
      localStorage.setItem(POS_DEVICE_KEY, v);
    }
    return v;
  } catch { return "DEV-UNKNOWN"; }
}

const features = [
  {
    icon: Zap,
    titleAr: "بيع فائق السرعة",
    descAr: "إصدار الفاتورة في أقل من 3 ثوانٍ",
  },
  {
    icon: Receipt,
    titleAr: "فواتير زاتكا متوافقة",
    descAr: "QR وتوقيع رقمي تلقائي",
  },
  {
    icon: WifiOff,
    titleAr: "يعمل دون اتصال",
    descAr: "مزامنة تلقائية عند عودة الإنترنت",
  },
  {
    icon: CreditCard,
    titleAr: "كل وسائل الدفع",
    descAr: "نقدًا، شبكة، Apple Pay، ومحافظ",
  },
];

const COMPANY_CODE_KEY = "pos_company_code";

export default function LoginPage() {
  const [companyCode, setCompanyCode] = useState(
    () => (typeof localStorage !== "undefined" ? (localStorage.getItem(COMPANY_CODE_KEY) ?? "") : "")
  );
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState<number | null>(null);
  const [terminals, setTerminals] = useState<PosTerminal[]>([]);
  const [terminalId, setTerminalId] = useState<number | null>(null);
  const [terminalsLoading, setTerminalsLoading] = useState(false);
  // Stage of the wizard: "auth" = enter credentials, "select" = pick branch + terminal.
  const [stage, setStage] = useState<"auth" | "select">("auth");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  const [pinMode, setPinMode] = useState(false);
  const [pin, setPin] = useState("");
  const [time, setTime] = useState(new Date());
  const [, navigate] = useLocation();

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      clearInterval(t);
    };
  }, []);

  // If already logged in, jump straight to cashier.
  useEffect(() => {
    if (getToken()) navigate("/pos");
  }, [navigate]);

  async function loadBranchesFor(companyId: number) {
    try {
      const list = await api.getBranches(companyId, { onlyUserBranches: true });
      setBranches(list);
      // Auto-select main branch if available, else the first one. Don't
      // overwrite an explicit user pick.
      if (list.length && branchId == null) {
        const main = list.find((b: any) => (b as any).isMain) ?? list[0];
        setBranchId(main.id);
        localStorage.setItem("pos_branch_id", String(main.id));
      }
    } catch {
      // Branches are optional; silently ignore.
    }
  }

  // Reload terminals whenever the user switches branch (only in the select
  // stage — i.e. after authentication so the API call is authorized).
  useEffect(() => {
    if (stage !== "select" || !branchId) {
      setTerminals([]);
      setTerminalId(null);
      return;
    }
    let cancelled = false;
    setTerminalsLoading(true);
    api.getPosTerminals({ branchId, activeOnly: true })
      .then((list) => {
        if (cancelled) return;
        setTerminals(list);
        // Auto-select rules: prefer a terminal already paired to this device,
        // else the first non-busy one.
        const myDevice = getDeviceId();
        const mine = list.find(t => t.machineCode === myDevice && !t.busyUserId);
        const free = list.find(t => !t.busyUserId);
        const pick = mine ?? free ?? null;
        setTerminalId(pick ? pick.id : null);
      })
      .catch(() => { if (!cancelled) setTerminals([]); })
      .finally(() => { if (!cancelled) setTerminalsLoading(false); });
    return () => { cancelled = true; };
  }, [branchId, stage]);

  async function startSessionAndGo() {
    if (!branchId) { setError("اختر فرعًا أولاً"); return; }
    if (terminals.length > 0 && !terminalId) { setError("اختر محطة بيع"); return; }
    setLoading(true); setError(null);
    try {
      const existing = await api.getCurrentPosSession();
      if (existing) {
        setPosSessionId(existing.id);
        navigate("/pos");
        return;
      }
      const cashBoxId = (() => {
        const v = localStorage.getItem("pos_cash_box_id");
        return v ? Number(v) : null;
      })();
      const session = await api.openPosSession({
        branchId,
        cashBoxId,
        openingCash: 0,
        device: navigator.userAgent.slice(0, 120),
        posTerminalId: terminalId ?? null,
        machineCode: terminalId ? getDeviceId() : null,
      });
      setPosSessionId(session.id);
      localStorage.setItem("pos_branch_id", String(branchId));
      if (terminalId) localStorage.setItem("pos_terminal_id", String(terminalId));
      navigate("/pos");
    } catch (err: any) {
      setError(err?.message || "تعذّر فتح الجلسة");
    } finally {
      setLoading(false);
    }
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    // In the select stage, Enter inside the form (e.g. on a focused button)
    // should kick off the session, not re-submit the credentials form.
    if (stage === "select") {
      void startSessionAndGo();
      return;
    }
    if (pinMode) {
      setError("الدخول برمز PIN غير مفعّل بعد، فضلًا استخدم اسم المستخدم.");
      return;
    }
    if (!username || !password) {
      setError("الرجاء إدخال اسم المستخدم وكلمة المرور");
      return;
    }
    setLoading(true);
    try {
      const code = companyCode.trim().toUpperCase();
      if (code) {
        try { localStorage.setItem(COMPANY_CODE_KEY, code); } catch {}
      }
      const res = await api.login(username.trim(), password, code || undefined);
      setToken(res.token);
      setStoredUser(res.user);
      if (res.user.companyId) {
        localStorage.setItem("pos_company_id", String(res.user.companyId));
        await loadBranchesFor(res.user.companyId);
      }
      // If the cashier already has an open session (e.g. they refreshed the
      // tab) jump straight into POS — don't make them re-pick.
      try {
        const existing = await api.getCurrentPosSession();
        if (existing) {
          setPosSessionId(existing.id);
          navigate("/pos");
          return;
        }
      } catch {/* ignore */}
      // Otherwise advance to the branch + terminal selection step.
      setStage("select");
    } catch (err: any) {
      setError(err?.message || "فشل تسجيل الدخول");
    } finally {
      setLoading(false);
    }
  };

  const pressKey = (k: string) => {
    if (k === "del") {
      setPin((p) => p.slice(0, -1));
    } else if (k === "clear") {
      setPin("");
    } else if (pin.length < 4) {
      setPin((p) => p + k);
    }
  };

  const dateStr = new Intl.DateTimeFormat("ar-SA", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(time);

  const timeStr = new Intl.DateTimeFormat("ar-SA", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(time);

  return (
    <div
      dir="rtl"
      className="min-h-screen w-full bg-background text-foreground relative overflow-hidden"
    >
      {/* Animated background blobs */}
      <div className="absolute inset-0 pos-grid-bg opacity-60" aria-hidden />
      <div
        className="absolute -top-40 -right-40 w-[40rem] h-[40rem] rounded-full bg-primary/20 blur-3xl animate-blob"
        aria-hidden
      />
      <div
        className="absolute -bottom-40 -left-40 w-[36rem] h-[36rem] rounded-full bg-chart-2/20 blur-3xl animate-blob"
        style={{ animationDelay: "5s" }}
        aria-hidden
      />
      <div
        className="absolute top-1/3 left-1/4 w-[28rem] h-[28rem] rounded-full bg-chart-3/15 blur-3xl animate-blob"
        style={{ animationDelay: "10s" }}
        aria-hidden
      />

      {/* Top bar */}
      <header className="relative z-10 flex items-center justify-between px-6 lg:px-10 py-5">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-primary to-chart-2 grid place-items-center shadow-lg shadow-primary/30">
            <Store className="w-6 h-6 text-primary-foreground" strokeWidth={2.4} />
          </div>
          <div>
            <p className="text-base font-extrabold leading-tight tracking-tight">
              زاكود <span className="text-primary">POS</span>
            </p>
            <p className="text-[11px] text-muted-foreground leading-tight">
              نقاط البيع الذكية
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div
            className={`hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold border ${
              online
                ? "bg-primary/10 text-primary border-primary/20"
                : "bg-destructive/10 text-destructive border-destructive/20"
            }`}
          >
            {online ? (
              <Wifi className="w-3.5 h-3.5" />
            ) : (
              <WifiOff className="w-3.5 h-3.5" />
            )}
            {online ? "متصل" : "وضع عدم الاتصال"}
          </div>
          <button
            type="button"
            className="px-3 py-1.5 rounded-full text-xs font-semibold border border-border bg-card hover-elevate active-elevate-2"
          >
            EN
          </button>
        </div>
      </header>

      <main className="relative z-10 grid lg:grid-cols-[1.05fr_1fr] gap-10 px-6 lg:px-10 pb-10 max-w-[1400px] mx-auto">
        {/* LEFT — Brand panel */}
        <section className="hidden lg:flex flex-col justify-between rounded-3xl p-10 bg-gradient-to-br from-sidebar to-sidebar/90 text-sidebar-foreground relative overflow-hidden shadow-2xl">
          <div
            className="absolute inset-0 opacity-30 mix-blend-screen"
            style={{
              backgroundImage:
                "radial-gradient(circle at 20% 20%, hsl(var(--primary) / 0.5), transparent 50%), radial-gradient(circle at 80% 70%, hsl(var(--chart-2) / 0.4), transparent 55%)",
            }}
            aria-hidden
          />

          <div className="relative">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/10 backdrop-blur text-xs font-semibold border border-white/15">
              <Sparkles className="w-3.5 h-3.5 text-primary" />
              مدعوم بالذكاء الاصطناعي
            </div>

            <h1 className="mt-6 text-4xl xl:text-5xl font-black leading-[1.15] tracking-tight">
              نقطة بيع
              <br />
              <span className="bg-gradient-to-l from-primary via-chart-2 to-primary bg-clip-text text-transparent">
                أنيقة وذكية
              </span>
              <br />
              لمتجرك السعودي
            </h1>
            <p className="mt-5 text-base text-sidebar-foreground/70 max-w-md leading-relaxed">
              متوافقة 100% مع ضوابط هيئة الزكاة والضريبة والجمارك،
              مع تجربة سريعة على اللمس وتعمل دون اتصال.
            </p>
          </div>

          <div className="relative grid grid-cols-2 gap-3 mt-10">
            {features.map((f, i) => (
              <motion.div
                key={f.titleAr}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15 + i * 0.08, duration: 0.45 }}
                className="rounded-2xl p-4 bg-white/5 border border-white/10 backdrop-blur hover:bg-white/10 transition-colors"
              >
                <div className="w-10 h-10 rounded-xl bg-primary/20 grid place-items-center mb-2 ring-1 ring-primary/30">
                  <f.icon className="w-5 h-5 text-primary" />
                </div>
                <p className="font-bold text-sm">{f.titleAr}</p>
                <p className="text-xs text-sidebar-foreground/60 mt-0.5 leading-relaxed">
                  {f.descAr}
                </p>
              </motion.div>
            ))}
          </div>

          <div className="relative mt-8 pt-6 border-t border-white/10 flex items-center justify-between text-xs text-sidebar-foreground/60">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-primary" />
              <span>اعتماد ZATCA Phase 2</span>
            </div>
            <div className="flex items-center gap-2 font-mono">
              <span>{timeStr}</span>
              <span className="opacity-50">•</span>
              <span>{dateStr}</span>
            </div>
          </div>
        </section>

        {/* RIGHT — Auth card */}
        <section className="flex items-center justify-center">
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
            className="w-full max-w-md"
          >
            <div className="pos-glass rounded-3xl border border-card-border shadow-2xl p-7 sm:p-9 relative overflow-hidden">
              <div
                className="absolute -top-24 -right-24 w-52 h-52 rounded-full bg-primary/10 blur-2xl"
                aria-hidden
              />

              <div className="relative">
                <div className="flex items-center justify-between mb-1">
                  <h2 className="text-2xl font-extrabold tracking-tight">
                    أهلاً بك
                  </h2>
                  <div className="flex items-center gap-1 p-1 rounded-full bg-muted text-xs font-bold">
                    <button
                      type="button"
                      onClick={() => setPinMode(false)}
                      className={`px-3 py-1.5 rounded-full transition-all ${
                        !pinMode
                          ? "bg-card text-foreground shadow"
                          : "text-muted-foreground"
                      }`}
                    >
                      كلمة المرور
                    </button>
                    <button
                      type="button"
                      onClick={() => setPinMode(true)}
                      className={`px-3 py-1.5 rounded-full transition-all ${
                        pinMode
                          ? "bg-card text-foreground shadow"
                          : "text-muted-foreground"
                      }`}
                    >
                      رمز PIN
                    </button>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground mb-6">
                  سجّل دخولك لبدء وردية البيع
                </p>

                <form onSubmit={handleLogin} className="space-y-4">
                  {stage === "select" ? (
                    <SelectStage
                      branches={branches}
                      branchId={branchId}
                      setBranchId={setBranchId}
                      terminals={terminals}
                      setTerminals={setTerminals}
                      terminalId={terminalId}
                      setTerminalId={setTerminalId}
                      terminalsLoading={terminalsLoading}
                      deviceId={getDeviceId()}
                      onBack={() => { setStage("auth"); setError(null); }}
                      onContinue={startSessionAndGo}
                      loading={loading}
                      error={error}
                    />
                  ) : (
                  <AnimatePresence mode="wait">
                    {!pinMode ? (
                      <motion.div
                        key="pwd"
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -20 }}
                        transition={{ duration: 0.25 }}
                        className="space-y-3"
                      >
                        <div className="space-y-1.5">
                          <Label className="text-xs font-semibold text-muted-foreground">
                            كود الشركة
                          </Label>
                          <div className="relative">
                            <Building2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <Input
                              type="text"
                              dir="ltr"
                              value={companyCode}
                              onChange={(e) => setCompanyCode(e.target.value.toUpperCase())}
                              placeholder="ZTC-6"
                              className="h-12 pr-10 text-base font-medium uppercase tracking-wide"
                              autoComplete="organization"
                            />
                          </div>
                        </div>

                        <div className="space-y-1.5">
                          <Label className="text-xs font-semibold text-muted-foreground">
                            اسم المستخدم
                          </Label>
                          <div className="relative">
                            <UserIcon className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <Input
                              type="text"
                              dir="ltr"
                              value={username}
                              onChange={(e) => setUsername(e.target.value)}
                              placeholder="amirazzam"
                              className="h-12 pr-10 text-base font-medium"
                              autoComplete="username"
                            />
                          </div>
                        </div>

                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <Label className="text-xs font-semibold text-muted-foreground">
                              كلمة المرور
                            </Label>
                            <button
                              type="button"
                              className="text-xs font-semibold text-primary hover:underline"
                            >
                              نسيت كلمة المرور؟
                            </button>
                          </div>
                          <div className="relative">
                            <Lock className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <Input
                              type={showPassword ? "text" : "password"}
                              dir="ltr"
                              value={password}
                              onChange={(e) => setPassword(e.target.value)}
                              placeholder="••••••••"
                              className="h-12 pr-10 pl-10 text-base font-medium"
                              autoComplete="current-password"
                            />
                            <button
                              type="button"
                              onClick={() => setShowPassword((s) => !s)}
                              aria-label="عرض/إخفاء كلمة المرور"
                              className="absolute left-3 top-1/2 -translate-y-1/2 p-1 rounded-md text-muted-foreground hover:text-foreground hover-elevate"
                            >
                              {showPassword ? (
                                <EyeOff className="w-4 h-4" />
                              ) : (
                                <Eye className="w-4 h-4" />
                              )}
                            </button>
                          </div>
                        </div>
                      </motion.div>
                    ) : (
                      <motion.div
                        key="pin"
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 20 }}
                        transition={{ duration: 0.25 }}
                      >
                        <Label className="text-xs font-semibold text-muted-foreground">
                          رمز الدخول السريع
                        </Label>
                        <div className="flex items-center justify-center gap-3 my-3">
                          {[0, 1, 2, 3].map((i) => (
                            <div
                              key={i}
                              className={`w-12 h-14 rounded-xl border-2 grid place-items-center text-2xl font-black transition-all ${
                                pin.length > i
                                  ? "border-primary bg-primary/10 text-primary scale-105"
                                  : "border-border bg-muted/40 text-muted-foreground"
                              }`}
                            >
                              {pin.length > i ? "•" : ""}
                            </div>
                          ))}
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(
                            (k) => (
                              <button
                                key={k}
                                type="button"
                                onClick={() => pressKey(k)}
                                className="h-12 rounded-xl bg-card border border-border font-bold text-lg hover-elevate active-elevate-2"
                              >
                                {k}
                              </button>
                            ),
                          )}
                          <button
                            type="button"
                            onClick={() => pressKey("clear")}
                            className="h-12 rounded-xl bg-muted border border-border text-xs font-bold text-muted-foreground hover-elevate active-elevate-2"
                          >
                            مسح
                          </button>
                          <button
                            type="button"
                            onClick={() => pressKey("0")}
                            className="h-12 rounded-xl bg-card border border-border font-bold text-lg hover-elevate active-elevate-2"
                          >
                            0
                          </button>
                          <button
                            type="button"
                            onClick={() => pressKey("del")}
                            aria-label="حذف"
                            className="h-12 rounded-xl bg-muted border border-border grid place-items-center text-muted-foreground hover-elevate active-elevate-2"
                          >
                            <ArrowLeft className="w-4 h-4" />
                          </button>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                  )}

                  {stage === "auth" && (<>
                  {/* Remember + Biometric */}
                  <div className="flex items-center justify-between pt-1">
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <Switch
                        checked={remember}
                        onCheckedChange={setRemember}
                      />
                      <span className="text-xs font-semibold text-muted-foreground">
                        تذكر هذا الجهاز
                      </span>
                    </label>
                    <button
                      type="button"
                      title="تسجيل بالبصمة"
                      className="w-10 h-10 rounded-xl border border-border bg-card grid place-items-center text-muted-foreground hover:text-primary hover-elevate active-elevate-2"
                    >
                      <Fingerprint className="w-5 h-5" />
                    </button>
                  </div>

                  {/* Error */}
                  <AnimatePresence>
                    {error && (
                      <motion.div
                        initial={{ opacity: 0, y: -6, height: 0 }}
                        animate={{ opacity: 1, y: 0, height: "auto" }}
                        exit={{ opacity: 0, y: -6, height: 0 }}
                        className="text-sm font-semibold text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2"
                      >
                        {error}
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* Submit */}
                  <Button
                    type="submit"
                    disabled={loading}
                    className="relative w-full h-13 py-3.5 text-base font-extrabold rounded-xl bg-gradient-to-l from-primary via-primary to-chart-2 hover:opacity-95 text-primary-foreground pos-glow overflow-hidden animate-shine"
                  >
                    {loading ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="w-4 h-4 border-2 border-primary-foreground/40 border-t-primary-foreground rounded-full animate-spin" />
                        جاري التحقق...
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-2">
                        تسجيل الدخول
                        <ArrowLeft className="w-4 h-4" />
                      </span>
                    )}
                  </Button>
                  </>)}
                </form>

                <div className="mt-6 pt-5 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    لا تملك حساب؟{" "}
                    <a
                      href="https://zacoderp.com"
                      className="text-primary font-semibold hover:underline"
                    >
                      تواصل مع المدير
                    </a>
                  </span>
                  <span className="font-mono">v1.0.0</span>
                </div>
              </div>
            </div>

            {/* Footer mobile online indicator */}
            <div className="lg:hidden mt-6 text-center text-xs text-muted-foreground">
              {timeStr} • {dateStr}
            </div>
          </motion.div>
        </section>
      </main>
    </div>
  );
}

// ─── Branch + Terminal selection stage ────────────────────────────────────
function SelectStage({
  branches, branchId, setBranchId,
  terminals, setTerminals, terminalId, setTerminalId,
  terminalsLoading, deviceId,
  onBack, onContinue, loading, error,
}: {
  branches: Branch[];
  branchId: number | null;
  setBranchId: (id: number) => void;
  terminals: PosTerminal[];
  setTerminals: (t: PosTerminal[]) => void;
  terminalId: number | null;
  setTerminalId: (id: number) => void;
  terminalsLoading: boolean;
  deviceId: string;
  onBack: () => void;
  onContinue: () => void;
  loading: boolean;
  error: string | null;
}) {
  const [unpairing, setUnpairing] = useState<number | null>(null);
  const [unpairErr, setUnpairErr] = useState<string | null>(null);
  const me = getStoredUser();
  const isAdmin = me?.role === "admin" || me?.role === "superadmin";

  const handleUnpair = async (id: number) => {
    if (unpairing) return;
    if (!confirm("سيتم فك ربط هذه المحطة من الجهاز السابق. متابعة؟")) return;
    setUnpairing(id); setUnpairErr(null);
    try {
      const updated = await api.unpairPosTerminal(id);
      setTerminals(terminals.map((t) => (t.id === id ? { ...t, machineCode: updated.machineCode, busyUserId: updated.busyUserId } : t)));
    } catch (e: any) {
      setUnpairErr(e?.message || "تعذّر إلغاء الربط");
    } finally { setUnpairing(null); }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="space-y-4"
    >
      {/* Branch */}
      <div className="space-y-1.5">
        <Label className="text-xs font-semibold text-muted-foreground">الفرع</Label>
        {branches.length === 0 ? (
          <div className="text-xs text-muted-foreground rounded-xl border border-dashed p-3">
            لا توجد فروع لهذا الحساب. اطلب من المسؤول إضافة فرع.
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {branches.slice(0, 6).map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => setBranchId(b.id)}
                data-testid={`btn-branch-${b.id}`}
                className={`text-right rounded-xl border p-2.5 transition-all hover-elevate active-elevate-2 ${
                  branchId === b.id
                    ? "border-primary bg-primary/5 ring-2 ring-primary/30"
                    : "border-border bg-card"
                }`}
              >
                <p className="text-[11px] text-muted-foreground leading-none">
                  {(b as any).city || b.code}
                </p>
                <p className="text-xs font-bold mt-1 leading-tight">{b.nameAr}</p>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Terminals */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-semibold text-muted-foreground inline-flex items-center gap-1.5">
            <MonitorSmartphone className="w-3.5 h-3.5" /> محطة البيع (المكينة)
          </Label>
          <span className="text-[10px] font-mono text-muted-foreground" title="معرّف هذا الجهاز">
            <Cpu className="w-3 h-3 inline -mt-0.5 me-0.5" />
            {deviceId.length > 18 ? deviceId.slice(0, 8) + "…" + deviceId.slice(-6) : deviceId}
          </span>
        </div>
        {terminalsLoading ? (
          <div className="rounded-xl border bg-card p-4 text-xs text-muted-foreground inline-flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> جاري تحميل المحطات...
          </div>
        ) : terminals.length === 0 ? (
          <div className="rounded-xl border border-dashed p-3 text-xs text-muted-foreground">
            لا توجد محطات بيع لهذا الفرع. سيتم فتح الجلسة بدون محطة. يمكن للمسؤول إضافة محطات من إعدادات نقاط البيع.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 max-h-[220px] overflow-y-auto">
            {terminals.map((t) => {
              const isMine    = !!t.machineCode && t.machineCode === deviceId;
              const isOther   = !!t.machineCode && t.machineCode !== deviceId;
              const isBusy    = !!t.busyUserId;
              const selected  = terminalId === t.id;
              const disabled  = isBusy || isOther;
              return (
                <div key={t.id} className="relative">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setTerminalId(t.id)}
                    data-testid={`btn-terminal-${t.id}`}
                    className={`w-full text-right rounded-xl border p-2.5 transition-all ${
                      selected
                        ? "border-primary bg-primary/5 ring-2 ring-primary/30"
                        : disabled
                          ? "border-border bg-muted/40 opacity-60 cursor-not-allowed"
                          : "border-border bg-card hover-elevate active-elevate-2"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] font-mono text-muted-foreground">{t.code}</p>
                      {isMine && <span className="text-[9px] font-bold text-emerald-600">جهازك</span>}
                      {isBusy && <span className="text-[9px] font-bold text-amber-600">قيد الاستخدام</span>}
                      {isOther && !isBusy && <span className="text-[9px] font-bold text-destructive">جهاز آخر</span>}
                      {!t.machineCode && <span className="text-[9px] font-bold text-blue-600">جديدة</span>}
                    </div>
                    <p className="text-xs font-bold mt-1 leading-tight truncate">{t.nameAr}</p>
                  </button>
                  {isOther && !isBusy && isAdmin && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); void handleUnpair(t.id); }}
                      disabled={unpairing === t.id}
                      className="absolute bottom-1 left-1 text-[9px] font-bold px-1.5 py-0.5 rounded bg-destructive/10 text-destructive hover:bg-destructive/20 disabled:opacity-50"
                      title="فك ربط المحطة من الجهاز السابق"
                    >
                      {unpairing === t.id ? "..." : "إلغاء الربط"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {unpairErr && (
        <div className="text-xs font-semibold text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-1.5">
          {unpairErr}
        </div>
      )}
      {!isAdmin && terminals.some((t) => !!t.machineCode && t.machineCode !== deviceId) && (
        <div className="text-[11px] text-muted-foreground bg-muted/30 border border-border rounded-lg px-3 py-1.5">
          ملاحظة: فك ربط المحطات من جهاز آخر يتطلب حساب مدير.
        </div>
      )}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -6, height: 0 }}
            animate={{ opacity: 1, y: 0, height: "auto" }}
            exit={{ opacity: 0, y: -6, height: 0 }}
            className="text-sm font-semibold text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2"
          >
            {error}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" className="h-12" onClick={onBack} disabled={loading}>
          رجوع
        </Button>
        <Button
          type="button"
          onClick={onContinue}
          disabled={loading || !branchId || (terminals.length > 0 && !terminalId)}
          data-testid="btn-start-session"
          className="flex-1 h-12 text-base font-extrabold rounded-xl bg-gradient-to-l from-primary via-primary to-chart-2 hover:opacity-95 text-primary-foreground"
        >
          {loading ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> جاري الفتح...
            </span>
          ) : (
            "بدء وردية البيع"
          )}
        </Button>
      </div>
    </motion.div>
  );
}
