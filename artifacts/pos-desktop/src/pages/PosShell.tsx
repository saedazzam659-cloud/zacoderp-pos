// Post-activation shell — Windows-desktop redesign.
//
// New layout:
//   • Left-side vertical navigation rail (Outlook/Teams/VS Code style)
//   • Top utility bar with company badge + sync indicator + mode chip
//   • Main content area that hosts the active page (sales / returns /
//     customers / items / uom / pending / dashboard)
//
// The doPull action now calls pullAndPersist (sync.ts) which writes the
// fetched customers + items into the local store. This was the missing
// step that caused "تم السحب: 5 عميل، 184 صنف" to show on the dashboard
// while the sales screen kept reporting "لا توجد أصناف".

import { useCallback, useEffect, useMemo, useState } from "react";
import { createApi, type SyncStatus } from "../lib/api";
import { TAURI_MODE, type CashierContext } from "../lib/tauri-shim";
import PeripheralsSettings from "./PeripheralsSettings";
import SalesScreen from "./SalesScreen";
import PendingInvoices from "./PendingInvoices";
import ParkedCarts from "./ParkedCarts";
import ReturnsScreen from "./ReturnsScreen";
import DailyReportPage from "./DailyReport";
import CustomersAdmin from "./CustomersAdmin";
import ItemsAdmin from "./ItemsAdmin";
import UomAdmin from "./UomAdmin";
import UpdatesScreen from "./UpdatesScreen";
import StandaloneUsersAdmin from "./StandaloneUsersAdmin";
import ExpiryReport from "./ExpiryReport";
import { useTaxSettings, defaultRateForCountry } from "../lib/taxSettings";
import ScaleSettings from "./ScaleSettings";
import { countPendingInvoices } from "../lib/invoices";
import { getVertical, type Vertical } from "../lib/standalone";
import { syncPushNow, pullAndPersist, type PushSummary, type PullSummary } from "../lib/sync";
import { listParkedCarts } from "../lib/parkedCarts";
import { flushPendingSessionCloses, countPendingCloses } from "../lib/pendingSessionCloses";
import { useLatestVersion } from "../lib/updates";
import type { OfflineLicensePayload, LocalSession } from "../lib/standalone";

type View = "sales" | "returns" | "pending" | "parked" | "daily" | "customers" | "items" | "uom" | "dashboard" | "updates" | "users" | "expiry" | "scale";

type Props = {
  baseUrl: string;
  deviceToken: string;
  userToken?: string;
  cashierContext?: CashierContext | null;
  companyName?: string;
  deviceId: number;
  expiresAt?: string | null;
  onSignOut: () => void | Promise<void>;
  onLogoutCashier?: () => void | Promise<void>;
  /** Task #199: when true, render in standalone (no-cloud) mode. */
  standalone?: boolean;
  standaloneLicense?: OfflineLicensePayload;
  standaloneSession?: LocalSession;
};

export default function PosShell({
  baseUrl, deviceToken, userToken, cashierContext,
  companyName, deviceId, expiresAt, onSignOut, onLogoutCashier,
  standalone = false, standaloneLicense, standaloneSession,
}: Props) {
  const api = useMemo(
    () => standalone ? null : createApi({ baseUrl, deviceToken, userToken: userToken ?? null }),
    [baseUrl, deviceToken, userToken, standalone],
  );
  // In standalone mode there is no pos_sessions row — use a synthetic session id
  // (1) so parked-carts scope still works (single virtual session per machine).
  const posSessionId = standalone ? 1 : (cashierContext?.posSessionId ?? 0);
  // Standalone topbar must NOT show any company/customer identity (per spec).
  const effectiveCompanyName = standalone
    ? undefined
    : (companyName ?? cashierContext?.companyName);
  const effectiveCashierName = standalone
    ? (standaloneSession?.displayName ?? standaloneSession?.username)
    : (cashierContext?.nameAr || cashierContext?.username);

  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [pulled, setPulled] = useState<PullSummary | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [heartbeatErr, setHeartbeatErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showPeripherals, setShowPeripherals] = useState(false);
  const [view, setView] = useState<View>("sales");
  // Sidebar collapse — persisted across reloads so the cashier's choice sticks.
  // Collapsed = 64px icon-only rail (gives the items grid ~180px more breathing
  // room on 1280-wide tills). Expanded = original 240px with labels.
  const [navCollapsed, setNavCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem("pos_desktop_nav_collapsed") === "1"; } catch { return false; }
  });
  const toggleNav = useCallback(() => {
    setNavCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem("pos_desktop_nav_collapsed", next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const [pendingCount, setPendingCount] = useState(0);
  const [parkedCount, setParkedCount] = useState(0);
  const [pushSummary, setPushSummary] = useState<PushSummary | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const { latest: latestRelease, isNewer: updateAvailable } = useLatestVersion(baseUrl);
  // Vertical preset (Task #200) — drives pharmacy-only nav (تقرير الصلاحية).
  // Read once on mount; switching verticals requires a re-launch.
  const [vertical, setVerticalState] = useState<Vertical>("general");
  useEffect(() => { void getVertical().then((v) => v && setVerticalState(v)); }, []);
  const isPharmacy = vertical === "pharmacy";

  const refreshParkedCount = useCallback(async () => {
    if (!posSessionId) { setParkedCount(0); return; }
    try { setParkedCount((await listParkedCarts(posSessionId)).length); }
    catch { /* ignore — view itself surfaces errors */ }
  }, [posSessionId]);

  // Re-count parked carts when switching views (cheap, scoped to session).
  useEffect(() => { void refreshParkedCount(); }, [view, refreshParkedCount]);

  useEffect(() => {
    if (standalone) return; // No cloud "pending invoices" queue in standalone mode.
    let cancelled = false;
    const tick = async () => {
      try { const n = await countPendingInvoices(); if (!cancelled) setPendingCount(n); }
      catch { /* ignore */ }
    };
    void tick();
    const id = setInterval(tick, 10_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [view, standalone]);

  useEffect(() => {
    if (standalone || !api) return; // Standalone never talks to the cloud.
    const tick = async () => {
      try {
        await api.heartbeat({
          appVersion: "0.6.0",
          ...(posSessionId ? { posSessionId } : {}),
        });
        const s = await api.status();
        setStatus(s); setHeartbeatErr(null);
        if (countPendingCloses() > 0) {
          try { await flushPendingSessionCloses(api); } catch { /* logged inside */ }
        }
      } catch (e: any) { setHeartbeatErr(e?.message ?? "heartbeat failed"); }
    };
    void tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [api, posSessionId, standalone]);

  async function doPull() {
    if (standalone) return;
    setBusy("pull"); setActionErr(null);
    try {
      const r = await pullAndPersist(baseUrl, deviceToken);
      setPulled(r);
    } catch (e: any) { setActionErr(e?.message ?? "pull failed"); }
    finally { setBusy(null); }
  }

  async function doPush() {
    if (standalone) return;
    setBusy("push"); setActionErr(null); setPushSummary(null);
    try {
      const r = await syncPushNow(baseUrl, deviceToken);
      setPushSummary(r);
      try { setPendingCount(await countPendingInvoices()); } catch { /* ignore */ }
    } catch (e: any) { setActionErr(e?.message ?? "push failed"); }
    finally { setBusy(null); }
  }

  async function doDeactivate() {
    if (standalone || !api) {
      // In standalone mode "deactivate" means "wipe everything and pick mode again".
      await onSignOut();
      return;
    }
    if (!confirm("هل أنت متأكد من إلغاء تفعيل هذا الجهاز؟ ستحتاج لمفتاح ترخيص جديد لإعادة التفعيل.")) return;
    setBusy("deactivate"); setActionErr(null);
    try {
      await api.deactivate();
      await onSignOut();
    } catch (e: any) { setActionErr(e?.message ?? "deactivate failed"); setBusy(null); }
  }

  async function doLogoutCashier() {
    if (!onLogoutCashier) return;
    if (!confirm("هل تريد تسجيل خروج الكاشير الحالي وإغلاق الوردية؟")) return;
    setLoggingOut(true);
    try { await onLogoutCashier(); }
    catch (e: any) { setActionErr(e?.message ?? "logout failed"); setLoggingOut(false); }
  }

  // Cloud-only nav entries hidden in standalone mode:
  //   • pending (cloud upload queue), dashboard (sync controls), updates (cloud release feed)
  // Standalone gains: users (local user admin, admin role only).
  const navItems: Array<{ id: View; icon: string; label: string; badge?: number }> = standalone ? [
    { id: "sales",     icon: "🛒", label: "بيع" },
    { id: "returns",   icon: "↩️", label: "مرتجع" },
    { id: "parked",    icon: "📌", label: "السلال المعلّقة", badge: parkedCount > 0 ? parkedCount : undefined },
    { id: "daily",     icon: "📊", label: "تقرير اليومية" },
    { id: "customers", icon: "👥", label: "العملاء" },
    { id: "items",     icon: "📦", label: "الأصناف" },
    { id: "uom",       icon: "📐", label: "وحدات القياس" },
    { id: "scale",     icon: "⚖️", label: "الميزان" },
    ...(isPharmacy ? [{ id: "expiry" as View, icon: "⏳", label: "تقرير الصلاحية" }] : []),
    ...(standaloneSession?.role === "admin"
      ? [{ id: "users" as View, icon: "🔐", label: "المستخدمون" }]
      : []),
    { id: "dashboard", icon: "⚙️", label: "لوحة التحكم" },
    // Updates entry — even standalone users want to install newer app
    // versions (the device usually has occasional internet for this).
    // The Updates screen itself gracefully handles offline by showing
    // an error and a manual-download link.
    { id: "updates",   icon: "🔄", label: "التحديثات" },
  ] : [
    { id: "sales",     icon: "🛒", label: "بيع" },
    { id: "returns",   icon: "↩️", label: "مرتجع" },
    { id: "parked",    icon: "📌", label: "السلال المعلّقة", badge: parkedCount > 0 ? parkedCount : undefined },
    { id: "pending",   icon: "📋", label: "الفواتير غير المرفوعة", badge: pendingCount > 0 ? pendingCount : undefined },
    { id: "daily",     icon: "📊", label: "تقرير اليومية" },
    { id: "customers", icon: "👥", label: "العملاء" },
    { id: "items",     icon: "📦", label: "الأصناف" },
    { id: "uom",       icon: "📐", label: "وحدات القياس" },
    { id: "scale",     icon: "⚖️", label: "الميزان" },
    ...(isPharmacy ? [{ id: "expiry" as View, icon: "⏳", label: "تقرير الصلاحية" }] : []),
    { id: "dashboard", icon: "📊", label: "لوحة التحكم" },
    { id: "updates",   icon: "🔄", label: "التحديثات" },
  ];

  return (
    <div dir="rtl" style={S.shell}>
      {/* ─── Left navigation rail (RTL = right) ─────────────── */}
      {/* The rail dynamically swaps between 240px (labels) and 64px
          (icon-only). Width transition is animated so the items grid
          to its left visibly expands/contracts. */}
      <nav style={navCollapsed ? S.navCollapsed : S.nav}>
        <div style={navCollapsed ? S.brandCollapsed : S.brand}>
          <div style={navCollapsed ? S.brandIconCollapsed : S.brandIcon}>
            {navCollapsed ? "Z" : "zacode"}
          </div>
          {!navCollapsed && (
            <div>
              <div style={S.brandName}>ZACOD POS</div>
              <div style={S.brandTag}>v0.7.11 — {standalone ? "standalone" : "desktop"}{isPharmacy ? " · 💊" : ""}</div>
            </div>
          )}
        </div>

        {/* Collapse / expand toggle — chevron flips direction (RTL: collapse
            points right ▶, expand points left ◀). Tooltip-only when collapsed. */}
        <button
          onClick={toggleNav}
          style={navCollapsed ? S.collapseToggleCollapsed : S.collapseToggle}
          title={navCollapsed ? "توسيع القائمة" : "تصغير القائمة"}
        >
          <span style={{ fontSize: 14 }}>{navCollapsed ? "◀" : "▶"}</span>
          {!navCollapsed && <span style={{ fontSize: 12 }}>تصغير</span>}
        </button>

        <div style={S.navList}>
          {navItems.map((it) => {
            const active = view === it.id;
            const baseStyle = active ? S.navItemActive : S.navItem;
            return (
              <button
                key={it.id}
                onClick={() => setView(it.id)}
                style={navCollapsed
                  ? { ...baseStyle, justifyContent: "center", padding: "12px 0", gap: 0, position: "relative" as const }
                  : baseStyle}
                title={navCollapsed ? `${it.label}${it.badge ? ` (${it.badge})` : ""}` : undefined}
              >
                <span style={navCollapsed ? S.navIconLarge : S.navIcon}>{it.icon}</span>
                {!navCollapsed && <span style={S.navLabel}>{it.label}</span>}
                {it.badge !== undefined && (
                  navCollapsed
                    ? <span style={S.navBadgeDot}>{it.badge > 9 ? "9+" : it.badge}</span>
                    : <span style={S.navBadge}>{it.badge}</span>
                )}
              </button>
            );
          })}
        </div>

        <div style={S.navFooter}>
          <button
            onClick={() => setShowPeripherals(true)}
            style={navCollapsed
              ? { ...S.navUtility, justifyContent: "center", padding: "10px 0", gap: 0 }
              : S.navUtility}
            title={navCollapsed ? "الأجهزة الطرفية" : undefined}
          >
            <span style={{ fontSize: navCollapsed ? 18 : 14 }}>🖨️</span>
            {!navCollapsed && <span>الأجهزة الطرفية</span>}
          </button>
          {!navCollapsed && (
            <div style={S.modeChip}>
              {TAURI_MODE === "tauri" ? "🪟 وضع التطبيق الأصلي" : "🌐 وضع المتصفح"}
            </div>
          )}
        </div>
      </nav>

      {/* ─── Main column ───────────────────────────────────── */}
      <div style={S.main}>
        {/* Top utility bar */}
        <header style={S.topbar}>
          <div style={{ flexShrink: 0 }}>
            {effectiveCompanyName && <div style={S.companyName}>{effectiveCompanyName}</div>}
            <div style={S.viewTitle}>{labelFor(view)}</div>
          </div>
          {/* Expiry banner — moved into the topbar (was a full-width strip
              below). Lives in the empty space between left title and right
              chips, so it no longer steals a row from the cart pane. */}
          <div style={{ flex: 1, display: "flex", justifyContent: "center", padding: "0 16px", minWidth: 0 }}>
            <ExpiryBanner expiresAt={expiresAt ?? null} compact />
          </div>
          <div style={S.topRight}>
            {cashierContext && !standalone && (
              <div style={S.cashierChip} title={`جلسة #${cashierContext.posSessionId} — مفتوحة منذ ${new Date(cashierContext.openedAt).toLocaleString("ar-SA")}`}>
                <span style={S.cashierIcon}>👤</span>
                <div style={S.cashierInfo}>
                  <div style={S.cashierName}>{cashierContext.nameAr || cashierContext.username}</div>
                  <div style={S.cashierMeta}>
                    {cashierContext.branchName ?? "—"}
                    {cashierContext.posTerminalName ? ` · ${cashierContext.posTerminalName}` : ""}
                  </div>
                </div>
              </div>
            )}
            {standalone && standaloneSession && (
              <div style={S.cashierChip} title={`مستخدم محلي — دخل في ${new Date(standaloneSession.signedInAt).toLocaleString("ar-SA")}`}>
                <span style={S.cashierIcon}>👤</span>
                <div style={S.cashierInfo}>
                  <div style={S.cashierName}>{standaloneSession.displayName || standaloneSession.username}</div>
                  <div style={S.cashierMeta}>
                    {standaloneSession.role === "admin" ? "مسؤول" : "كاشير"} · مستقل
                  </div>
                </div>
              </div>
            )}
            {!standalone && <SyncIndicator status={status} heartbeatErr={heartbeatErr} />}
            {!standalone && <div style={S.deviceChip}>جهاز #{deviceId || "—"}</div>}
            {standalone && <div style={S.deviceChip} title={standaloneLicense?.licenseKey}>🔐 ترخيص مستقل</div>}
            {onLogoutCashier && (
              <button onClick={doLogoutCashier} disabled={loggingOut} style={S.logoutBtn}
                      title={standalone ? "تسجيل خروج المستخدم" : "تسجيل خروج الكاشير وإغلاق الوردية"}>
                {loggingOut ? "..." : "🚪 خروج"}
              </button>
            )}
          </div>
        </header>

        {/* New-version notification banner (Task #187). Cloud-only. */}
        {!standalone && updateAvailable && latestRelease && !updateDismissed && (
          <UpdateBanner
            version={latestRelease.version}
            onOpen={() => setView("updates")}
            onDismiss={() => setUpdateDismissed(true)}
          />
        )}

        {/* Subscription-expiry warning is now rendered inline inside the
            topbar above (compact pill). No separate row here. */}

        {/* Page content */}
        <main style={S.content}>
          {view === "sales" && <SalesScreen companyName={effectiveCompanyName} posSessionId={posSessionId} cashierName={effectiveCashierName} />}
          {view === "returns" && <div style={S.pagePad}><ReturnsScreen companyName={effectiveCompanyName} cashierName={effectiveCashierName} /></div>}
          {!standalone && view === "pending" && <div style={S.pagePad}><PendingInvoices companyName={effectiveCompanyName} /></div>}
          {view === "parked" && (
            <div style={S.pagePad}>
              <ParkedCarts posSessionId={posSessionId} onResume={() => setView("sales")} />
            </div>
          )}
          {view === "daily" && (
            <div style={S.pagePad}>
              <DailyReportPage companyName={effectiveCompanyName} cashierName={effectiveCashierName} />
            </div>
          )}
          {view === "customers" && <div style={S.pagePad}><CustomersAdmin /></div>}
          {view === "items" && <div style={S.pagePad}><ItemsAdmin /></div>}
          {view === "uom" && <div style={S.pagePad}><UomAdmin /></div>}
          {view === "scale" && <div style={S.pagePad}><ScaleSettings /></div>}
          {view === "expiry" && isPharmacy && <div style={S.pagePad}><ExpiryReport onJumpToItems={() => setView("items")} /></div>}
          {!standalone && view === "dashboard" && (
            <div style={S.pagePad}>
              <DashboardView
                deviceId={deviceId} status={status} baseUrl={baseUrl} busy={busy} pulled={pulled}
                actionErr={actionErr} heartbeatErr={heartbeatErr}
                onPull={doPull} onPush={doPush} pushSummary={pushSummary} onDeactivate={doDeactivate}
              />
            </div>
          )}
          {standalone && view === "dashboard" && (
            <div style={S.pagePad}>
              <StandaloneDashboardView
                license={standaloneLicense}
                session={standaloneSession}
                onOpenPeripherals={() => setShowPeripherals(true)}
                onOpenScale={() => setView("scale")}
                onOpenUsers={() => setView("users")}
                onWipe={onSignOut}
              />
            </div>
          )}
          {view === "updates" && (
            <div style={S.pagePad}><UpdatesScreen baseUrl={baseUrl} /></div>
          )}
          {standalone && view === "users" && standaloneSession && (
            <StandaloneUsersAdmin session={standaloneSession} maxUsers={standaloneLicense?.maxUsers ?? 1} />
          )}
        </main>
      </div>

      {showPeripherals && <PeripheralsSettings onClose={() => setShowPeripherals(false)} />}
    </div>
  );
}

function labelFor(v: View): string {
  return {
    sales: "نقطة البيع",
    returns: "مرتجع المبيعات",
    parked: "السلال المعلّقة",
    pending: "الفواتير غير المرفوعة",
    daily: "تقرير اليومية",
    customers: "العملاء",
    items: "الأصناف",
    uom: "وحدات القياس",
    expiry: "تقرير الصلاحية",
    scale: "إعدادات الميزان",
    dashboard: "لوحة التحكم",
    updates: "التحديثات",
    users: "المستخدمون المحليون",
  }[v];
}

function UpdateBanner({
  version, onOpen, onDismiss,
}: { version: string; onOpen: () => void; onDismiss: () => void }) {
  return (
    <div style={S.updateBanner}>
      <span style={{ fontSize: 18 }}>⬇️</span>
      <span style={{ flex: 1 }}>
        تتوفّر نسخة جديدة <strong>v{version}</strong> — يُنصح بالتحديث للحصول على آخر الإصلاحات والتحسينات.
      </span>
      <button onClick={onOpen} style={S.updateBtn}>تنزيل الآن</button>
      <button onClick={onDismiss} style={S.updateClose} title="إخفاء حتى إعادة التشغيل">✕</button>
    </div>
  );
}

function ExpiryBanner({ expiresAt, compact = false }: { expiresAt: string | null; compact?: boolean }) {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const days = Math.ceil(ms / 86_400_000);
  if (days > 7) return null;
  const dateStr = new Date(expiresAt).toLocaleDateString("ar-SA", { year: "numeric", month: "long", day: "numeric" });
  if (compact) {
    // Compact-but-rich pill inside the topbar. Shows the full picture
    // in one glance: countdown (color-coded by urgency) + exact date
    // + direct WhatsApp/phone shortcuts. Stays a single line at ~720p.
    const urgent = days <= 3;
    const pillStyle = urgent ? S.warnPillUrgent : S.warnPill;
    return (
      <div style={pillStyle}>
        <span style={{ fontSize: 14 }}>{urgent ? "🔴" : "⚠️"}</span>
        <span style={S.pillSegMain}>
          ينتهي خلال{" "}
          <strong style={{ fontSize: 13, color: urgent ? "#991b1b" : "#78350f" }}>
            {days}
          </strong>{" "}
          {days === 1 ? "يوم" : "أيام"}
        </span>
        <span style={S.pillDivider}>·</span>
        <span style={S.pillSegDate} title="تاريخ انتهاء الاشتراك">📅 {dateStr}</span>
        <span style={S.pillDivider}>·</span>
        <span style={S.pillSegContact}>للتجديد — م/ كرم عزام</span>
        <a
          href="https://wa.me/201000903159"
          target="_blank"
          rel="noreferrer"
          style={S.pillWhatsapp}
          title="فتح واتساب — 00201000903159"
        >
          💬 واتساب
        </a>
        <a
          href="tel:01000903159"
          style={S.pillPhone}
          title="01000903159 داخل مصر · 00201000903159 خارج مصر"
        >
          📞 اتصال
        </a>
      </div>
    );
  }
  return (
    <div style={S.warnBanner}>
      <span style={{ fontSize: 18 }}>⚠️</span>
      <span style={{ flex: 1 }}>
        ينتهي اشتراك هذا الجهاز خلال <strong>{days}</strong> {days === 1 ? "يوم" : "أيام"} (بتاريخ {dateStr}) —
        للتجديد تواصل مع م/ كرم عزام:&nbsp;
        <a href="tel:01000903159" style={{ color: "#0c4a6e", fontWeight: 700, textDecoration: "underline" }}>
          01000903159
        </a>
        &nbsp;(داخل مصر) /&nbsp;
        <a href="tel:+201000903159" style={{ color: "#0c4a6e", fontWeight: 700, textDecoration: "underline" }} dir="ltr">
          00201000903159
        </a>
        &nbsp;(خارج مصر) —&nbsp;
        <a href="https://wa.me/201000903159" target="_blank" rel="noreferrer"
           style={{ color: "#15803d", fontWeight: 700, textDecoration: "underline" }}>
          واتساب 💬
        </a>
      </span>
    </div>
  );
}

function SyncIndicator({ status, heartbeatErr }: { status: SyncStatus | null; heartbeatErr: string | null }) {
  const ok = !heartbeatErr && status?.status === "active";
  return (
    <div style={ok ? S.syncOk : S.syncDown} title={status?.lastHeartbeatAt ?? "—"}>
      <span style={{
        width: 8, height: 8, borderRadius: 999,
        background: ok ? "#16a34a" : "#dc2626",
        boxShadow: `0 0 0 3px ${ok ? "rgba(22,163,74,.2)" : "rgba(220,38,38,.2)"}`,
      }} />
      {ok ? "متصل" : "غير متصل"}
    </div>
  );
}

type DashboardProps = {
  deviceId: number;
  status: SyncStatus | null;
  baseUrl: string;
  busy: string | null;
  pulled: PullSummary | null;
  actionErr: string | null;
  heartbeatErr: string | null;
  onPull: () => void;
  onPush: () => void;
  pushSummary: PushSummary | null;
  onDeactivate: () => void;
};

function DashboardView({ deviceId, status, baseUrl, busy, pulled, actionErr, heartbeatErr, onPull, onPush, pushSummary, onDeactivate }: DashboardProps) {
  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16, marginBottom: 16 }}>
        <Tile icon="🪪" label="معرّف الجهاز" value={String(deviceId || "—")} />
        <Tile icon="🟢" label="الحالة" value={status?.status ?? "..."} accent={status?.status === "active" ? "#16a34a" : undefined} />
        <Tile icon="💓" label="آخر نبضة" value={status?.lastHeartbeatAt ? new Date(status.lastHeartbeatAt).toLocaleString("ar-SA") : "—"} small />
        <Tile icon="🔄" label="آخر مزامنة" value={status?.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString("ar-SA") : "—"} small />
      </div>

      <section style={S.card}>
        <h2 style={S.h2}>إجراءات المزامنة</h2>
        <div style={S.btnRow}>
          <button onClick={onPull} disabled={busy === "pull"} style={S.btnPrimary}>
            {busy === "pull" ? "جارٍ السحب..." : "⬇️ سحب البيانات (Pull)"}
          </button>
          <button onClick={onPush} disabled={busy === "push"} style={S.btnPrimary}>
            {busy === "push" ? "جارٍ الرفع..." : "⬆️ رفع الفواتير المعلّقة (Push)"}
          </button>
          <button onClick={onDeactivate} disabled={busy === "deactivate"} style={S.btnDanger}>
            {busy === "deactivate" ? "جارٍ الإلغاء..." : "إلغاء تفعيل الجهاز"}
          </button>
        </div>
        {pulled && (
          <div style={S.success}>
            ✅ تم السحب والحفظ محلياً: {pulled.customers} عميل، {pulled.items} صنف — الأصناف ستظهر فوراً في شاشة البيع
          </div>
        )}
        {pushSummary && (
          <div style={pushSummary.failed > 0
            ? { ...S.success, background: "#fffbeb", borderColor: "#fde68a", color: "#92400e" }
            : S.success}>
            {pushSummary.attempted === 0
              ? "ℹ️ لا توجد فواتير معلّقة للرفع."
              : `✅ تم رفع ${pushSummary.synced} من ${pushSummary.attempted} فاتورة` +
                (pushSummary.failed > 0 ? ` — ${pushSummary.failed} رُفضت وستُعاد المحاولة` : "")}
          </div>
        )}
        {actionErr && <div style={S.err}>⚠️ {actionErr}</div>}
        {heartbeatErr && !actionErr && (
          <div style={{ ...S.err, background: "#fffbeb", borderColor: "#fde68a", color: "#92400e" }}>
            🔌 المزامنة الخلفية: {heartbeatErr}
          </div>
        )}
      </section>

      <section style={S.card}>
        <h2 style={S.h2}>تفاصيل الاتصال</h2>
        <KV k="الخادم" v={baseUrl} mono />
        <KV k="معرّف الجهاز" v={String(deviceId || "—")} />
      </section>
    </div>
  );
}

function StandaloneDashboardView({
  license, session, onOpenPeripherals, onOpenScale, onOpenUsers, onWipe,
}: {
  license?: OfflineLicensePayload;
  session?: LocalSession;
  onOpenPeripherals: () => void;
  onOpenScale: () => void;
  onOpenUsers: () => void;
  onWipe: () => void | Promise<void>;
}) {
  const isAdmin = session?.role === "admin";
  async function confirmWipe() {
    if (!confirm("⚠️ سيتم مسح كل البيانات المحلية (الترخيص، المستخدمون، الفواتير المحفوظة). متأكد؟")) return;
    await onWipe();
  }
  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <section style={S.card}>
        <h2 style={S.h2}>الإعدادات السريعة</h2>
        <div style={S.btnRow}>
          <button onClick={onOpenPeripherals} style={S.btnPrimary}>🖨️ الأجهزة الطرفية (الطابعة)</button>
          <button onClick={onOpenScale} style={S.btnPrimary}>⚖️ إعدادات الميزان</button>
          {isAdmin && (
            <button onClick={onOpenUsers} style={S.btnPrimary}>🔐 المستخدمون</button>
          )}
        </div>
      </section>

      {isAdmin && <TaxSettingsCard />}

      {license && (
        <section style={S.card}>
          <h2 style={S.h2}>معلومات الترخيص</h2>
          <KV k="مفتاح الترخيص" v={license.licenseKey} mono />
          <KV k="العميل" v={license.customerName ?? "—"} />
          <KV k="المجال" v={license.vertical === "pharmacy" ? "صيدلية" : license.vertical === "grocery" ? "بقالة/سوبرماركت" : "عام"} />
          <KV k="الخطة" v={license.plan ?? "—"} />
          <KV k="الحد الأقصى للمستخدمين" v={String(license.maxUsers ?? "—")} />
          {license.expiresAt && (
            <KV k="ينتهي في" v={new Date(license.expiresAt).toLocaleDateString("ar-SA", { year: "numeric", month: "long", day: "numeric" })} />
          )}
        </section>
      )}

      {isAdmin && (
        <section style={S.card}>
          <h2 style={S.h2}>منطقة الخطر</h2>
          <p style={{ color: "#64748b", fontSize: 13, marginBottom: 12 }}>
            مسح كل البيانات المحلية يعيد التطبيق لشاشة اختيار الوضع الأولى. لا يمكن التراجع.
          </p>
          <div style={S.btnRow}>
            <button onClick={confirmWipe} style={S.btnDanger}>🗑️ مسح كل البيانات وإعادة التعيين</button>
          </div>
        </section>
      )}
    </div>
  );
}

function Tile({ icon, label, value, accent, small }: { icon: string; label: string; value: string; accent?: string; small?: boolean }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 16, boxShadow: "0 1px 3px rgba(0,0,0,.04)" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontSize: 22 }}>{icon}</div>
        <div style={{ fontSize: 12, color: "#64748b" }}>{label}</div>
      </div>
      <div style={{ fontSize: small ? 13 : 20, fontWeight: 700, color: accent ?? "#0f172a" }}>{value}</div>
    </div>
  );
}

/**
 * Tax settings — VAT rate (%) + price-includes-tax toggle.
 *
 * Hidden for non-admins. Persisted by `lib/taxSettings.ts` to localStorage
 * (and mirrored to SQLite via standalone_set_setting in Tauri builds).
 * Sales/Returns screens subscribe to the change event so the cart label
 * and totals update without a refresh.
 *
 * The default rate is derived from the country chosen during activation
 * (e.g. SA→15, EG→14, AE→5). Admin can override at any time and reset
 * to country default with one click.
 */
function TaxSettingsCard() {
  const { rate, mode, country, setRate, setMode, resetToCountryDefault } = useTaxSettings();
  const [draft, setDraft] = useState<string>(String(rate));
  const [saved, setSaved] = useState<"" | "ok">("");
  useEffect(() => { setDraft(String(rate)); }, [rate]);

  function flash() { setSaved("ok"); setTimeout(() => setSaved(""), 1500); }

  function commitRate() {
    const n = Number(draft);
    if (!Number.isFinite(n) || n < 0 || n > 100) { setDraft(String(rate)); return; }
    setRate(n);
    flash();
  }

  const defaultForCountry = defaultRateForCountry(country);

  return (
    <section style={S.card}>
      <h2 style={S.h2}>إعدادات الضريبة</h2>
      <p style={{ color: "#64748b", fontSize: 13, marginBottom: 16 }}>
        تتحكم هنا في نسبة ضريبة القيمة المضافة وفي طريقة احتسابها على الفواتير.
        التغيير ينعكس فوراً على شاشة البيع والمرتجعات بدون الحاجة لإعادة تشغيل التطبيق.
      </p>

      {/* Mode toggle */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14 }}>طريقة احتساب الضريبة</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <ModeChip
            active={mode === "inclusive"}
            onClick={() => { setMode("inclusive"); flash(); }}
            title="السعر شامل الضريبة"
            sub="سعر الصنف يحتوي على الضريبة (يُفصل عند الطباعة)"
            example="مثال: سعر 115 = (100 صافي + 15 ضريبة)"
          />
          <ModeChip
            active={mode === "exclusive"}
            onClick={() => { setMode("exclusive"); flash(); }}
            title="السعر بدون الضريبة"
            sub="تُضاف الضريبة فوق سعر الصنف في الإجمالي"
            example="مثال: سعر 100 + 15 ضريبة = 115"
          />
        </div>
      </div>

      {/* Rate editor */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14 }}>نسبة الضريبة (%)</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="number" step="0.5" min={0} max={100}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRate}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            style={{ width: 110, padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 16, fontWeight: 700, textAlign: "center" }}
          />
          <span style={{ fontSize: 18, fontWeight: 700, color: "#0f172a" }}>%</span>
          <button
            type="button"
            onClick={resetToCountryDefault}
            style={{ padding: "8px 14px", background: "#f1f5f9", color: "#0f172a", border: "1px solid #cbd5e1", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 }}
            title={`الدولة المختارة: ${country} — الافتراضي ${defaultForCountry}%`}
          >
            🔄 إعادة لافتراضي الدولة ({country} = {defaultForCountry}%)
          </button>
          {saved === "ok" && (
            <span style={{ color: "#16a34a", fontSize: 13, fontWeight: 600 }}>✓ تم الحفظ</span>
          )}
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: "#64748b" }}>
          المثال الحالي: على فاتورة بقيمة <strong>100 ر.س</strong>{" "}
          {mode === "inclusive"
            ? <>(شاملة) → ضريبة <strong>{(100 - 100/(1+Number(draft)/100)).toFixed(2)}</strong>، صافي <strong>{(100/(1+Number(draft)/100)).toFixed(2)}</strong></>
            : <>(غير شاملة) → ضريبة <strong>{(100 * Number(draft)/100).toFixed(2)}</strong>، الإجمالي <strong>{(100 * (1+Number(draft)/100)).toFixed(2)}</strong></>}
        </div>
      </div>
    </section>
  );
}

function ModeChip({ active, onClick, title, sub, example }: { active: boolean; onClick: () => void; title: string; sub: string; example: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: "1 1 280px", textAlign: "right" as const, padding: 14,
        background: active ? "linear-gradient(135deg, #dbeafe, #eff6ff)" : "#f8fafc",
        border: `2px solid ${active ? "#2563eb" : "#e2e8f0"}`,
        borderRadius: 10, cursor: "pointer", fontFamily: "inherit",
        boxShadow: active ? "0 2px 8px rgba(37,99,235,0.15)" : "none",
        transition: "all .15s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 16 }}>{active ? "🟢" : "⚪"}</span>
        <span style={{ fontWeight: 700, fontSize: 14, color: active ? "#1e40af" : "#0f172a" }}>{title}</span>
      </div>
      <div style={{ fontSize: 12, color: "#475569", marginBottom: 4 }}>{sub}</div>
      <div style={{ fontSize: 11, color: "#64748b" }}>{example}</div>
    </button>
  );
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid #f1f5f9" }}>
    <span style={{ color: "#64748b", fontSize: 13 }}>{k}</span>
    <span style={{ fontFamily: mono ? "ui-monospace, monospace" : undefined, fontSize: mono ? 12 : 14, color: "#0f172a" }}>{v}</span>
  </div>;
}

const S = {
  // Full-viewport row: nav on the right (RTL), main column on the left.
  shell: { display: "flex", height: "100vh", width: "100vw", fontFamily: "'Segoe UI', system-ui, sans-serif", background: "#eef2f7", overflow: "hidden" } as const,

  // Vertical nav rail
  nav: {
    width: 240, flexShrink: 0,
    background: "linear-gradient(180deg, #0f172a 0%, #1e293b 100%)",
    color: "#cbd5e1",
    display: "flex", flexDirection: "column" as const,
    padding: "20px 12px",
    boxShadow: "-4px 0 12px rgba(0,0,0,.08)",
    transition: "width .18s ease",
  } as const,
  // Collapsed nav: 64px icon-only rail. Same gradient + shadow so it still
  // reads as the "sidebar"; just narrower with center-aligned icons.
  navCollapsed: {
    width: 64, flexShrink: 0,
    background: "linear-gradient(180deg, #0f172a 0%, #1e293b 100%)",
    color: "#cbd5e1",
    display: "flex", flexDirection: "column" as const,
    padding: "20px 6px",
    boxShadow: "-4px 0 12px rgba(0,0,0,.08)",
    transition: "width .18s ease",
  } as const,
  brand: { display: "flex", gap: 10, alignItems: "center", padding: "0 8px 20px", borderBottom: "1px solid #334155", marginBottom: 16 } as const,
  brandCollapsed: { display: "flex", justifyContent: "center", padding: "0 0 16px", borderBottom: "1px solid #334155", marginBottom: 12 } as const,
  brandIcon: {
    minWidth: 64, height: 38, padding: "0 10px", borderRadius: 10,
    background: "linear-gradient(135deg, #22d3ee 0%, #2563eb 100%)",
    display: "flex", alignItems: "center", justifyContent: "center",
    color: "#fff", fontWeight: 800, fontSize: 13, letterSpacing: 0.5,
    boxShadow: "0 4px 12px rgba(34,211,238,.3)",
    fontFamily: "'Segoe UI', system-ui, sans-serif",
  } as const,
  brandIconCollapsed: {
    width: 40, height: 40, borderRadius: 10,
    background: "linear-gradient(135deg, #22d3ee 0%, #2563eb 100%)",
    display: "flex", alignItems: "center", justifyContent: "center",
    color: "#fff", fontWeight: 800, fontSize: 18, letterSpacing: 0.5,
    boxShadow: "0 4px 12px rgba(34,211,238,.3)",
    fontFamily: "'Segoe UI', system-ui, sans-serif",
  } as const,
  // Collapse toggle — sits between brand and nav list.
  collapseToggle: {
    display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
    margin: "0 0 12px", padding: "6px 10px",
    background: "rgba(59,130,246,.08)", color: "#93c5fd",
    border: "1px solid #334155", borderRadius: 8,
    cursor: "pointer", fontSize: 12, fontFamily: "inherit", fontWeight: 600,
    transition: "all .12s",
  } as const,
  collapseToggleCollapsed: {
    display: "flex", alignItems: "center", justifyContent: "center",
    margin: "0 0 12px", padding: 8,
    background: "rgba(59,130,246,.08)", color: "#93c5fd",
    border: "1px solid #334155", borderRadius: 8,
    cursor: "pointer", fontFamily: "inherit",
    transition: "all .12s",
  } as const,
  navIconLarge: { fontSize: 22, width: 24, textAlign: "center" as const, lineHeight: 1 } as const,
  // Tiny corner badge for collapsed mode — overlays the icon, top-left.
  navBadgeDot: {
    position: "absolute" as const, top: 4, left: 4,
    minWidth: 18, height: 18, padding: "0 5px",
    background: "#dc2626", color: "#fff",
    borderRadius: 999, fontSize: 10, fontWeight: 700,
    display: "flex", alignItems: "center", justifyContent: "center",
    boxShadow: "0 0 0 2px #1e293b",
  } as const,
  brandName: { fontSize: 16, fontWeight: 700, color: "#f8fafc" } as const,
  brandTag: { fontSize: 10, color: "#94a3b8", marginTop: 2 } as const,

  navList: { display: "flex", flexDirection: "column" as const, gap: 4, flex: 1, overflowY: "auto" as const } as const,
  navItem: {
    display: "flex", alignItems: "center", gap: 12,
    padding: "10px 14px", border: "none",
    background: "transparent", color: "#cbd5e1",
    borderRadius: 8, cursor: "pointer", fontSize: 14,
    fontFamily: "inherit", textAlign: "right" as const,
    transition: "all .12s",
  } as const,
  navItemActive: {
    display: "flex", alignItems: "center", gap: 12,
    padding: "10px 14px", border: "none",
    background: "linear-gradient(90deg, rgba(37,99,235,.2) 0%, rgba(37,99,235,.05) 100%)",
    color: "#fff",
    borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600,
    fontFamily: "inherit", textAlign: "right" as const,
    borderRight: "3px solid #3b82f6",
  } as const,
  navIcon: { fontSize: 18, width: 24, textAlign: "center" as const } as const,
  navLabel: { flex: 1 } as const,
  navBadge: { padding: "2px 8px", background: "#dc2626", color: "#fff", borderRadius: 999, fontSize: 11, fontWeight: 700 } as const,

  navFooter: { borderTop: "1px solid #334155", paddingTop: 12, display: "flex", flexDirection: "column" as const, gap: 8 } as const,
  navUtility: {
    display: "flex", alignItems: "center", gap: 10,
    padding: "8px 14px", background: "transparent",
    color: "#94a3b8", border: "1px solid #334155",
    borderRadius: 8, cursor: "pointer", fontSize: 13, fontFamily: "inherit",
    textAlign: "right" as const,
  } as const,
  modeChip: { fontSize: 10, color: "#64748b", textAlign: "center" as const, padding: "6px", background: "rgba(0,0,0,.2)", borderRadius: 6 } as const,

  // Main column
  main: { flex: 1, display: "flex", flexDirection: "column" as const, minWidth: 0, minHeight: 0 } as const,
  topbar: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "14px 24px",
    background: "#fff", borderBottom: "1px solid #e2e8f0",
    flexShrink: 0,
  } as const,
  companyName: { fontSize: 13, color: "#64748b", fontWeight: 500 } as const,
  viewTitle: { fontSize: 20, fontWeight: 700, color: "#0f172a", marginTop: 2 } as const,
  topRight: { display: "flex", gap: 12, alignItems: "center" } as const,
  syncOk: { display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", background: "#f0fdf4", color: "#166534", border: "1px solid #bbf7d0", borderRadius: 999, fontSize: 12, fontWeight: 600 } as const,
  syncDown: { display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: 999, fontSize: 12, fontWeight: 600 } as const,
  deviceChip: { padding: "6px 12px", background: "#f1f5f9", color: "#475569", borderRadius: 999, fontSize: 12, fontFamily: "ui-monospace, monospace" } as const,
  cashierChip: {
    display: "flex", alignItems: "center", gap: 8,
    padding: "4px 12px 4px 8px", background: "#eff6ff", border: "1px solid #bfdbfe",
    borderRadius: 999, color: "#1e3a8a", fontSize: 12,
  } as const,
  cashierIcon: { fontSize: 16 } as const,
  cashierInfo: { display: "flex", flexDirection: "column" as const, lineHeight: 1.2 } as const,
  cashierName: { fontWeight: 700, color: "#0f172a" } as const,
  cashierMeta: { fontSize: 10, color: "#64748b" } as const,
  logoutBtn: {
    padding: "6px 12px", background: "#fff", color: "#dc2626",
    border: "1px solid #fecaca", borderRadius: 8, cursor: "pointer",
    fontSize: 12, fontWeight: 600, fontFamily: "inherit",
  } as const,

  warnBanner: {
    display: "flex", alignItems: "center", gap: 10,
    padding: "10px 24px",
    background: "linear-gradient(90deg, #fef3c7 0%, #fde68a 100%)",
    color: "#78350f", borderBottom: "1px solid #fcd34d",
    fontSize: 13, fontWeight: 600, flexShrink: 0,
  } as const,
  // Compact pill version of the expiry banner — fits inside the topbar.
  warnPill: {
    display: "inline-flex", alignItems: "center", gap: 8,
    padding: "6px 14px",
    background: "linear-gradient(90deg, #fef3c7 0%, #fde68a 100%)",
    color: "#78350f", border: "1px solid #fcd34d", borderRadius: 999,
    fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" as const,
    maxWidth: "100%", overflow: "hidden",
    boxShadow: "0 1px 4px rgba(251,191,36,0.25)",
  } as const,
  warnPillUrgent: {
    display: "inline-flex", alignItems: "center", gap: 8,
    padding: "6px 14px",
    background: "linear-gradient(90deg, #fee2e2 0%, #fecaca 100%)",
    color: "#7f1d1d", border: "1px solid #fca5a5", borderRadius: 999,
    fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" as const,
    maxWidth: "100%", overflow: "hidden",
    boxShadow: "0 1px 6px rgba(220,38,38,0.25)",
  } as const,
  pillSegMain: { display: "inline-flex", gap: 3, alignItems: "center" } as const,
  pillSegDate: { fontSize: 11.5, opacity: 0.92 } as const,
  pillSegContact: { fontSize: 11.5, opacity: 0.85 } as const,
  pillDivider: { opacity: 0.4, fontSize: 11 } as const,
  pillWhatsapp: {
    display: "inline-flex", alignItems: "center", gap: 3,
    padding: "3px 10px", background: "#16a34a", color: "#fff",
    borderRadius: 999, fontSize: 11.5, fontWeight: 700,
    textDecoration: "none", whiteSpace: "nowrap" as const,
    boxShadow: "0 1px 3px rgba(22,163,74,0.4)",
  } as const,
  pillPhone: {
    display: "inline-flex", alignItems: "center", gap: 3,
    padding: "3px 10px", background: "#fff", color: "#0f172a",
    border: "1px solid #cbd5e1", borderRadius: 999,
    fontSize: 11.5, fontWeight: 700,
    textDecoration: "none", whiteSpace: "nowrap" as const,
  } as const,
  updateBanner: {
    display: "flex", alignItems: "center", gap: 12,
    padding: "10px 24px",
    background: "linear-gradient(90deg, #dbeafe 0%, #d1fae5 100%)",
    color: "#0c4a6e", borderBottom: "1px solid #93c5fd",
    fontSize: 13, fontWeight: 600, flexShrink: 0,
  } as const,
  updateBtn: {
    padding: "6px 14px", background: "#2563eb", color: "#fff",
    border: "none", borderRadius: 6, cursor: "pointer",
    fontSize: 12, fontWeight: 700, fontFamily: "inherit",
  } as const,
  updateClose: {
    padding: "4px 10px", background: "transparent", color: "#0c4a6e",
    border: "1px solid #93c5fd", borderRadius: 6, cursor: "pointer",
    fontSize: 12, fontFamily: "inherit",
  } as const,
  content: { flex: 1, overflow: "hidden", minHeight: 0, display: "flex", flexDirection: "column" as const } as const,
  pagePad: { padding: 24, overflowY: "auto" as const, flex: 1 } as const,

  // Dashboard internals
  card: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: "0 1px 3px rgba(0,0,0,.04)" } as const,
  h2: { margin: "0 0 14px", fontSize: 16, color: "#0f172a" } as const,
  btnRow: { display: "flex", gap: 12, flexWrap: "wrap" as const } as const,
  btnPrimary: { padding: "10px 18px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600, fontFamily: "inherit" } as const,
  btnDanger: { padding: "10px 18px", background: "#fff", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600, fontFamily: "inherit" } as const,
  success: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", padding: 12, borderRadius: 8, marginTop: 12, fontSize: 14 } as const,
  err: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: 12, borderRadius: 8, marginTop: 12, fontSize: 14 } as const,
};
