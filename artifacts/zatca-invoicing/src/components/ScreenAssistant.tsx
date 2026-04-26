import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import {
  useActiveScreenContext,
  useScreenActionsRef,
  useCommandExecutor,
  type AICommand,
  type ExecutedStep,
  type ScreenActionsRegistration,
} from "@/contexts/ScreenActionsContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sparkles,
  Lightbulb,
  ArrowRight,
  AlertTriangle,
  Send,
  RefreshCw,
  X,
  Mic,
  MicOff,
  CheckCircle2,
  XCircle,
  Wand2,
} from "lucide-react";

const API = import.meta.env.VITE_API_URL || "";

type AssistResponse = {
  explanation: string;
  suggestion: string;
  next_step: string;
  warning_if_any: string;
  source: "ai" | "fallback";
};

type CommandResponse = {
  message: string;
  commands: AICommand[];
  source: "ai" | "fallback";
};

type ChatTurn =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; steps?: ExecutedStep[]; source?: "ai" | "fallback" };

/**
 * Map a wouter pathname to a stable screen-context identifier sent to the
 * backend `/api/ai/assist` endpoint. The backend has a deterministic fallback
 * for many of these IDs (see ai.ts) and otherwise falls through to a generic
 * "this screen" prompt — so returning a never-seen-before key is safe.
 *
 * IMPORTANT: Order matters — the FIRST matching entry wins, so put more
 * specific paths (e.g. "/sales/invoices/new") above their parents
 * ("/sales/invoices"). Patterns must match the routes actually declared in
 * App.tsx (e.g. /zatca-bridge with a dash, /cash/receipt-vouchers, etc.) —
 * otherwise the panel falls back to the generic "this screen" prompt.
 */
function pathToScreenContext(path: string): string {
  const matchers: Array<[RegExp, string]> = [
    // ── Dashboard / home ────────────────────────────────────────────────
    [/^\/$/, "dashboard.home"],
    [/^\/notifications$/, "common.notifications"],

    // ── Super-admin ─────────────────────────────────────────────────────
    [/^\/admin\/requests/, "admin.registrationRequests"],
    [/^\/admin\/subscriptions/, "admin.subscriptions"],
    [/^\/admin\/plans/, "admin.plans"],
    [/^\/admin\/menu-permissions/, "admin.menuPermissions"],
    [/^\/admin\/modules/, "admin.modules"],
    [/^\/admin\/licenses/, "admin.licenses"],
    [/^\/admin\/security-superadmin/, "admin.security"],
    [/^\/admin\/security/, "admin.security"],
    [/^\/admin\/reports/, "admin.reports"],
    [/^\/admin\/backups/, "admin.backups"],
    [/^\/admin\/orphan-stock/, "admin.orphanStock"],
    [/^\/admin\/ai-fix/, "admin.aiCompanyFix"],
    [/^\/admin\/support-settings/, "admin.support"],
    [/^\/admin\/support/, "admin.support"],
    [/^\/admin\/audit-log/, "admin.auditLog"],
    [/^\/companies\/new/, "admin.companyNew"],
    [/^\/companies\/\d+/, "admin.companyDetails"],
    [/^\/companies/, "admin.companies"],

    // ── Sales ───────────────────────────────────────────────────────────
    // /sales/* paths first, then the legacy top-level /invoices and /customers
    [/^\/sales\/quotations\/new/, "sales.quotations.new"],
    [/^\/sales\/quotations\/[^/]+/, "sales.quotations.detail"],
    [/^\/sales\/quotations/, "sales.quotations"],
    [/^\/sales\/invoices\/new/, "sales.invoices.new"],
    [/^\/sales\/invoices\/[^/]+/, "sales.invoices.detail"],
    [/^\/sales\/invoices/, "sales.invoices.list"],
    [/^\/sales\/orders\/new/, "sales.orders.new"],
    [/^\/sales\/orders\/[^/]+/, "sales.orders.detail"],
    [/^\/sales\/orders/, "sales.orders"],
    [/^\/sales\/returns/, "sales.returns"],
    [/^\/sales\/settlements/, "sales.settlements"],
    [/^\/sales\/reps/, "sales.reps"],
    [/^\/sales\/reports/, "sales.reports"],
    [/^\/sales\b/, "sales.module"],
    // Legacy routes kept for backwards-compatibility with the original
    // single-flat layout — they still exist in App.tsx.
    [/^\/invoices\/new/, "sales.invoices.new"],
    [/^\/invoices\/[^/]+/, "sales.invoices.detail"],
    [/^\/invoices/, "sales.invoices.list"],
    [/^\/customers\/new/, "sales.customers.new"],
    [/^\/customers\/[^/]+/, "sales.customers.detail"],
    [/^\/customers/, "sales.customers.list"],

    // ── Purchasing ──────────────────────────────────────────────────────
    [/^\/purchasing\/invoices\/new/, "purchasing.invoices.new"],
    [/^\/purchasing\/invoices\/[^/]+/, "purchasing.invoices.detail"],
    [/^\/purchasing\/invoices/, "purchasing.invoices.list"],
    [/^\/purchasing\/orders\/new/, "purchasing.orders.new"],
    [/^\/purchasing\/orders\/[^/]+/, "purchasing.orders.detail"],
    [/^\/purchasing\/orders/, "purchasing.orders"],
    [/^\/purchasing\/returns/, "purchasing.returns"],
    [/^\/purchasing\/settlements/, "purchasing.settlements"],
    [/^\/purchasing\/lc/, "purchasing.lc"],
    [/^\/purchasing\/supplier-groups/, "purchasing.supplierGroups"],
    [/^\/purchasing\/reports/, "purchasing.reports"],
    [/^\/purchasing\b/, "purchasing.module"],
    [/^\/suppliers\/new/, "purchasing.suppliers.new"],
    [/^\/suppliers\/[^/]+/, "purchasing.suppliers.detail"],
    [/^\/suppliers/, "purchasing.suppliers.list"],

    // ── Cash & banks ────────────────────────────────────────────────────
    [/^\/cash\/boxes/, "cash.boxes"],
    [/^\/cash\/banks/, "cash.banks"],
    [/^\/cash\/receipt-vouchers/, "cash.receiptVouchers"],
    [/^\/cash\/payment-vouchers/, "cash.paymentVouchers"],
    [/^\/cash\/transfers/, "cash.transfers"],
    [/^\/cash\/reports/, "cash.reports"],
    [/^\/cash\b/, "cash.module"],

    // ── Inventory ───────────────────────────────────────────────────────
    [/^\/inventory\/items\/new/, "inventory.items.new"],
    [/^\/inventory\/items\/[^/]+/, "inventory.items.detail"],
    [/^\/inventory\/items/, "inventory.items.list"],
    [/^\/inventory\/warehouse-groups/, "inventory.warehouseGroups"],
    [/^\/inventory\/warehouses/, "inventory.warehouses"],
    [/^\/inventory\/item-groups/, "inventory.itemGroups"],
    [/^\/inventory\/units/, "inventory.units"],
    [/^\/inventory\/offers\/new/, "inventory.offers.new"],
    [/^\/inventory\/offers\/[^/]+/, "inventory.offers.detail"],
    [/^\/inventory\/offers/, "inventory.offers"],
    [/^\/inventory\/transfers\/new/, "inventory.transfers.new"],
    [/^\/inventory\/transfers/, "inventory.transfers"],
    [/^\/inventory\/adjustments\/new/, "inventory.adjustments.new"],
    [/^\/inventory\/adjustments/, "inventory.adjustments"],
    [/^\/inventory\/counts\/new/, "inventory.counts.new"],
    [/^\/inventory\/counts/, "inventory.counts"],
    [/^\/inventory\/ledger/, "inventory.ledger"],
    [/^\/inventory\/balance/, "inventory.balance"],
    [/^\/inventory\/reports/, "inventory.reports"],
    [/^\/inventory\b/, "inventory.module"],

    // ── Accounting ──────────────────────────────────────────────────────
    [/^\/accounting\/accounts/, "accounting.chart"],
    [/^\/accounting\/cost-centers/, "accounting.costCenters"],
    [/^\/accounting\/fiscal-periods/, "accounting.fiscalPeriods"],
    [/^\/accounting\/journals\/new/, "accounting.journalEntries.new"],
    [/^\/accounting\/journals\/[^/]+/, "accounting.journalEntries.detail"],
    [/^\/accounting\/journals/, "accounting.journalEntries.list"],
    [/^\/accounting\/reports/, "accounting.reports"],
    [/^\/accounting\b/, "accounting.module"],

    // ── HR ──────────────────────────────────────────────────────────────
    [/^\/hr\/employees\/new/, "hr.employees.new"],
    [/^\/hr\/employees\/[^/]+\/contracts/, "hr.employees.contracts"],
    [/^\/hr\/employees\/[^/]+/, "hr.employees.detail"],
    [/^\/hr\/employees/, "hr.employees.list"],
    [/^\/hr\/contracts/, "hr.contracts"],
    [/^\/hr\/attendance/, "hr.attendance"],
    [/^\/hr\/loans/, "hr.loans"],
    [/^\/hr\/payroll/, "hr.payroll"],
    [/^\/hr\/end-of-service/, "hr.eos"],
    [/^\/hr\/calculators/, "hr.calculators"],
    [/^\/hr\/settings/, "hr.settings"],
    [/^\/hr\/reports/, "hr.reports"],
    [/^\/hr\b/, "hr.module"],

    // ── Production ──────────────────────────────────────────────────────
    [/^\/production\/orders\/new/, "production.orders.new"],
    [/^\/production\/orders\/[^/]+/, "production.orders.detail"],
    [/^\/production\/orders/, "production.orders.list"],
    [/^\/production\/resources/, "production.resources"],
    // /production (root) is the dashboard in this app.
    [/^\/production\b/, "production.dashboard"],

    // ── ZATCA / e-invoicing ────────────────────────────────────────────
    // Routes use a HYPHEN, not a slash: /zatca-bridge, /zatca-report.
    [/^\/zatca-bridge/, "zatca.bridge"],
    [/^\/zatca-report/, "zatca.report"],
    [/^\/zatca\b/, "zatca.module"],
    [/^\/vat-declaration/, "zatca.vatDeclaration"],

    // ── POS ────────────────────────────────────────────────────────────
    [/^\/pos-monitoring/, "pos.monitoring"],
    [/^\/pos-settings/, "pos.settings"],
    [/^\/pos-terminals/, "pos.terminals"],

    // ── Org ────────────────────────────────────────────────────────────
    [/^\/org\/regions/, "org.regions"],
    [/^\/org\/branches/, "org.branches"],
    [/^\/org\b/, "org.settings"],
    [/^\/users\b/, "org.users"],

    // ── Settings ────────────────────────────────────────────────────────
    [/^\/general-settings/, "settings.general"],
    [/^\/settings\/currencies/, "settings.currencies"],
    [/^\/settings\/accounting-mappings/, "settings.accountingMappings"],
    [/^\/settings\/data-io/, "settings.dataIo"],
    [/^\/settings\/sequences/, "settings.sequences"],
    [/^\/settings\b/, "settings.other"],
  ];

  for (const [re, key] of matchers) {
    if (re.test(path)) return key;
  }
  // Fallback: turn "/foo/bar/123" into "foo.bar" so the backend still gets a
  // meaningful screen identifier even for routes we haven't enumerated above.
  const cleaned = path
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter((seg) => seg && !/^\d+$/.test(seg))
    .slice(0, 3)
    .join(".");
  return cleaned || "dashboard.home";
}

export default function ScreenAssistant() {
  const { t, i18n } = useTranslation();
  const { token, user } = useAuth() as any;
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<AssistResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followup, setFollowup] = useState("");
  const [chatLog, setChatLog] = useState<ChatTurn[]>([]);
  const [recording, setRecording] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const lastFetchedKeyRef = useRef<string | null>(null);
  const recognitionRef = useRef<any>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  const screenContext = useMemo(() => pathToScreenContext(location), [location]);
  const isRtl = i18n.dir() === "rtl";
  const lang = i18n.language?.startsWith("en") ? "en" : "ar";

  const activeScreenContext = useActiveScreenContext();
  const registrationRef = useScreenActionsRef();
  const executor = useCommandExecutor();
  const hasActionableScreen = activeScreenContext === screenContext;

  // ───────────────────────────────────────────────────────────────────
  // Passive screen explanation (existing /api/ai/assist endpoint)
  // ───────────────────────────────────────────────────────────────────
  const fetchAssist = useCallback(
    async (userMessage = "") => {
      if (!token) return;
      setLoading(true);
      setError(null);
      try {
        const r = await fetch(`${API}/api/ai/assist`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            screen_context: screenContext,
            current_action: "",
            user_message: userMessage,
            order_id: null,
            lang,
          }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as AssistResponse;
        setData(j);
      } catch (e: any) {
        setError(e?.message || "error");
      } finally {
        setLoading(false);
      }
    },
    [screenContext, token, lang],
  );

  // ───────────────────────────────────────────────────────────────────
  // Active command playback (new /api/ai/command endpoint)
  // ───────────────────────────────────────────────────────────────────
  const sendCommand = useCallback(
    async (userMessage: string) => {
      if (!token) return;
      // Push the user turn immediately so the chat feels responsive.
      setChatLog((prev) => [...prev, { kind: "user", text: userMessage }]);
      setLoading(true);
      try {
        // Build a compact registration snapshot (omit the function callbacks
        // — only data the model can reason about).
        const payload: any = {
          screen_context: screenContext,
          user_message: userMessage,
          lang,
          screen_state: {},
          available_fields: [],
          available_actions: [],
          lookups: {},
        };
        const reg = registrationRef.current;
        if (reg && reg.screenContext === screenContext) {
          payload.screen_state = safeGetState(reg);
          payload.available_fields = reg.fields;
          payload.available_actions = reg.actions;
          payload.lookups = compactLookups(reg.lookups);
          payload.screen_description = reg.description;
        }

        const r = await fetch(`${API}/api/ai/command`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as CommandResponse;

        let steps: ExecutedStep[] | undefined;
        if (Array.isArray(j.commands) && j.commands.length > 0 && hasActionableScreen) {
          // Pass the screen context we registered AT REQUEST TIME so the
          // executor can detect mid-flight navigation and refuse to apply
          // commands to the wrong screen.
          steps = await executor(j.commands, screenContext);
        }

        setChatLog((prev) => [
          ...prev,
          {
            kind: "assistant",
            text: j.message || "",
            steps,
            source: j.source,
          },
        ]);
      } catch (e: any) {
        setChatLog((prev) => [
          ...prev,
          { kind: "assistant", text: t("assistant.errorOccurred") },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [token, screenContext, lang, registrationRef, hasActionableScreen, executor, t],
  );

  // When the panel is opened, lazily fetch the contextual explanation. Refetch
  // when the screen context changes (user navigates) but only while open, so
  // we don't burn AI credits on every page navigation.
  useEffect(() => {
    if (!open || !token) return;
    const key = `${screenContext}|${lang}`;
    if (lastFetchedKeyRef.current === key) return;
    lastFetchedKeyRef.current = key;
    void fetchAssist("");
    // Reset chat log when navigating to a fresh screen.
    setChatLog([]);
  }, [open, screenContext, token, lang, fetchAssist]);

  // Auto-scroll chat as new turns arrive.
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatLog, loading]);

  // Stop voice recognition when the panel closes or the component unmounts —
  // a recognition session that outlives a closed panel would silently keep
  // the mic hot.
  useEffect(() => {
    if (!open) {
      try {
        recognitionRef.current?.abort?.();
      } catch {
        /* noop */
      }
      setRecording(false);
    }
    return () => {
      try {
        recognitionRef.current?.abort?.();
      } catch {
        /* noop */
      }
    };
  }, [open]);

  const handleAsk = (e: React.FormEvent) => {
    e.preventDefault();
    const q = followup.trim();
    if (!q) return;
    setFollowup("");
    void sendCommand(q);
  };

  // ───────────────────────────────────────────────────────────────────
  // Voice input — Web Speech API (webkitSpeechRecognition)
  // Browser support: Chrome / Edge desktop & Android (full), Safari iOS
  // 14.5+ partial. We degrade gracefully when unavailable.
  // ───────────────────────────────────────────────────────────────────
  const startRecording = useCallback(() => {
    setMicError(null);
    const SR =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setMicError(t("assistant.micUnsupported"));
      return;
    }
    try {
      const rec = new SR();
      rec.lang = lang === "en" ? "en-US" : "ar-SA";
      rec.continuous = false;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      let finalText = "";
      rec.onresult = (ev: any) => {
        let interim = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const txt = ev.results[i][0].transcript;
          if (ev.results[i].isFinal) finalText += txt;
          else interim += txt;
        }
        setFollowup((finalText || interim).trim());
      };
      rec.onerror = (ev: any) => {
        setMicError(ev?.error ? `${t("assistant.micError")}: ${ev.error}` : t("assistant.micError"));
        setRecording(false);
      };
      rec.onend = () => {
        setRecording(false);
      };
      recognitionRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (e: any) {
      setMicError(e?.message || t("assistant.micError"));
      setRecording(false);
    }
  }, [lang, t]);

  const stopRecording = useCallback(() => {
    try {
      recognitionRef.current?.stop?.();
    } catch {
      /* noop */
    }
    setRecording(false);
  }, []);

  const toggleMic = () => {
    if (recording) stopRecording();
    else startRecording();
  };

  // Hide widget entirely when not authenticated. Public routes (login,
  // register, etc.) won't have a token so this also guards those pages.
  if (!token || !user) return null;

  const sideClass = isRtl ? "left-4" : "right-4";

  return (
    <>
      {/* Collapsed: floating action button */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={t("assistant.openButton")}
          data-testid="screen-assistant-open"
          className={`fixed bottom-4 ${sideClass} z-50 flex h-12 w-12 items-center justify-center rounded-full bg-violet-600 text-white shadow-lg ring-1 ring-violet-300 transition hover:scale-105 hover:bg-violet-700 focus:outline-none focus:ring-2 focus:ring-violet-400 dark:bg-violet-700 dark:hover:bg-violet-600`}
        >
          <Sparkles className="h-5 w-5" />
        </button>
      )}

      {/* Expanded: assistant panel */}
      {open && (
        <div
          dir={isRtl ? "rtl" : "ltr"}
          data-testid="screen-assistant-panel"
          className={`fixed bottom-4 ${sideClass} z-50 flex max-h-[80vh] w-[92vw] max-w-sm flex-col overflow-hidden rounded-xl border border-violet-200 bg-gradient-to-br from-violet-50 to-white shadow-2xl dark:border-violet-900/40 dark:from-violet-950/30 dark:to-slate-950`}
        >
          <div className="flex items-center justify-between gap-2 border-b border-violet-100 p-3 dark:border-violet-900/40">
            <div className="flex items-center gap-2">
              <div className="rounded-full bg-violet-100 p-2 dark:bg-violet-900/40">
                <Sparkles className="h-4 w-4 text-violet-600 dark:text-violet-300" />
              </div>
              <div>
                <div className="font-semibold text-slate-900 dark:text-slate-100">
                  {t("assistant.title")}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {hasActionableScreen
                    ? t("assistant.subtitleActionable")
                    : t("assistant.subtitle")}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => fetchAssist("")}
                disabled={loading}
                aria-label={t("assistant.retry")}
                data-testid="screen-assistant-retry"
              >
                <RefreshCw
                  className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
                />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setOpen(false)}
                aria-label={t("assistant.closeButton")}
                data-testid="screen-assistant-close"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div ref={chatScrollRef} className="flex-1 overflow-y-auto p-3 text-sm">
            {loading && !data && chatLog.length === 0 && (
              <div className="text-slate-500 dark:text-slate-400">
                {t("assistant.loading")}
              </div>
            )}

            {error && !data && chatLog.length === 0 && (
              <div className="text-red-600">{t("assistant.errorOccurred")}</div>
            )}

            {data && (
              <div className="space-y-3">
                <Section
                  icon={<Sparkles className="h-3.5 w-3.5" />}
                  label={t("assistant.explanation")}
                  text={data.explanation}
                  tone="violet"
                />
                {data.suggestion && (
                  <Section
                    icon={<Lightbulb className="h-3.5 w-3.5" />}
                    label={t("assistant.suggestion")}
                    text={data.suggestion}
                    tone="amber"
                  />
                )}
                {data.next_step && (
                  <Section
                    icon={<ArrowRight className="h-3.5 w-3.5" />}
                    label={t("assistant.nextStep")}
                    text={data.next_step}
                    tone="emerald"
                  />
                )}
                {data.warning_if_any && (
                  <Section
                    icon={<AlertTriangle className="h-3.5 w-3.5" />}
                    label={t("assistant.warning")}
                    text={data.warning_if_any}
                    tone="red"
                  />
                )}
                <div className="pt-1 text-[11px] text-slate-400">
                  {data.source === "ai"
                    ? t("assistant.source_ai")
                    : t("assistant.source_fallback")}
                </div>
              </div>
            )}

            {chatLog.length > 0 && (
              <div className="mt-3 space-y-2 border-t border-violet-100 pt-3 dark:border-violet-900/40">
                {chatLog.map((turn, i) =>
                  turn.kind === "user" ? (
                    <div key={i} className="flex justify-end">
                      <div className="max-w-[85%] rounded-lg rounded-br-sm bg-violet-600 px-3 py-2 text-white">
                        {turn.text}
                      </div>
                    </div>
                  ) : (
                    <div key={i} className="flex justify-start">
                      <div className="max-w-[90%] space-y-2 rounded-lg rounded-bl-sm bg-white px-3 py-2 text-slate-800 ring-1 ring-violet-100 dark:bg-slate-900 dark:text-slate-100 dark:ring-violet-900/40">
                        {turn.text && (
                          <div className="leading-relaxed">{turn.text}</div>
                        )}
                        {turn.steps && turn.steps.length > 0 && (
                          <div className="space-y-1 rounded border border-violet-100 bg-violet-50/50 p-2 dark:border-violet-900/40 dark:bg-violet-950/30">
                            <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-violet-700 dark:text-violet-300">
                              <Wand2 className="h-3 w-3" />
                              <span>{t("assistant.executedSteps")}</span>
                            </div>
                            {turn.steps.map((s, j) => (
                              <div
                                key={j}
                                className="flex items-start gap-1.5 text-xs"
                              >
                                {s.ok ? (
                                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-emerald-600" />
                                ) : (
                                  <XCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-red-600" />
                                )}
                                <span className={s.ok ? "" : "text-red-700 dark:text-red-300"}>
                                  {s.label}
                                  {s.error ? ` — ${s.error}` : ""}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ),
                )}
                {loading && (
                  <div className="flex justify-start">
                    <div className="rounded-lg bg-white px-3 py-2 text-slate-500 ring-1 ring-violet-100 dark:bg-slate-900 dark:ring-violet-900/40">
                      {t("assistant.loading")}
                    </div>
                  </div>
                )}
              </div>
            )}

            {micError && (
              <div className="mt-2 text-xs text-red-600">{micError}</div>
            )}
          </div>

          <form
            onSubmit={handleAsk}
            className="flex gap-2 border-t border-violet-100 p-3 dark:border-violet-900/40"
          >
            <Button
              type="button"
              size="icon"
              variant={recording ? "destructive" : "outline"}
              onClick={toggleMic}
              disabled={loading}
              data-testid="screen-assistant-mic"
              aria-label={
                recording ? t("assistant.micStop") : t("assistant.micStart")
              }
              title={recording ? t("assistant.micStop") : t("assistant.micStart")}
              className={recording ? "animate-pulse" : ""}
            >
              {recording ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </Button>
            <Input
              value={followup}
              onChange={(e) => setFollowup(e.target.value)}
              placeholder={
                hasActionableScreen
                  ? t("assistant.askActionable")
                  : t("assistant.ask")
              }
              disabled={loading}
              data-testid="screen-assistant-input"
              className="flex-1"
            />
            <Button
              type="submit"
              size="sm"
              disabled={loading || !followup.trim()}
              data-testid="screen-assistant-send"
            >
              <Send className="h-4 w-4" />
              <span className="sr-only">{t("assistant.send")}</span>
            </Button>
          </form>
        </div>
      )}
    </>
  );
}

function Section({
  icon,
  label,
  text,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  text: string;
  tone: "violet" | "amber" | "emerald" | "red";
}) {
  const toneCls: Record<typeof tone, string> = {
    violet: "text-violet-700 dark:text-violet-300",
    amber: "text-amber-700 dark:text-amber-300",
    emerald: "text-emerald-700 dark:text-emerald-300",
    red: "text-red-700 dark:text-red-300",
  };
  return (
    <div>
      <div
        className={`mb-1 flex items-center gap-1.5 text-xs font-semibold ${toneCls[tone]}`}
      >
        {icon}
        <span>{label}</span>
      </div>
      <div className="leading-relaxed text-slate-700 dark:text-slate-200">
        {text}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function safeGetState(reg: ScreenActionsRegistration | null): Record<string, any> {
  try {
    return reg?.getState() ?? {};
  } catch {
    return {};
  }
}

/**
 * Trim lookup arrays before sending to the backend so we don't bloat
 * the prompt. The first 200 entries cover the vast majority of real
 * cases (companies typically have <200 customers / items in the AI's
 * working set; for larger lists the user should ask by name and we'll
 * resolve in-process).
 */
function compactLookups(
  lookups: Record<string, { id: string; name: string; meta?: Record<string, any> }[]>,
): Record<string, { id: string; name: string; meta?: Record<string, any> }[]> {
  const out: Record<string, any[]> = {};
  for (const [k, list] of Object.entries(lookups)) {
    out[k] = (list ?? []).slice(0, 200);
  }
  return out;
}
