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
import CustomersAdmin from "./CustomersAdmin";
import ItemsAdmin from "./ItemsAdmin";
import UomAdmin from "./UomAdmin";
import UpdatesScreen from "./UpdatesScreen";
import { countPendingInvoices } from "../lib/invoices";
import { syncPushNow, pullAndPersist, type PushSummary, type PullSummary } from "../lib/sync";
import { listParkedCarts } from "../lib/parkedCarts";
import { flushPendingSessionCloses, countPendingCloses } from "../lib/pendingSessionCloses";

type View = "sales" | "returns" | "pending" | "parked" | "customers" | "items" | "uom" | "dashboard" | "updates";

type Props = {
  baseUrl: string;
  deviceToken: string;
  userToken?: string;
  cashierContext?: CashierContext | null;
  companyName?: string;
  deviceId: number;
  onSignOut: () => void | Promise<void>;
  onLogoutCashier?: () => void | Promise<void>;
};

export default function PosShell({
  baseUrl, deviceToken, userToken, cashierContext,
  companyName, deviceId, onSignOut, onLogoutCashier,
}: Props) {
  const api = useMemo(
    () => createApi({ baseUrl, deviceToken, userToken: userToken ?? null }),
    [baseUrl, deviceToken, userToken],
  );
  const posSessionId = cashierContext?.posSessionId ?? 0;
  const effectiveCompanyName = companyName ?? cashierContext?.companyName;

  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [pulled, setPulled] = useState<PullSummary | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [heartbeatErr, setHeartbeatErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showPeripherals, setShowPeripherals] = useState(false);
  const [view, setView] = useState<View>("sales");
  const [pendingCount, setPendingCount] = useState(0);
  const [parkedCount, setParkedCount] = useState(0);
  const [pushSummary, setPushSummary] = useState<PushSummary | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  const refreshParkedCount = useCallback(async () => {
    if (!posSessionId) { setParkedCount(0); return; }
    try { setParkedCount((await listParkedCarts(posSessionId)).length); }
    catch { /* ignore — view itself surfaces errors */ }
  }, [posSessionId]);

  // Re-count parked carts when switching views (cheap, scoped to session).
  useEffect(() => { void refreshParkedCount(); }, [view, refreshParkedCount]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try { const n = await countPendingInvoices(); if (!cancelled) setPendingCount(n); }
      catch { /* ignore */ }
    };
    void tick();
    const id = setInterval(tick, 10_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [view]);

  useEffect(() => {
    const tick = async () => {
      try {
        // Send the active session id so the server can bump pos_sessions.last_heartbeat_at —
        // that's the signal the auto-close janitor uses to tell "cashier still active" apart
        // from "session abandoned". Without it the server can only fall back to openedAt and
        // would reap any session whose cashier stayed logged in past the stale threshold.
        await api.heartbeat({
          appVersion: "0.2.0-dev",
          ...(posSessionId ? { posSessionId } : {}),
        });
        const s = await api.status();
        setStatus(s); setHeartbeatErr(null);
        // Opportunistic drain of any queued offline-logout closes. Best-effort —
        // failures stay in the queue and will be retried on the next tick.
        if (countPendingCloses() > 0) {
          try { await flushPendingSessionCloses(api); } catch { /* logged inside */ }
        }
      } catch (e: any) { setHeartbeatErr(e?.message ?? "heartbeat failed"); }
    };
    void tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [api, posSessionId]);

  async function doPull() {
    setBusy("pull"); setActionErr(null);
    try {
      const r = await pullAndPersist(baseUrl, deviceToken);
      setPulled(r);
    } catch (e: any) { setActionErr(e?.message ?? "pull failed"); }
    finally { setBusy(null); }
  }

  async function doPush() {
    setBusy("push"); setActionErr(null); setPushSummary(null);
    try {
      const r = await syncPushNow(baseUrl, deviceToken);
      setPushSummary(r);
      try { setPendingCount(await countPendingInvoices()); } catch { /* ignore */ }
    } catch (e: any) { setActionErr(e?.message ?? "push failed"); }
    finally { setBusy(null); }
  }

  async function doDeactivate() {
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

  const navItems: Array<{ id: View; icon: string; label: string; badge?: number }> = [
    { id: "sales",     icon: "🛒", label: "بيع" },
    { id: "returns",   icon: "↩️", label: "مرتجع" },
    { id: "parked",    icon: "📌", label: "السلال المعلّقة", badge: parkedCount > 0 ? parkedCount : undefined },
    { id: "pending",   icon: "📋", label: "الفواتير غير المرفوعة", badge: pendingCount > 0 ? pendingCount : undefined },
    { id: "customers", icon: "👥", label: "العملاء" },
    { id: "items",     icon: "📦", label: "الأصناف" },
    { id: "uom",       icon: "📐", label: "وحدات القياس" },
    { id: "dashboard", icon: "📊", label: "لوحة التحكم" },
    { id: "updates",   icon: "🔄", label: "التحديثات" },
  ];

  return (
    <div dir="rtl" style={S.shell}>
      {/* ─── Left navigation rail (RTL = right) ─────────────── */}
      <nav style={S.nav}>
        <div style={S.brand}>
          <div style={S.brandIcon}>zacode</div>
          <div>
            <div style={S.brandName}>ZACOD POS</div>
            <div style={S.brandTag}>v0.2 — desktop</div>
          </div>
        </div>

        <div style={S.navList}>
          {navItems.map((it) => {
            const active = view === it.id;
            return (
              <button
                key={it.id}
                onClick={() => setView(it.id)}
                style={active ? S.navItemActive : S.navItem}
              >
                <span style={S.navIcon}>{it.icon}</span>
                <span style={S.navLabel}>{it.label}</span>
                {it.badge !== undefined && (
                  <span style={S.navBadge}>{it.badge}</span>
                )}
              </button>
            );
          })}
        </div>

        <div style={S.navFooter}>
          <button onClick={() => setShowPeripherals(true)} style={S.navUtility}>
            🖨️ <span>الأجهزة الطرفية</span>
          </button>
          <div style={S.modeChip}>
            {TAURI_MODE === "tauri" ? "🪟 وضع التطبيق الأصلي" : "🌐 وضع المتصفح"}
          </div>
        </div>
      </nav>

      {/* ─── Main column ───────────────────────────────────── */}
      <div style={S.main}>
        {/* Top utility bar */}
        <header style={S.topbar}>
          <div>
            {effectiveCompanyName && <div style={S.companyName}>{effectiveCompanyName}</div>}
            <div style={S.viewTitle}>{labelFor(view)}</div>
          </div>
          <div style={S.topRight}>
            {cashierContext && (
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
            <SyncIndicator status={status} heartbeatErr={heartbeatErr} />
            <div style={S.deviceChip}>جهاز #{deviceId || "—"}</div>
            {onLogoutCashier && (
              <button onClick={doLogoutCashier} disabled={loggingOut} style={S.logoutBtn} title="تسجيل خروج الكاشير وإغلاق الوردية">
                {loggingOut ? "..." : "🚪 خروج"}
              </button>
            )}
          </div>
        </header>

        {/* Page content */}
        <main style={S.content}>
          {view === "sales" && <SalesScreen companyName={effectiveCompanyName} posSessionId={posSessionId} />}
          {view === "returns" && <ReturnsScreen companyName={effectiveCompanyName} />}
          {view === "pending" && <div style={S.pagePad}><PendingInvoices companyName={effectiveCompanyName} /></div>}
          {view === "parked" && (
            <div style={S.pagePad}>
              <ParkedCarts posSessionId={posSessionId} onResume={() => setView("sales")} />
            </div>
          )}
          {view === "customers" && <div style={S.pagePad}><CustomersAdmin /></div>}
          {view === "items" && <div style={S.pagePad}><ItemsAdmin /></div>}
          {view === "uom" && <div style={S.pagePad}><UomAdmin /></div>}
          {view === "dashboard" && (
            <div style={S.pagePad}>
              <DashboardView
                deviceId={deviceId}
                status={status}
                baseUrl={baseUrl}
                busy={busy}
                pulled={pulled}
                actionErr={actionErr}
                heartbeatErr={heartbeatErr}
                onPull={doPull}
                onPush={doPush}
                pushSummary={pushSummary}
                onDeactivate={doDeactivate}
              />
            </div>
          )}
          {view === "updates" && (
            <div style={S.pagePad}>
              <UpdatesScreen baseUrl={baseUrl} />
            </div>
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
    customers: "العملاء",
    items: "الأصناف",
    uom: "وحدات القياس",
    dashboard: "لوحة التحكم",
    updates: "التحديثات",
  }[v];
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
  } as const,
  brand: { display: "flex", gap: 10, alignItems: "center", padding: "0 8px 20px", borderBottom: "1px solid #334155", marginBottom: 16 } as const,
  brandIcon: {
    minWidth: 64, height: 38, padding: "0 10px", borderRadius: 10,
    background: "linear-gradient(135deg, #22d3ee 0%, #2563eb 100%)",
    display: "flex", alignItems: "center", justifyContent: "center",
    color: "#fff", fontWeight: 800, fontSize: 13, letterSpacing: 0.5,
    boxShadow: "0 4px 12px rgba(34,211,238,.3)",
    fontFamily: "'Segoe UI', system-ui, sans-serif",
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
