// UpdatesScreen — in-app updater with Microsoft-style progress bar.
//
// Flow:
//   1. GET /api/public/download/release?country=XX&platform=win-x64
//      → finds the latest published MSI for the user's country.
//   2. Compares with __APP_VERSION__ (injected from package.json at
//      build time). If newer, shows the "تنزيل وتثبيت" button.
//   3. Clicking the button calls the Rust command
//      `download_and_install_update` which streams the MSI to %TEMP%,
//      emits `updater://progress` events (we render a progress bar),
//      verifies the SHA-256, then spawns `msiexec /passive` and exits
//      the app so Windows can replace the binaries.
//
// In browser mode we fall back to opening the MSI URL in a new tab
// since there's no Tauri runtime to launch msiexec.

import { useEffect, useMemo, useRef, useState } from "react";
import { TAURI_MODE, invoke } from "../lib/tauri-shim";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

const APP_VERSION = __APP_VERSION__;

// Public update server. In standalone mode the app has NO `baseUrl`
// (no cloud tenant), so update checks would otherwise hit a relative
// path — under Tauri that resolves to the bundled SPA and returns
// index.html, breaking `JSON.parse` with "Unexpected token '<'".
// Override at build time with `VITE_UPDATE_SERVER_URL` if the public
// download host ever moves.
const PUBLIC_UPDATE_SERVER =
  ((import.meta.env.VITE_UPDATE_SERVER_URL ?? "") as string).trim()
  || "https://zacoderp.com";

function resolveUpdateBase(baseUrl: string): string {
  const b = (baseUrl || "").trim();
  if (!b) return PUBLIC_UPDATE_SERVER;
  // Tauri/file/asset origins can't serve the API — fall back to public.
  if (/^(tauri|file|asset):/i.test(b)) return PUBLIC_UPDATE_SERVER;
  return b.replace(/\/+$/, "");
}

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

type Phase = "idle" | "downloading" | "verifying" | "launching" | "done" | "error";

export default function UpdatesScreen({ baseUrl }: Props) {
  const country = useMemo(() => {
    return localStorage.getItem("pos_desktop_country") || "SA";
  }, []);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [release, setRelease] = useState<ReleaseInfo | null>(null);

  // Update flow state
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState({ downloaded: 0, total: 0, percent: 0 });
  const [installError, setInstallError] = useState<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const exitUnlistenRef = useRef<UnlistenFn | null>(null);

  async function check() {
    setLoading(true); setError(null);
    try {
      const base = resolveUpdateBase(baseUrl);
      const url = `${base}/api/public/download/release?country=${encodeURIComponent(country)}&platform=win-x64`;
      const r = await fetch(url, { method: "GET" });
      if (r.status === 404) { setRelease(null); setLoading(false); return; }
      if (!r.ok) throw new Error(`HTTP ${r.status} من ${base}`);
      // Defensive parse: some hosts (incl. SPA fallbacks) return HTML
      // with a 200 status. Detect that explicitly so the user sees a
      // helpful message instead of "Unexpected token '<'".
      const text = await r.text();
      const trimmed = text.trimStart();
      if (trimmed.startsWith("<")) {
        throw new Error(`خادم التحديثات أرجع صفحة HTML بدلاً من JSON (${base}) — تحقق من عنوان الخادم`);
      }
      const data = JSON.parse(text);
      setRelease(data);
    } catch (e: any) {
      setError(e?.message ?? "تعذّر الاتصال بخادم التحديثات");
    } finally { setLoading(false); }
  }

  useEffect(() => { void check(); }, [country, baseUrl]);

  // Detach event listeners on unmount.
  useEffect(() => {
    return () => {
      unlistenRef.current?.();
      exitUnlistenRef.current?.();
    };
  }, []);

  const hasUpdate = release && compareVersions(release.version, APP_VERSION) > 0;
  const isUpToDate = release && !hasUpdate;

  async function startInstall() {
    if (!release) return;
    setInstallError(null);

    // Browser mode → fall back to opening the URL.
    if (!TAURI_MODE) {
      window.open(release.downloadUrl, "_blank", "noopener,noreferrer");
      return;
    }

    setPhase("downloading");
    setProgress({ downloaded: 0, total: release.fileSizeBytes ?? 0, percent: 0 });

    // Subscribe to progress + exit-imminent events. Both unlisten functions
    // are stored in refs so we can detach on unmount.
    try {
      unlistenRef.current = await listen<{ downloaded: number; total: number; percent: number }>(
        "updater://progress",
        (e) => setProgress(e.payload),
      );
      exitUnlistenRef.current = await listen("updater://exiting", () => setPhase("launching"));
    } catch (e: any) {
      setInstallError(`فشل ربط أحداث التحديث: ${e?.message ?? e}`);
    }

    try {
      await invoke("download_and_install_update", {
        url: release.downloadUrl,
        expectedSha256: release.checksumSha256 ?? null,
        version: release.version,
      });
      // If we reach here without the app exiting, the installer has been
      // spawned and we're moments away from process.exit(0).
      setPhase("launching");
    } catch (e: any) {
      const msg = typeof e === "string" ? e : (e?.message ?? String(e));
      setInstallError(msg);
      setPhase("error");
    }
  }

  const installing = phase === "downloading" || phase === "verifying" || phase === "launching";

  return (
    <div dir="rtl" style={S.wrap}>
      <header style={S.header}>
        <div>
          <h1 style={S.title}>التحديثات</h1>
          <p style={S.subtitle}>تحقّق من توفّر إصدار جديد من البرنامج وثبّته بضغطة واحدة</p>
        </div>
        <button style={S.refreshBtn} onClick={check} disabled={loading || installing}>
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

      {error && (
        <div style={S.errorBox}>
          ⚠️ {error}
          <div style={S.errorHint}>تأكد من اتصالك بالإنترنت ثم اضغط "إعادة الفحص"</div>
        </div>
      )}

      {!loading && !error && !release && (
        <div style={S.emptyBox}>
          <div style={S.emptyIcon}>📭</div>
          <div style={S.emptyTitle}>لا يوجد إصدار منشور لدولتك حالياً</div>
          <div style={S.emptyHint}>
            تواصل مع الدعم الفني أو راجع الإدارة لرفع إصدار خاص بدولتك ({country})
          </div>
        </div>
      )}

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

          <div style={S.notes}>
            <div style={S.notesTitle}>🖥️ نظام نقاط بيع متكامل لسطح المكتب</div>
            <div style={S.notesBody}>
              حلٌّ احترافي شامل يدير دورة عملك بالكامل — من المبيعات حتى المحاسبة — في منظومة واحدة،
              يعمل أونلاين وأوفلاين بمزامنة سحابية فورية لتظل بياناتك محدّثة في كل فروعك.
            </div>
            <ul style={S.featureList}>
              {[
                "إدارة المبيعات والمشتريات والمخزون",
                "فواتير ضريبية متوافقة مع هيئة الزكاة (ZATCA)",
                "تقارير محاسبية ومالية لحظية",
                "دعم الموازين الإلكترونية وقارئ الباركود",
                "تعدد الفروع والكاشيرات والعملات",
                "يعمل بدون إنترنت مع مزامنة تلقائية عند الاتصال",
              ].map((f) => (
                <li key={f} style={S.featureItem}>✅ {f}</li>
              ))}
            </ul>
            <div style={S.credit}>تطوير فريق عمل متكامل تحت إدارة م/ كرم عزام</div>
          </div>

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

          {/* ── Install action / progress UI ──────────────── */}
          {hasUpdate && phase === "idle" && (
            <button style={S.installBtn} onClick={startInstall}>
              ⬇️ تنزيل وتثبيت الإصدار v{release.version}
            </button>
          )}

          {installing && (
            <div style={S.progressWrap}>
              <div style={S.progressLabel}>
                <span>
                  {phase === "launching"
                    ? "🚀 جارٍ تشغيل المثبّت…"
                    : `⬇️ جارٍ التنزيل… ${progress.percent}%`}
                </span>
                <span style={S.progressBytes}>
                  {formatSize(progress.downloaded)} / {formatSize(progress.total || release.fileSizeBytes)}
                </span>
              </div>
              <div style={S.progressTrack}>
                <div
                  style={{
                    ...S.progressFill,
                    width: `${Math.max(2, progress.percent)}%`,
                    background:
                      phase === "launching"
                        ? "linear-gradient(90deg, #16a34a, #15803d)"
                        : "linear-gradient(90deg, #2563eb, #1d4ed8)",
                  }}
                />
              </div>
              {phase === "launching" && (
                <div style={S.launchingHint}>
                  سيُغلق التطبيق تلقائياً ليتمّ التثبيت. افتحه من جديد بعد انتهاء معالج Windows.
                </div>
              )}
            </div>
          )}

          {phase === "error" && installError && (
            <div style={S.errorBox}>
              ⚠️ فشل التحديث: {installError}
              <div style={{ marginTop: 10 }}>
                <button style={S.retryBtn} onClick={() => { setPhase("idle"); setInstallError(null); }}>
                  🔁 إعادة المحاولة
                </button>
                <a href={release.downloadUrl} target="_blank" rel="noreferrer" style={S.manualLink}>
                  تنزيل يدوي
                </a>
              </div>
            </div>
          )}

          {isUpToDate && phase === "idle" && (
            <div style={S.upToDateBox}>
              ✅ أنت تستخدم آخر إصدار متاح
            </div>
          )}

          <div style={S.installSteps}>
            <div style={S.installStepsTitle}>ماذا يحدث بعد الضغط على زر التحديث:</div>
            <ol style={S.installList}>
              <li>يبدأ التنزيل داخل البرنامج مع شريط تقدّم مباشر</li>
              <li>يتم التحقّق من سلامة الملف (SHA-256)</li>
              <li>يُغلق التطبيق ويبدأ معالج Windows في تثبيت الإصدار الجديد</li>
              <li>افتح التطبيق من جديد — بياناتك المحلية محفوظة</li>
            </ol>
          </div>
        </section>
      )}

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
  featureList: {
    listStyle: "none", margin: "12px 0 0", padding: 0,
    display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8,
  } as React.CSSProperties,
  featureItem: { fontSize: 13, color: "#334155", lineHeight: 1.7 } as React.CSSProperties,
  credit: {
    marginTop: 14, paddingTop: 10, borderTop: "1px solid #e0f2fe",
    fontSize: 12, color: "#64748b", fontWeight: 600, textAlign: "center" as const,
  } as React.CSSProperties,
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
  progressWrap: {
    padding: 16, background: "#fff", border: "1px solid #bfdbfe",
    borderRadius: 10, marginTop: 4,
  } as React.CSSProperties,
  progressLabel: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    fontSize: 14, fontWeight: 600, color: "#1e3a8a", marginBottom: 10,
  } as React.CSSProperties,
  progressBytes: { fontSize: 12, color: "#64748b", fontFamily: "ui-monospace, monospace" } as React.CSSProperties,
  progressTrack: {
    width: "100%", height: 14, background: "#e2e8f0", borderRadius: 999, overflow: "hidden",
  } as React.CSSProperties,
  progressFill: {
    height: "100%", borderRadius: 999, transition: "width 200ms ease-out",
    background: "linear-gradient(90deg, #2563eb, #1d4ed8)",
  } as React.CSSProperties,
  launchingHint: {
    marginTop: 12, padding: 10, background: "#f0fdf4", border: "1px solid #bbf7d0",
    color: "#166534", borderRadius: 8, fontSize: 13, fontWeight: 600,
  } as React.CSSProperties,
  retryBtn: {
    padding: "8px 16px", background: "#fff", color: "#991b1b",
    border: "1px solid #fecaca", borderRadius: 8, cursor: "pointer",
    fontSize: 13, fontWeight: 600, marginInlineEnd: 12,
  } as React.CSSProperties,
  manualLink: { color: "#2563eb", fontWeight: 600, fontSize: 13, textDecoration: "underline" } as React.CSSProperties,
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
