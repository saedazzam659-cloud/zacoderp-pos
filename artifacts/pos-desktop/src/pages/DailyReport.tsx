// Daily Z-Report — صافي المبيعات بعد المرتجعات.
//
// Reads from the LOCAL SQLite store (via lib/dailyReport.ts) so it works
// fully offline. Aggregates sales + returns + payment mix + hourly chart
// + top items, all in the frontend. The cashier picks a date (today by
// default) and can print a clean A4 receipt-style summary.
//
// Design goals:
//   • "جذاب" — strong gradient KPI tiles, RTL Arabic-first typography.
//   • Print-friendly — `@media print` rules in <style> below hide chrome
//     and let the receipt stretch full width.
//   • Self-contained — no chart libraries (CSS bars), no API calls.

import { useEffect, useMemo, useState } from "react";
import { buildDailyReport, todayLocalYmd, type DailyReport } from "../lib/dailyReport";

type Props = { companyName?: string; cashierName?: string };

export default function DailyReportPage({ companyName, cashierName }: Props) {
  const [date, setDate] = useState<string>(todayLocalYmd());
  const [data, setData] = useState<DailyReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load(d: string) {
    setLoading(true); setErr(null);
    try { setData(await buildDailyReport(d)); }
    catch (e: any) { setErr(e?.message ?? "فشل تحميل التقرير"); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(date); }, [date]);

  const hasData = data && (data.invoiceCount + data.returnCount) > 0;

  return (
    <div dir="rtl" style={S.wrap}>
      <style>{PRINT_CSS}</style>

      {/* ── Header / controls ── */}
      <div style={S.header} className="no-print">
        <div>
          <h1 style={S.h1}>📊 تقرير اليومية</h1>
          <div style={S.sub}>
            صافي المبيعات بعد المرتجعات — مصدر البيانات: قاعدة البيانات المحلية
          </div>
        </div>
        <div style={S.controls}>
          <button onClick={() => setDate(todayLocalYmd())} style={S.btnGhost} title="اليوم">
            اليوم
          </button>
          <button onClick={() => shiftDate(date, -1, setDate)} style={S.btnGhost} title="اليوم السابق">
            ◀
          </button>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={S.dateInput}
          />
          <button onClick={() => shiftDate(date, 1, setDate)} style={S.btnGhost} title="اليوم التالي">
            ▶
          </button>
          <button onClick={() => load(date)} style={S.btnGhost} title="تحديث" disabled={loading}>
            {loading ? "..." : "🔄"}
          </button>
          <button onClick={() => window.print()} style={S.btnPrimary} disabled={!hasData}>
            🖨️ طباعة
          </button>
        </div>
      </div>

      {/* ── Print header (only visible on print) ── */}
      <div className="print-only" style={S.printHeader}>
        <div style={S.printTitle}>تقرير اليومية — Z Report</div>
        <div style={S.printMeta}>
          {companyName && <div>{companyName}</div>}
          <div>التاريخ: {formatArabicDate(date)}</div>
          {cashierName && <div>الكاشير: {cashierName}</div>}
          <div>وقت الطباعة: {new Date().toLocaleString("ar-SA")}</div>
        </div>
      </div>

      {err && <div style={S.errBox}>⚠️ {err}</div>}

      {loading && !data && <div style={S.loadingBox}>جارٍ التحميل...</div>}

      {data && !hasData && (
        <div style={S.emptyBox}>
          <div style={{ fontSize: 56, marginBottom: 12 }}>📭</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#0f172a" }}>
            لا توجد فواتير في هذا اليوم
          </div>
          <div style={S.sub}>جرّب تاريخاً آخر أو تأكد من سحب البيانات.</div>
        </div>
      )}

      {data && hasData && (
        <>
          {/* ── KPI tiles row ── */}
          <div style={S.kpiGrid}>
            <KpiTile
              icon="💰"
              label="إجمالي المبيعات"
              value={fmtSar(data.salesGross)}
              hint={`${data.invoiceCount} فاتورة`}
              gradient="linear-gradient(135deg, #16a34a 0%, #15803d 100%)"
            />
            <KpiTile
              icon="↩️"
              label="إجمالي المرتجعات"
              value={fmtSar(data.returnsGross)}
              hint={`${data.returnCount} مرتجع`}
              gradient="linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)"
            />
            <KpiTile
              icon="🎯"
              label="صافي المبيعات"
              value={fmtSar(data.net)}
              hint="مبيعات − مرتجعات"
              gradient="linear-gradient(135deg, #2563eb 0%, #1e3a8a 100%)"
              big
            />
            <KpiTile
              icon="📈"
              label="متوسط الفاتورة"
              value={fmtSar(data.averageInvoice)}
              hint="على المبيعات فقط"
              gradient="linear-gradient(135deg, #a855f7 0%, #6b21a8 100%)"
            />
          </div>

          {/* ── Breakdown row: VAT + payments + sync ── */}
          <div style={S.row2}>
            <Panel title="ملخّص ضريبة القيمة المضافة">
              <Row k="مبيعات بدون ضريبة" v={fmtSar(data.salesGross - data.salesVat)} />
              <Row k="ضريبة المبيعات (15%)" v={fmtSar(data.salesVat)} />
              <Row k="مرتجعات بدون ضريبة" v={fmtSar(data.returnsGross - data.returnsVat)} muted />
              <Row k="ضريبة المرتجعات (15%)" v={fmtSar(data.returnsVat)} muted />
              <Divider />
              <Row k="صافي الضريبة المستحقة" v={fmtSar(data.salesVat - data.returnsVat)} strong />
            </Panel>

            <Panel title="طُرق الدفع">
              <PaymentBar
                label="نقدي 💵"
                sales={data.cashSales}
                returns={data.cashReturns}
                color="#16a34a"
              />
              <PaymentBar
                label="بطاقة 💳"
                sales={data.cardSales}
                returns={data.cardReturns}
                color="#2563eb"
              />
              <Divider />
              <Row
                k="إجمالي النقد في الدُرج (تقديري)"
                v={fmtSar(data.cashSales - data.cashReturns)}
                strong
              />
            </Panel>

            <Panel title="حالة المزامنة مع السحابة">
              <Row k="مُرفوعة إلى السحابة" v={String(data.syncedCount)} />
              <Row k="قيد الرفع (محلياً فقط)" v={String(data.pendingCount)} muted />
              <Divider />
              <div style={S.syncProgressOuter}>
                <div
                  style={{
                    ...S.syncProgressInner,
                    width: `${syncPct(data)}%`,
                  }}
                />
              </div>
              <div style={{ ...S.sub, textAlign: "center", marginTop: 6 }}>
                {syncPct(data)}% مكتمل
              </div>
            </Panel>
          </div>

          {/* ── Hourly chart ── */}
          <Panel title="المبيعات حسب الساعة">
            <HourlyChart hours={data.hours} />
          </Panel>

          {/* ── Top items + invoice list ── */}
          <div style={S.row2}>
            <Panel title="أكثر الأصناف مبيعاً">
              {data.topItems.length === 0 ? (
                <div style={S.sub}>لا توجد أصناف.</div>
              ) : (
                <table style={S.table}>
                  <thead>
                    <tr>
                      <th style={S.thRight}>#</th>
                      <th style={S.thRight}>الصنف</th>
                      <th style={S.thLeft}>الكمية</th>
                      <th style={S.thLeft}>القيمة</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topItems.map((it, idx) => (
                      <tr key={it.itemId}>
                        <td style={S.td}>{idx + 1}</td>
                        <td style={S.td}>{it.nameAr}</td>
                        <td style={{ ...S.td, textAlign: "left" }}>{fmtNum(it.qty)}</td>
                        <td style={{ ...S.td, textAlign: "left", fontWeight: 600, color: it.amount < 0 ? "#dc2626" : "#0f172a" }}>
                          {fmtSar(it.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>

            <Panel title={`الفواتير (${data.invoices.length})`}>
              <div style={{ maxHeight: 360, overflowY: "auto" }}>
                <table style={S.table}>
                  <thead>
                    <tr>
                      <th style={S.thRight}>الرقم</th>
                      <th style={S.thRight}>الوقت</th>
                      <th style={S.thRight}>النوع</th>
                      <th style={S.thRight}>الدفع</th>
                      <th style={S.thLeft}>المبلغ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.invoices.map((inv, i) => (
                      <tr key={i}>
                        <td style={{ ...S.td, fontFamily: "ui-monospace, monospace", fontSize: 11 }}>
                          {inv.invoiceNo}
                        </td>
                        <td style={{ ...S.td, fontSize: 11, color: "#64748b" }}>
                          {formatTime(inv.createdAt)}
                        </td>
                        <td style={S.td}>
                          {inv.kind === "return" ? (
                            <span style={S.tagReturn}>مرتجع</span>
                          ) : (
                            <span style={S.tagSale}>بيع</span>
                          )}
                        </td>
                        <td style={{ ...S.td, fontSize: 11 }}>
                          {inv.paymentMethod === "cash" ? "نقدي" : inv.paymentMethod === "card" ? "بطاقة" : "—"}
                        </td>
                        <td style={{
                          ...S.td, textAlign: "left", fontWeight: 600,
                          color: inv.kind === "return" ? "#dc2626" : "#0f172a",
                        }}>
                          {inv.kind === "return" ? "−" : ""}{fmtSar(inv.grandTotal)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>

          {/* ── Print footer signatures ── */}
          <div className="print-only" style={S.printFooter}>
            <div style={S.sigBox}>
              <div style={S.sigLabel}>توقيع الكاشير</div>
            </div>
            <div style={S.sigBox}>
              <div style={S.sigLabel}>توقيع المسؤول</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────

function KpiTile({
  icon, label, value, hint, gradient, big,
}: { icon: string; label: string; value: string; hint?: string; gradient: string; big?: boolean }) {
  return (
    <div style={{
      ...S.kpi,
      background: gradient,
      gridColumn: big ? "span 1" : undefined,
      transform: big ? "scale(1.02)" : undefined,
      boxShadow: big ? "0 12px 30px rgba(37,99,235,.35)" : "0 6px 16px rgba(0,0,0,.12)",
    }}>
      <div style={S.kpiIcon}>{icon}</div>
      <div style={S.kpiLabel}>{label}</div>
      <div style={S.kpiValue}>{value}</div>
      {hint && <div style={S.kpiHint}>{hint}</div>}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={S.panel}>
      <h3 style={S.panelTitle}>{title}</h3>
      {children}
    </section>
  );
}

function Row({ k, v, muted, strong }: { k: string; v: string; muted?: boolean; strong?: boolean }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between",
      padding: "8px 0", borderBottom: "1px dashed #e2e8f0",
      fontSize: strong ? 15 : 13,
      color: muted ? "#94a3b8" : "#0f172a",
      fontWeight: strong ? 700 : 500,
    }}>
      <span>{k}</span>
      <span style={{ fontFamily: "ui-monospace, monospace" }}>{v}</span>
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: "#e2e8f0", margin: "8px 0" }} />;
}

function PaymentBar({ label, sales, returns, color }: { label: string; sales: number; returns: number; color: string }) {
  const net = sales - returns;
  const max = Math.max(sales, 1);
  const pct = Math.min(100, (net / max) * 100);
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 13 }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span style={{ fontFamily: "ui-monospace, monospace", fontWeight: 700, color }}>
          {fmtSar(net)}
        </span>
      </div>
      <div style={S.barOuter}>
        <div style={{ ...S.barInner, width: `${pct}%`, background: color }} />
      </div>
      <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>
        بيع: {fmtSar(sales)} · مرتجع: {fmtSar(returns)}
      </div>
    </div>
  );
}

function HourlyChart({ hours }: { hours: { hour: number; sales: number; returns: number; count: number }[] }) {
  const max = Math.max(1, ...hours.map((h) => h.sales));
  // Trim outer empty hours for compactness — show from first activity to last.
  const first = hours.findIndex((h) => h.count > 0);
  const lastIdx = hours.length - 1 - [...hours].reverse().findIndex((h) => h.count > 0);
  const lo = first === -1 ? 8 : Math.max(0, first - 1);
  const hi = first === -1 ? 20 : Math.min(23, lastIdx + 1);
  const slice = hours.slice(lo, hi + 1);

  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 180, padding: "10px 4px 0" }}>
      {slice.map((h) => {
        const ph = (h.sales / max) * 100;
        const rh = (h.returns / max) * 100;
        return (
          <div key={h.hour} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, height: "100%" }}>
            <div style={{
              flex: 1, width: "100%",
              display: "flex", flexDirection: "column", justifyContent: "flex-end",
              gap: 2, position: "relative",
            }}>
              {h.sales > 0 && (
                <div title={`بيع: ${fmtSar(h.sales)}`} style={{
                  height: `${Math.max(2, ph)}%`,
                  background: "linear-gradient(180deg, #22c55e 0%, #15803d 100%)",
                  borderRadius: "6px 6px 0 0",
                }} />
              )}
              {h.returns > 0 && (
                <div title={`مرتجع: ${fmtSar(h.returns)}`} style={{
                  height: `${Math.max(2, rh)}%`,
                  background: "linear-gradient(180deg, #f87171 0%, #b91c1c 100%)",
                  borderRadius: "6px 6px 0 0",
                  opacity: 0.85,
                }} />
              )}
            </div>
            <div style={{ fontSize: 10, color: "#64748b", fontFamily: "ui-monospace, monospace" }}>
              {String(h.hour).padStart(2, "0")}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

function fmtSar(n: number): string {
  const v = Math.abs(n).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? "−" : ""}${v} ر.س`;
}
function fmtNum(n: number): string {
  return n.toLocaleString("ar-EG", { maximumFractionDigits: 3 });
}
function formatTime(iso: string): string {
  try { return new Date(iso).toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" }); }
  catch { return iso; }
}
function formatArabicDate(ymd: string): string {
  try { return new Date(`${ymd}T00:00:00`).toLocaleDateString("ar-SA", { year: "numeric", month: "long", day: "numeric", weekday: "long" }); }
  catch { return ymd; }
}
function shiftDate(ymd: string, deltaDays: number, set: (s: string) => void) {
  const d = new Date(`${ymd}T00:00:00`);
  d.setDate(d.getDate() + deltaDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  set(`${y}-${m}-${day}`);
}
function syncPct(d: DailyReport): number {
  const total = d.syncedCount + d.pendingCount;
  if (total === 0) return 0;
  return Math.round((d.syncedCount / total) * 100);
}

// ── Styles ─────────────────────────────────────────────────────────────

const PRINT_CSS = `
  @media print {
    body { background: white !important; }
    .no-print { display: none !important; }
    .print-only { display: block !important; }
    @page { size: A4; margin: 1.2cm; }
  }
  .print-only { display: none; }
`;

const S = {
  wrap: { maxWidth: 1400, margin: "0 auto", width: "100%", padding: "8px 4px 24px" } as const,

  header: {
    display: "flex", justifyContent: "space-between", alignItems: "flex-end",
    marginBottom: 16, gap: 16, flexWrap: "wrap" as const,
  } as const,
  h1: { fontSize: 24, fontWeight: 800, color: "#0f172a", margin: 0 } as const,
  sub: { fontSize: 12, color: "#64748b", marginTop: 4 } as const,

  controls: { display: "flex", gap: 8, alignItems: "center" } as const,
  dateInput: {
    padding: "8px 10px", border: "1px solid #cbd5e1", borderRadius: 8,
    fontSize: 14, fontFamily: "inherit", background: "#fff",
  } as const,
  btnGhost: {
    padding: "8px 14px", background: "#fff",
    border: "1px solid #cbd5e1", borderRadius: 8,
    cursor: "pointer", fontSize: 13, fontFamily: "inherit", color: "#334155",
  } as const,
  btnPrimary: {
    padding: "8px 16px",
    background: "linear-gradient(135deg, #2563eb 0%, #1e3a8a 100%)",
    border: "none", borderRadius: 8, color: "#fff",
    cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit",
    boxShadow: "0 2px 6px rgba(37,99,235,.3)",
  } as const,

  errBox: {
    padding: 14, background: "#fef2f2", border: "1px solid #fecaca",
    color: "#991b1b", borderRadius: 8, marginBottom: 16, fontSize: 13,
  } as const,
  loadingBox: {
    padding: 40, textAlign: "center" as const, color: "#64748b",
    background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12,
  } as const,
  emptyBox: {
    padding: 60, textAlign: "center" as const,
    background: "#fff", border: "1px dashed #cbd5e1", borderRadius: 12,
  } as const,

  // KPI tiles
  kpiGrid: {
    display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 14, marginBottom: 16,
  } as const,
  kpi: {
    padding: "20px 18px", borderRadius: 14, color: "#fff",
    display: "flex", flexDirection: "column" as const, gap: 4,
    position: "relative" as const, overflow: "hidden" as const,
  } as const,
  kpiIcon: { fontSize: 26, opacity: 0.9 } as const,
  kpiLabel: { fontSize: 13, opacity: 0.9, fontWeight: 500 } as const,
  kpiValue: { fontSize: 26, fontWeight: 800, fontFamily: "ui-monospace, monospace", letterSpacing: -0.5 } as const,
  kpiHint: { fontSize: 11, opacity: 0.8, marginTop: 2 } as const,

  // Panels
  row2: {
    display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
    gap: 14, marginBottom: 16,
  } as const,
  panel: {
    background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12,
    padding: 16, boxShadow: "0 1px 3px rgba(0,0,0,.03)", marginBottom: 16,
  } as const,
  panelTitle: { fontSize: 14, fontWeight: 700, color: "#0f172a", margin: "0 0 12px" } as const,

  // Bars
  barOuter: {
    width: "100%", height: 10, background: "#f1f5f9",
    borderRadius: 999, overflow: "hidden" as const,
  } as const,
  barInner: { height: "100%", borderRadius: 999, transition: "width .3s" } as const,

  // Sync progress
  syncProgressOuter: {
    width: "100%", height: 8, background: "#e2e8f0", borderRadius: 999,
    overflow: "hidden" as const, marginTop: 8,
  } as const,
  syncProgressInner: {
    height: "100%",
    background: "linear-gradient(90deg, #22c55e 0%, #16a34a 100%)",
    borderRadius: 999,
  } as const,

  // Table
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: 13 } as const,
  thRight: {
    textAlign: "right" as const, padding: "8px 6px",
    borderBottom: "2px solid #e2e8f0", fontSize: 12, color: "#64748b", fontWeight: 600,
  } as const,
  thLeft: {
    textAlign: "left" as const, padding: "8px 6px",
    borderBottom: "2px solid #e2e8f0", fontSize: 12, color: "#64748b", fontWeight: 600,
  } as const,
  td: {
    padding: "8px 6px", borderBottom: "1px solid #f1f5f9",
    fontSize: 13, color: "#0f172a", textAlign: "right" as const,
  } as const,
  tagSale: {
    padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600,
    background: "#dcfce7", color: "#15803d",
  } as const,
  tagReturn: {
    padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600,
    background: "#fee2e2", color: "#b91c1c",
  } as const,

  // Print-only
  printHeader: {
    borderBottom: "2px solid #0f172a", paddingBottom: 12, marginBottom: 16,
  } as const,
  printTitle: { fontSize: 22, fontWeight: 800, marginBottom: 8 } as const,
  printMeta: { fontSize: 12, color: "#334155", display: "flex", gap: 20, flexWrap: "wrap" as const } as const,
  printFooter: {
    marginTop: 40, display: "flex", justifyContent: "space-between", gap: 40,
  } as const,
  sigBox: {
    flex: 1, borderTop: "1px solid #0f172a",
    paddingTop: 6, textAlign: "center" as const,
  } as const,
  sigLabel: { fontSize: 12, color: "#64748b" } as const,
};
