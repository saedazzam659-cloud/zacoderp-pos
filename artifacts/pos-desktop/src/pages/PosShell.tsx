// Post-activation shell. Currently a status dashboard showing sync state +
// a "deactivate device" button for clean uninstall.
//
// TODO Step 10 of Task #174: replace with the real POS UI imported from
// artifacts/pos, swapping its API hooks for the local SQLite layer
// (src-tauri/src/db.rs) + sync queue (src-tauri/src/sync.rs).

import { useEffect, useMemo, useState } from "react";
import { createApi, type SyncStatus } from "../lib/api";
import { TAURI_MODE } from "../lib/tauri-shim";
import PeripheralsSettings from "./PeripheralsSettings";
import SalesScreen from "./SalesScreen";
import PendingInvoices from "./PendingInvoices";
import { countPendingInvoices } from "../lib/invoices";
import { syncPushNow, type PushSummary } from "../lib/sync";

type Props = {
  baseUrl: string;
  deviceToken: string;
  companyName?: string;
  deviceId: number;
  onSignOut: () => void | Promise<void>;
};

export default function PosShell({ baseUrl, deviceToken, companyName, deviceId, onSignOut }: Props) {
  // useMemo: rebuild the api client only when credentials actually change, so
  // setInterval's `tick` closure never captures a stale token after a sign-out
  // + re-activate cycle within the same App instance.
  const api = useMemo(() => createApi({ baseUrl, deviceToken }), [baseUrl, deviceToken]);

  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [pulled, setPulled] = useState<{ customers: number; items: number } | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);   // user-initiated (pull/deactivate)
  const [heartbeatErr, setHeartbeatErr] = useState<string | null>(null); // background polling
  const [busy, setBusy] = useState<string | null>(null);
  const [showPeripherals, setShowPeripherals] = useState(false);
  const [view, setView] = useState<"sales" | "pending" | "dashboard">("sales");
  const [pendingCount, setPendingCount] = useState(0);
  const [pushSummary, setPushSummary] = useState<PushSummary | null>(null);

  // Poll the pending-invoices count every 10s so the badge in the tab bar
  // stays roughly current after sales / future sync pushes. Errors are
  // swallowed — the count is decorative, not load-bearing.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try { const n = await countPendingInvoices(); if (!cancelled) setPendingCount(n); }
      catch { /* ignore */ }
    };
    void tick();
    const id = setInterval(tick, 10_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [view]); // re-poll immediately when user switches tabs

  // ─── Heartbeat every 30s while shell is mounted ─────────────────────
  // Note: heartbeat failures go into a separate `heartbeatErr` so they don't
  // wipe a meaningful error from a manual Pull/Deactivate action.
  useEffect(() => {
    const tick = async () => {
      try {
        await api.heartbeat({ appVersion: "0.1.0-dev" });
        const s = await api.status();
        setStatus(s);
        setHeartbeatErr(null);
      } catch (e: any) {
        setHeartbeatErr(e?.message ?? "heartbeat failed");
      }
    };
    void tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [api]);

  async function doPull() {
    setBusy("pull"); setActionErr(null);
    try {
      const r = await api.pull({ entities: ["customers", "items", "settings"] });
      setPulled({
        customers: r.entities.customers?.length ?? 0,
        items: r.entities.items?.length ?? 0,
      });
    } catch (e: any) { setActionErr(e?.message ?? "pull failed"); }
    finally { setBusy(null); }
  }

  async function doPush() {
    setBusy("push"); setActionErr(null); setPushSummary(null);
    try {
      const r = await syncPushNow(baseUrl, deviceToken);
      setPushSummary(r);
      // refresh badge immediately — synced rows leave the pending set
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

  return (
    <div dir="rtl" style={S.wrap}>
      <header style={S.header}>
        <div>
          <h1 style={S.title}>ZACOD POS</h1>
          {companyName && <div style={S.company}>{companyName}</div>}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={() => setView("sales")}
            style={view === "sales" ? S.tabActive : S.tab}
          >🛒 بيع</button>
          <button
            onClick={() => setView("pending")}
            style={view === "pending" ? S.tabActive : S.tab}
            aria-label={`الفواتير المعلّقة، ${pendingCount} فاتورة`}
          >
            📋 معلّقة
            {pendingCount > 0 && (
              <span style={S.badge} aria-live="polite" aria-atomic="true">
                {pendingCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setView("dashboard")}
            style={view === "dashboard" ? S.tabActive : S.tab}
          >📊 لوحة التحكم</button>
          <div style={S.mode}>
            {TAURI_MODE === "tauri" ? "🪟 أصلي" : "🌐 متصفح"}
          </div>
        </div>
      </header>

      {showPeripherals && <PeripheralsSettings onClose={() => setShowPeripherals(false)} />}

      {view === "sales" ? (
        <SalesScreen companyName={companyName} />
      ) : view === "pending" ? (
        <PendingInvoices companyName={companyName} />
      ) : (
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
          onShowPeripherals={() => setShowPeripherals(true)}
          onDeactivate={doDeactivate}
        />
      )}
    </div>
  );
}

type DashboardProps = {
  deviceId: number;
  status: SyncStatus | null;
  baseUrl: string;
  busy: string | null;
  pulled: { customers: number; items: number } | null;
  actionErr: string | null;
  heartbeatErr: string | null;
  onPull: () => void;
  onPush: () => void;
  pushSummary: PushSummary | null;
  onShowPeripherals: () => void;
  onDeactivate: () => void;
};

function DashboardView({ deviceId, status, baseUrl, busy, pulled, actionErr, heartbeatErr, onPull, onPush, pushSummary, onShowPeripherals, onDeactivate }: DashboardProps) {
  return (
    <div style={{ maxWidth: 920, margin: "0 auto", width: "100%" }}>
      <section style={S.card}>
        <h2 style={S.h2}>حالة المزامنة</h2>
        <KV k="معرّف الجهاز" v={String(deviceId || "—")} />
        <KV k="الحالة" v={status?.status ?? "..."} />
        <KV k="آخر نبضة" v={status?.lastHeartbeatAt ? new Date(status.lastHeartbeatAt).toLocaleString("ar-SA") : "—"} />
        <KV k="آخر مزامنة" v={status?.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString("ar-SA") : "—"} />
        <KV k="الخادم" v={baseUrl} mono />
      </section>

      <section style={S.card}>
        <h2 style={S.h2}>إجراءات</h2>
        <div style={S.btnRow}>
          <button onClick={onPull} disabled={busy === "pull"} style={S.btnPrimary}>
            {busy === "pull" ? "جارٍ السحب..." : "سحب البيانات (Pull)"}
          </button>
          <button onClick={onPush} disabled={busy === "push"} style={S.btnPrimary}>
            {busy === "push" ? "جارٍ الرفع..." : "⬆️ رفع الفواتير المعلّقة (Push)"}
          </button>
          <button onClick={onShowPeripherals} style={S.btnSecondary}>
            🖨️ الأجهزة الطرفية
          </button>
          <button onClick={onDeactivate} disabled={busy === "deactivate"} style={S.btnDanger}>
            {busy === "deactivate" ? "جارٍ الإلغاء..." : "إلغاء تفعيل الجهاز"}
          </button>
        </div>
        {pulled && (
          <div style={S.success}>
            ✅ تم السحب: {pulled.customers} عميل، {pulled.items} صنف
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
        <h2 style={S.h2}>الخطوات القادمة (Task #174 Steps 9-12)</h2>
        <ul style={{ lineHeight: 2, paddingInlineStart: 20, color: "#475569" }}>
          <li>استبدال هذه الشاشة بواجهة POS الكاملة (Step 10)</li>
          <li>قاعدة بيانات SQLite محلية + قائمة انتظار المزامنة (Step 9)</li>
          <li>توقيع ZATCA Phase 2 محلياً (Step 7 — يجري العمل)</li>
          <li>طابعة + درج النقود + قارئ الباركود (Step 9)</li>
          <li>التحديث التلقائي + توقيع الشهادة (Steps 11-12)</li>
        </ul>
      </section>
    </div>
  );
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #f1f5f9" }}>
    <span style={{ color: "#64748b", fontSize: 13 }}>{k}</span>
    <span style={{ fontFamily: mono ? "ui-monospace, monospace" : undefined, fontSize: mono ? 12 : 14, color: "#0f172a" }}>{v}</span>
  </div>;
}

const S = {
  wrap: { minHeight: "100vh", padding: "16px 24px 24px", fontFamily: "'Segoe UI', system-ui, sans-serif" } as const,
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 } as const,
  tab: { padding: "8px 14px", background: "#fff", color: "#475569", border: "1px solid #e2e8f0", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600, fontFamily: "inherit" } as const,
  tabActive: { padding: "8px 14px", background: "#0f172a", color: "#fff", border: "1px solid #0f172a", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600, fontFamily: "inherit" } as const,
  badge: { display: "inline-block", marginInlineStart: 6, padding: "1px 7px", background: "#dc2626", color: "#fff", borderRadius: 999, fontSize: 11, fontWeight: 700, lineHeight: 1.6 } as const,
  title: { margin: 0, fontSize: 28, color: "#0f172a" } as const,
  company: { fontSize: 14, color: "#64748b", marginTop: 4 } as const,
  mode: { fontSize: 11, padding: "4px 10px", background: "#f1f5f9", borderRadius: 999, color: "#475569" } as const,
  card: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: "0 1px 3px rgba(0,0,0,.04)" } as const,
  h2: { margin: "0 0 12px", fontSize: 16, color: "#0f172a" } as const,
  btnRow: { display: "flex", gap: 12, flexWrap: "wrap" } as const,
  btnPrimary: { padding: "10px 20px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 14, fontWeight: 600 } as const,
  btnDanger: { padding: "10px 20px", background: "#fff", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 6, cursor: "pointer", fontSize: 14, fontWeight: 600 } as const,
  btnSecondary: { padding: "10px 20px", background: "#fff", color: "#0f172a", border: "1px solid #cbd5e1", borderRadius: 6, cursor: "pointer", fontSize: 14, fontWeight: 600 } as const,
  success: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", padding: 12, borderRadius: 6, marginTop: 12, fontSize: 14 } as const,
  err: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: 12, borderRadius: 6, marginTop: 12, fontSize: 14 } as const,
};
