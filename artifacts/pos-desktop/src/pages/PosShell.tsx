// Post-activation shell. Currently a status dashboard showing sync state +
// a "deactivate device" button for clean uninstall.
//
// TODO Step 10 of Task #174: replace with the real POS UI imported from
// artifacts/pos, swapping its API hooks for the local SQLite layer
// (src-tauri/src/db.rs) + sync queue (src-tauri/src/sync.rs).

import { useEffect, useMemo, useState } from "react";
import { createApi, type SyncStatus } from "../lib/api";
import { TAURI_MODE } from "../lib/tauri-shim";

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
        <div style={S.mode}>
          {TAURI_MODE === "tauri" ? "🪟 تطبيق أصلي" : "🌐 متصفح (تطوير)"}
        </div>
      </header>

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
          <button onClick={doPull} disabled={busy === "pull"} style={S.btnPrimary}>
            {busy === "pull" ? "جارٍ السحب..." : "سحب البيانات (Pull)"}
          </button>
          <button onClick={doDeactivate} disabled={busy === "deactivate"} style={S.btnDanger}>
            {busy === "deactivate" ? "جارٍ الإلغاء..." : "إلغاء تفعيل الجهاز"}
          </button>
        </div>
        {pulled && (
          <div style={S.success}>
            ✅ تم السحب: {pulled.customers} عميل، {pulled.items} صنف
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
  wrap: { maxWidth: 920, margin: "32px auto", padding: 24, fontFamily: "'Segoe UI', system-ui, sans-serif" } as const,
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 } as const,
  title: { margin: 0, fontSize: 28, color: "#0f172a" } as const,
  company: { fontSize: 14, color: "#64748b", marginTop: 4 } as const,
  mode: { fontSize: 11, padding: "4px 10px", background: "#f1f5f9", borderRadius: 999, color: "#475569" } as const,
  card: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: "0 1px 3px rgba(0,0,0,.04)" } as const,
  h2: { margin: "0 0 12px", fontSize: 16, color: "#0f172a" } as const,
  btnRow: { display: "flex", gap: 12, flexWrap: "wrap" } as const,
  btnPrimary: { padding: "10px 20px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 14, fontWeight: 600 } as const,
  btnDanger: { padding: "10px 20px", background: "#fff", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 6, cursor: "pointer", fontSize: 14, fontWeight: 600 } as const,
  success: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", padding: 12, borderRadius: 6, marginTop: 12, fontSize: 14 } as const,
  err: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: 12, borderRadius: 6, marginTop: 12, fontSize: 14 } as const,
};
