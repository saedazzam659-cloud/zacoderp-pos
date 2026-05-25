// UpdatesScreen — in-app updater.
//
// Calls GET /api/public/download/release?country=XX&platform=win-x64
// to find the latest published MSI, compares with the bundled app
// version, and offers a "Download & install" button.
//
// Behaviour:
//   • In Tauri mode: TODO — invoke('install_update') once the Rust
//     side wires Tauri Updater into main.rs. For now we open the
//     download URL in the system browser via `window.open`.
//   • In browser mode: opens the MSI URL directly so the user can
//     download it manually (or visit /download landing page).

import { useEffect, useMemo, useState } from "react";
import { TAURI_MODE } from "../lib/tauri-shim";

const APP_VERSION = "0.3.2";

type ReleaseInfo = {
  version: string;
  downloadUrl: string;
  fileSizeBytes: number | null;
  checksumSha256: string | null;
  releaseNotes: string | null;
  publishedAt: string;
  countryCode: string;
  platform: string;
  fallback?: boolean;
};

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/[^\d.]/g, "").split(".").map((n) => parseInt(n || "0", 10));
  const pb = b.replace(/[^\d.]/g, "").split(".").map((n) => parseInt(n || "0", 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0; const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function formatSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("ar-SA", { year: "numeric", month: "long", day: "numeric" });
  } catch { return iso; }
}

type Props = { baseUrl: string };

export default function UpdatesScreen({ baseUrl }: Props) {
  const country = useMemo(() => {
    return localStorage.getItem("pos_desktop_country") || "SA";
  }, []);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  const [downloading, setDownloading] = useState(false);

  async function check() {
    setLoading(true); setError(null);
    try {
      const url = `${baseUrl}/api/public/download/release?country=${encodeURIComponent(country)}&platform=win-x64`;
      const r = await fetch(url, { method: "GET" });
      if (r.status === 404) { setRelease(null); setLoading(false); return; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setRelease(data);
    } catch (e: any) {
      setError(e?.message ?? "تعذّر الاتصال بخادم التحديثات");
    } finally { setLoading(false); }
  }

  useEffect(() => { void check(); }, [country, baseUrl]);

  const hasUpdate = release && compareVersions(release.version, APP_VERSION) > 0;
  const isUpToDate = release && !hasUpdate;

  async function startDownload() {
    if (!release) return;
    setDownloading(true);
    try {
      // Open the MSI URL in a new tab / system browser.
      // Future: in TAURI_MODE, call invoke("install_update", { url }) once
      // Tauri Updater plugin is wired into the Rust side.
      window.open(release.downloadUrl, "_blank", "noopener,noreferrer");
    } finally {
      setTimeout(() => setDownloading(false), 1500);
    }
  }

  return (
    <div dir="rtl" style={S.wrap}>
      <header style={S.header}>
        <div>
          <h1 style={S.title}>التحديثات</h1>
          <p style={S.subtitle}>تحقّق من توفّر إصدار جديد من البرنامج وثبّته بضغطة واحدة</p>
        </div>
        <button style={S.refreshBtn} onClick={check} disabled={loading}>
          {loading ? "⏳ جارٍ التحقق…" : "🔄 إعادة الفحص"}
        </button>
      </header>

      {/* ── Current version card ────────────────────────────── */}
      <section style={S.card}>
        <div style={S.cardRow}>
          <div>
            <div style={S.cardLabel}>الإصدار الحالي المُثبَّت</div>
            <div style={S.cardValue}>v{APP_VERSION}</div>
          </div>
          <div style={S.statusChip(isUpToDate ? "success" : hasUpdate ? "warning" : "muted")}>
            {loading ? "…" : isUpToDate ? "✅ محدَّث" : hasUpdate ? "🆕 يتوفر تحديث" : "—"}
          </div>
        </div>
        <div style={S.meta}>
          <span>🪟 Windows 64-bit</span>
          <span>·</span>
          <span>🌍 الدولة: {country}</span>
          <span>·</span>
          <span>{TAURI_MODE ? "💻 وضع سطح المكتب" : "🌐 وضع المتصفح"}</span>
        </div>
      </section>

      {/* ── Error state ─────────────────────────────────────── */}
      {error && (
        <div style={S.errorBox}>
          ⚠️ {error}
          <div style={S.errorHint}>تأكد من اتصالك بالإنترنت ثم اضغط "إعادة الفحص"</div>
        </div>
      )}

      {/* ── No release configured ───────────────────────────── */}
      {!loading && !error && !release && (
        <div style={S.emptyBox}>
          <div style={S.emptyIcon}>📭</div>
          <div style={S.emptyTitle}>لا يوجد إصدار منشور لدولتك حالياً</div>
          <div style={S.emptyHint}>
            تواصل مع الدعم الفني أو راجع الإدارة لرفع إصدار خاص بدولتك ({country})
          </div>
        </div>
      )}

      {/* ── Release info + actions ──────────────────────────── */}
      {release && (
        <section style={S.releaseCard}>
          <div style={S.releaseHeader}>
            <div>
              <div style={S.releaseVersion}>v{release.version}</div>
              <div style={S.releaseDate}>📅 نُشر في {formatDate(release.publishedAt)}</div>
            </div>
            {release.fallback && (
              <div style={S.fallbackChip}>🌍 إصدار دولي عام</div>
            )}
          </div>

          {release.releaseNotes && (
            <div style={S.notes}>
              <div style={S.notesTitle}>📝 ملاحظات الإصدار</div>
              <div style={S.notesBody}>{release.releaseNotes}</div>
            </div>
          )}

          <div style={S.detailGrid}>
            <div style={S.detailItem}>
              <div style={S.detailLabel}>الحجم</div>
              <div style={S.detailValue}>{formatSize(release.fileSizeBytes)}</div>
            </div>
            <div style={S.detailItem}>
              <div style={S.detailLabel}>المنصة</div>
              <div style={S.detailValue}>{release.platform}</div>
            </div>
            <div style={S.detailItem}>
              <div style={S.detailLabel}>SHA-256</div>
              <div style={S.detailMono} title={release.checksumSha256 ?? ""}>
                {release.checksumSha256 ? release.checksumSha256.slice(0, 16) + "…" : "—"}
              </div>
            </div>
          </div>

          {hasUpdate ? (
            <button style={S.installBtn} onClick={startDownload} disabled={downloading}>
              {downloading ? "⏳ جارٍ فتح صفحة التنزيل…" : `⬇️ تنزيل وتثبيت الإصدار v${release.version}`}
            </button>
          ) : isUpToDate ? (
            <div style={S.upToDateBox}>
              ✅ أنت تستخدم آخر إصدار متاح
            </div>
          ) : null}

          <div style={S.installSteps}>
            <div style={S.installStepsTitle}>خطوات التثبيت بعد التنزيل:</div>
            <ol style={S.installList}>
              <li>أغلق التطبيق الحالي تماماً</li>
              <li>افتح ملف <code>.msi</code> الذي تم تنزيله</li>
              <li>اتبع معالج التثبيت (سيتم استبدال الإصدار القديم تلقائياً)</li>
              <li>افتح التطبيق — بياناتك المحلية ستبقى كما هي</li>
            </ol>
          </div>
        </section>
      )}

      {/* ── Footer note ─────────────────────────────────────── */}
      <div style={S.footerNote}>
        💡 التحديثات تجلب الميزات الجديدة وإصلاحات الأخطاء. بياناتك المخزَّنة محلياً (الفواتير،
        العملاء، الأصناف) محفوظة ولا تتأثر بالتحديث.
      </div>
    </div>
  );
}

const S = {
  wrap: {
    padding: 24, maxWidth: 1000, margin: "0 auto",
    fontFamily: "'Segoe UI', 'Cairo', system-ui, sans-serif",
  } as React.CSSProperties,
  header: {
    display: "flex", justifyContent: "space-between", alignItems: "flex-start",
    gap: 16, marginBottom: 24, flexWrap: "wrap" as const,
  } as React.CSSProperties,
  title: { fontSize: 28, fontWeight: 700, color: "#0f172a", margin: 0 } as React.CSSProperties,
  subtitle: { fontSize: 14, color: "#64748b", marginTop: 4 } as React.CSSProperties,
  refreshBtn: {
    padding: "10px 18px", border: "1px solid #cbd5e1", borderRadius: 8,
    background: "#fff", cursor: "pointer", fontSize: 14, fontWeight: 600,
    color: "#0f172a",
  } as React.CSSProperties,
  card: {
    background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12,
    padding: 20, marginBottom: 16, boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
  } as React.CSSProperties,
  cardRow: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 } as React.CSSProperties,
  cardLabel: { fontSize: 13, color: "#64748b", marginBottom: 4 } as React.CSSProperties,
  cardValue: { fontSize: 24, fontWeight: 700, color: "#0f172a" } as React.CSSProperties,
  statusChip: (kind: "success" | "warning" | "muted") => ({
    padding: "8px 14px", borderRadius: 999, fontSize: 13, fontWeight: 600,
    background: kind === "success" ? "#dcfce7" : kind === "warning" ? "#fef3c7" : "#f1f5f9",
    color: kind === "success" ? "#166534" : kind === "warning" ? "#92400e" : "#64748b",
  } as React.CSSProperties),
  meta: {
    marginTop: 16, paddingTop: 16, borderTop: "1px solid #f1f5f9",
    display: "flex", gap: 8, fontSize: 13, color: "#64748b", flexWrap: "wrap" as const,
  } as React.CSSProperties,
  errorBox: {
    background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b",
    borderRadius: 10, padding: 16, marginBottom: 16,
  } as React.CSSProperties,
  errorHint: { fontSize: 13, marginTop: 6, color: "#7f1d1d" } as React.CSSProperties,
  emptyBox: {
    background: "#fff", border: "2px dashed #e2e8f0", borderRadius: 12,
    padding: 40, textAlign: "center" as const,
  } as React.CSSProperties,
  emptyIcon: { fontSize: 48, marginBottom: 12 } as React.CSSProperties,
  emptyTitle: { fontSize: 16, fontWeight: 600, color: "#475569", marginBottom: 6 } as React.CSSProperties,
  emptyHint: { fontSize: 13, color: "#94a3b8" } as React.CSSProperties,
  releaseCard: {
    background: "linear-gradient(135deg, #f0f9ff 0%, #ffffff 100%)",
    border: "1px solid #bae6fd", borderRadius: 12, padding: 24, marginBottom: 16,
    boxShadow: "0 4px 12px rgba(14,165,233,0.08)",
  } as React.CSSProperties,
  releaseHeader: {
    display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16,
  } as React.CSSProperties,
  releaseVersion: { fontSize: 24, fontWeight: 700, color: "#0c4a6e" } as React.CSSProperties,
  releaseDate: { fontSize: 13, color: "#0369a1", marginTop: 4 } as React.CSSProperties,
  fallbackChip: {
    padding: "4px 10px", background: "#fef3c7", color: "#92400e",
    borderRadius: 999, fontSize: 12, fontWeight: 600,
  } as React.CSSProperties,
  notes: {
    background: "#fff", border: "1px solid #e0f2fe", borderRadius: 8,
    padding: 14, marginBottom: 16,
  } as React.CSSProperties,
  notesTitle: { fontSize: 13, fontWeight: 600, color: "#0369a1", marginBottom: 6 } as React.CSSProperties,
  notesBody: { fontSize: 14, color: "#334155", lineHeight: 1.6, whiteSpace: "pre-wrap" as const } as React.CSSProperties,
  detailGrid: {
    display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
    gap: 12, marginBottom: 20,
  } as React.CSSProperties,
  detailItem: {
    background: "#fff", border: "1px solid #e0f2fe", borderRadius: 8, padding: 12,
  } as React.CSSProperties,
  detailLabel: { fontSize: 11, color: "#64748b", marginBottom: 4 } as React.CSSProperties,
  detailValue: { fontSize: 14, fontWeight: 600, color: "#0f172a" } as React.CSSProperties,
  detailMono: { fontSize: 12, fontFamily: "monospace", color: "#0f172a" } as React.CSSProperties,
  installBtn: {
    width: "100%", padding: "14px 20px", border: "none", borderRadius: 10,
    background: "linear-gradient(135deg, #2563eb 0%, #1e40af 100%)",
    color: "#fff", fontSize: 16, fontWeight: 700, cursor: "pointer",
    boxShadow: "0 4px 12px rgba(37,99,235,0.3)",
  } as React.CSSProperties,
  upToDateBox: {
    background: "#dcfce7", color: "#166534", padding: 14, borderRadius: 10,
    textAlign: "center" as const, fontSize: 15, fontWeight: 600,
  } as React.CSSProperties,
  installSteps: {
    marginTop: 20, padding: 16, background: "#f8fafc", borderRadius: 8,
    border: "1px solid #e2e8f0",
  } as React.CSSProperties,
  installStepsTitle: { fontSize: 13, fontWeight: 600, color: "#475569", marginBottom: 8 } as React.CSSProperties,
  installList: {
    margin: 0, paddingInlineStart: 20, fontSize: 13, color: "#475569", lineHeight: 1.8,
  } as React.CSSProperties,
  footerNote: {
    background: "#fef3c7", border: "1px solid #fde68a", color: "#92400e",
    borderRadius: 10, padding: 14, fontSize: 13, lineHeight: 1.6, marginTop: 8,
  } as React.CSSProperties,
};
