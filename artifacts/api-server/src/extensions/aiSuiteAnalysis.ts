import { coreList } from "./coreDataApi.js";
import type { ExtensionManifest } from "./manifest.js";
import type { ExtensionContext } from "./registry.js";
import { chatJSON, isAIAvailable } from "../lib/aiClient.js";

// ─────────────────────────────────────────────────────────────────────────
// AI CFO / AI Auditor / AI Monitoring analysis engines.
//
// Every one of these reads core data ONLY through the gated `coreList` gateway:
//   • permission-checked against the ai-suite SIGNED manifest,
//   • tenant-scoped (company_id forced server-side),
//   • column-projected (no secret/internal fields).
// The numeric analysis is fully deterministic (rule-based); an optional AI
// overlay enriches the narrative/recommendations. If AI is unavailable or
// fails, the rule-based result is returned unchanged (`source: "rules"`).
// ─────────────────────────────────────────────────────────────────────────

type Source = "ai" | "rules";

interface InvoiceRow {
  id: number;
  invoiceNumber: string | null;
  invoiceType: string | null;
  status: string | null;
  issueDate: string | null;
  currency: string | null;
  grandTotal: unknown;
  vatTotal: unknown;
}

interface AccountRow {
  id: number;
  code: string | null;
  nameAr: string | null;
  accountType: string | null;
  isPosting: boolean | null;
  isActive: boolean | null;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function monthKey(issueDate: string | null): string | null {
  if (!issueDate) return null;
  const s = String(issueDate);
  // Accept "YYYY-MM-DD..." or ISO; take the year-month prefix.
  const m = s.match(/^(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : null;
}

// ── AI CFO ────────────────────────────────────────────────────────────────
export interface CfoResult {
  source: Source;
  kpis: {
    invoiceCount: number;
    totalRevenue: number;
    totalVat: number;
    netRevenue: number;
    avgInvoice: number;
    maxInvoice: number;
  };
  trend: Array<{ month: string; revenue: number; count: number }>;
  statusBreakdown: Array<{ status: string; count: number; total: number }>;
  narrative: string;
  recommendations: string[];
}

export async function analyzeCfo(manifest: ExtensionManifest, ctx: ExtensionContext): Promise<CfoResult> {
  const invoices = (await coreList(manifest, ctx, "invoices", { limit: 500 })) as InvoiceRow[];

  const totals = invoices.map((i) => num(i.grandTotal));
  const vats = invoices.map((i) => num(i.vatTotal));
  const totalRevenue = round2(totals.reduce((s, n) => s + n, 0));
  const totalVat = round2(vats.reduce((s, n) => s + n, 0));
  const invoiceCount = invoices.length;
  const avgInvoice = invoiceCount ? round2(totalRevenue / invoiceCount) : 0;
  const maxInvoice = round2(totals.reduce((m, n) => Math.max(m, n), 0));
  const netRevenue = round2(totalRevenue - totalVat);

  const trendMap = new Map<string, { revenue: number; count: number }>();
  for (const inv of invoices) {
    const mk = monthKey(inv.issueDate);
    if (!mk) continue;
    const cur = trendMap.get(mk) ?? { revenue: 0, count: 0 };
    cur.revenue += num(inv.grandTotal);
    cur.count += 1;
    trendMap.set(mk, cur);
  }
  const trend = [...trendMap.entries()]
    .map(([month, v]) => ({ month, revenue: round2(v.revenue), count: v.count }))
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-12);

  const statusMap = new Map<string, { count: number; total: number }>();
  for (const inv of invoices) {
    const st = (inv.status ?? "غير محدد").toString();
    const cur = statusMap.get(st) ?? { count: 0, total: 0 };
    cur.count += 1;
    cur.total += num(inv.grandTotal);
    statusMap.set(st, cur);
  }
  const statusBreakdown = [...statusMap.entries()]
    .map(([status, v]) => ({ status, count: v.count, total: round2(v.total) }))
    .sort((a, b) => b.total - a.total);

  // Rule-based narrative + recommendations (deterministic).
  const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const narrativeParts = [
    `يبلغ إجمالي الإيرادات ${fmt(totalRevenue)} عبر ${invoiceCount} فاتورة، بمتوسط ${fmt(avgInvoice)} للفاتورة.`,
    `إجمالي ضريبة القيمة المضافة ${fmt(totalVat)}، وصافي الإيراد قبل الضريبة ${fmt(netRevenue)}.`,
  ];
  if (trend.length >= 2) {
    const last = trend[trend.length - 1]!;
    const prev = trend[trend.length - 2]!;
    const delta = prev.revenue ? ((last.revenue - prev.revenue) / prev.revenue) * 100 : 0;
    const dir = delta >= 0 ? "ارتفاعًا" : "انخفاضًا";
    narrativeParts.push(`أظهر آخر شهر (${last.month}) ${dir} بنسبة ${fmt(Math.abs(round2(delta)))}% عن الشهر السابق.`);
  }
  const recommendations: string[] = [];
  const draft = statusBreakdown.find((s) => /draft|مسودة/i.test(s.status));
  if (draft && draft.count > 0) {
    recommendations.push(`لديك ${draft.count} فاتورة بحالة مسودة بإجمالي ${fmt(draft.total)} — راجعها وقم بترحيلها لإظهار أثرها المالي.`);
  }
  if (invoiceCount > 0 && totalVat === 0) {
    recommendations.push("لا توجد ضريبة قيمة مضافة على أي فاتورة — تأكد من صحة فئات الضريبة قبل التقديم لهيئة الزكاة والضريبة.");
  }
  if (trend.length >= 2) {
    const last = trend[trend.length - 1]!;
    const prev = trend[trend.length - 2]!;
    if (prev.revenue > 0 && last.revenue < prev.revenue * 0.7) {
      recommendations.push("انخفاض ملحوظ في إيراد آخر شهر (أكثر من 30%) — راجع أسباب التراجع وخطة المبيعات.");
    }
  }
  if (recommendations.length === 0) {
    recommendations.push("المؤشرات ضمن النطاق المتوقع — استمر في المتابعة الدورية للإيراد والضريبة.");
  }

  let narrative = narrativeParts.join(" ");
  let source: Source = "rules";

  if (isAIAvailable()) {
    try {
      const ai = await chatJSON<{ narrative?: string; recommendations?: string[] }>(
        [
          {
            role: "system",
            content:
              "أنت مدير مالي (CFO) خبير. ستحصل على ملخّص رقمي مجمّع لفواتير شركة، وعليك كتابة تحليل موجز ومهني بالعربية وتوصيات عملية. أعد JSON فقط بالشكل {\"narrative\": string, \"recommendations\": string[]}.",
          },
          {
            role: "user",
            content: JSON.stringify({
              kpis: { invoiceCount, totalRevenue, totalVat, netRevenue, avgInvoice, maxInvoice },
              trend,
              statusBreakdown,
            }),
          },
        ],
        { maxTokens: 900, timeoutMs: 25_000 },
      );
      if (ai && typeof ai.narrative === "string" && ai.narrative.trim()) {
        narrative = ai.narrative.trim();
        if (Array.isArray(ai.recommendations)) {
          const cleaned = ai.recommendations.filter((r) => typeof r === "string" && r.trim()).map((r) => r.trim());
          if (cleaned.length) recommendations.splice(0, recommendations.length, ...cleaned.slice(0, 8));
        }
        source = "ai";
      }
    } catch {
      // keep rule-based
    }
  }

  return {
    source,
    kpis: { invoiceCount, totalRevenue, totalVat, netRevenue, avgInvoice, maxInvoice },
    trend,
    statusBreakdown,
    narrative,
    recommendations,
  };
}

// ── AI Auditor ──────────────────────────────────────────────────────────────
export type Severity = "high" | "medium" | "low" | "info";

export interface AuditFinding {
  code: string;
  severity: Severity;
  titleAr: string;
  count: number;
  sample: string[];
}

export interface AuditorResult {
  source: Source;
  scanned: { invoices: number; accounts: number };
  findings: AuditFinding[];
  summary: string;
}

export async function reviewAuditor(manifest: ExtensionManifest, ctx: ExtensionContext): Promise<AuditorResult> {
  const [invoices, accounts] = await Promise.all([
    coreList(manifest, ctx, "invoices", { limit: 500 }) as Promise<InvoiceRow[]>,
    coreList(manifest, ctx, "accounts", { limit: 500 }) as Promise<AccountRow[]>,
  ]);

  const findings: AuditFinding[] = [];
  const label = (inv: InvoiceRow) => inv.invoiceNumber || `#${inv.id}`;

  const nonPositive = invoices.filter((i) => num(i.grandTotal) <= 0);
  if (nonPositive.length) {
    findings.push({
      code: "NON_POSITIVE_TOTAL",
      severity: "high",
      titleAr: "فواتير بإجمالي صفري أو سالب",
      count: nonPositive.length,
      sample: nonPositive.slice(0, 5).map(label),
    });
  }

  const zeroVat = invoices.filter((i) => num(i.vatTotal) === 0 && num(i.grandTotal) > 0);
  if (zeroVat.length) {
    findings.push({
      code: "ZERO_VAT",
      severity: "medium",
      titleAr: "فواتير بإجمالي موجب دون ضريبة قيمة مضافة",
      count: zeroVat.length,
      sample: zeroVat.slice(0, 5).map(label),
    });
  }

  const missingDate = invoices.filter((i) => !i.issueDate);
  if (missingDate.length) {
    findings.push({
      code: "MISSING_DATE",
      severity: "medium",
      titleAr: "فواتير بدون تاريخ إصدار",
      count: missingDate.length,
      sample: missingDate.slice(0, 5).map(label),
    });
  }

  // Duplicate invoice numbers (excluding blanks).
  const byNumber = new Map<string, number>();
  for (const inv of invoices) {
    const n = (inv.invoiceNumber ?? "").trim();
    if (!n) continue;
    byNumber.set(n, (byNumber.get(n) ?? 0) + 1);
  }
  const dups = [...byNumber.entries()].filter(([, c]) => c > 1);
  if (dups.length) {
    findings.push({
      code: "DUPLICATE_NUMBER",
      severity: "high",
      titleAr: "أرقام فواتير مكرّرة",
      count: dups.length,
      sample: dups.slice(0, 5).map(([n, c]) => `${n} (×${c})`),
    });
  }

  const draft = invoices.filter((i) => /draft|مسودة/i.test(i.status ?? ""));
  if (draft.length) {
    findings.push({
      code: "DRAFT_INVOICES",
      severity: "low",
      titleAr: "فواتير غير مرحّلة (مسودة)",
      count: draft.length,
      sample: draft.slice(0, 5).map(label),
    });
  }

  const inactivePosting = accounts.filter((a) => a.isPosting === true && a.isActive === false);
  if (inactivePosting.length) {
    findings.push({
      code: "INACTIVE_POSTING_ACCOUNT",
      severity: "low",
      titleAr: "حسابات ترحيل غير مفعّلة",
      count: inactivePosting.length,
      sample: inactivePosting.slice(0, 5).map((a) => `${a.code ?? a.id} ${a.nameAr ?? ""}`.trim()),
    });
  }

  if (findings.length === 0) {
    findings.push({
      code: "CLEAN",
      severity: "info",
      titleAr: "لم يُعثر على ملاحظات تدقيق ضمن العيّنة المفحوصة",
      count: 0,
      sample: [],
    });
  }

  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);

  const high = findings.filter((f) => f.severity === "high").length;
  const med = findings.filter((f) => f.severity === "medium").length;
  let summary =
    high > 0
      ? `تم رصد ${high} ملاحظة عالية الخطورة و${med} متوسطة — يُنصح بمعالجتها قبل التقديم لهيئة الزكاة والضريبة.`
      : findings[0]?.code === "CLEAN"
        ? "سجلّ نظيف ضمن العيّنة المفحوصة — لا توجد ملاحظات تدقيق ظاهرة."
        : `ملاحظات تدقيق طفيفة (${med} متوسطة) — يُفضّل مراجعتها.`;
  let source: Source = "rules";

  if (isAIAvailable() && findings[0]?.code !== "CLEAN") {
    try {
      const ai = await chatJSON<{ summary?: string }>(
        [
          {
            role: "system",
            content:
              "أنت مدقّق حسابات خبير في الفوترة الإلكترونية السعودية (ZATCA). ستحصل على قائمة ملاحظات تدقيق مُجمّعة، اكتب ملخّصًا تنفيذيًا موجزًا بالعربية يوضّح الأولويات والمخاطر. أعد JSON فقط {\"summary\": string}.",
          },
          { role: "user", content: JSON.stringify({ scanned: { invoices: invoices.length, accounts: accounts.length }, findings }) },
        ],
        { maxTokens: 500, timeoutMs: 20_000 },
      );
      if (ai && typeof ai.summary === "string" && ai.summary.trim()) {
        summary = ai.summary.trim();
        source = "ai";
      }
    } catch {
      // keep rule-based
    }
  }

  return {
    source,
    scanned: { invoices: invoices.length, accounts: accounts.length },
    findings,
    summary,
  };
}

// ── AI Monitoring (anomaly detection) ────────────────────────────────────────
export interface Anomaly {
  code: string;
  severity: Severity;
  titleAr: string;
  detail: string;
}

export interface MonitorResult {
  source: Source;
  scanned: { invoices: number };
  anomalies: Anomaly[];
  summary: string;
}

export async function detectAnomalies(manifest: ExtensionManifest, ctx: ExtensionContext): Promise<MonitorResult> {
  const invoices = (await coreList(manifest, ctx, "invoices", { limit: 500 })) as InvoiceRow[];
  const anomalies: Anomaly[] = [];
  const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const totals = invoices.map((i) => num(i.grandTotal)).filter((n) => n > 0);
  if (totals.length >= 5) {
    const mean = totals.reduce((s, n) => s + n, 0) / totals.length;
    const variance = totals.reduce((s, n) => s + (n - mean) ** 2, 0) / totals.length;
    const std = Math.sqrt(variance);
    const threshold = mean + 3 * std;
    const outliers = invoices.filter((i) => num(i.grandTotal) > threshold && std > 0);
    if (outliers.length) {
      anomalies.push({
        code: "VALUE_OUTLIER",
        severity: "medium",
        titleAr: "فواتير بقيمة شاذّة (أعلى من المتوسط +3 انحرافات معيارية)",
        detail: `${outliers.length} فاتورة تتجاوز ${fmt(round2(threshold))} (المتوسط ${fmt(round2(mean))}). أمثلة: ${outliers
          .slice(0, 5)
          .map((i) => `${i.invoiceNumber || "#" + i.id}=${fmt(num(i.grandTotal))}`)
          .join("، ")}`,
      });
    }
  }

  // Daily volume spikes — a day with > 3× the average daily count.
  const byDay = new Map<string, number>();
  for (const inv of invoices) {
    const d = (inv.issueDate ?? "").slice(0, 10);
    if (!d) continue;
    byDay.set(d, (byDay.get(d) ?? 0) + 1);
  }
  if (byDay.size >= 3) {
    const counts = [...byDay.values()];
    const avg = counts.reduce((s, n) => s + n, 0) / counts.length;
    const spikes = [...byDay.entries()].filter(([, c]) => c > avg * 3 && c >= 5);
    if (spikes.length) {
      anomalies.push({
        code: "VOLUME_SPIKE",
        severity: "low",
        titleAr: "ارتفاع مفاجئ في عدد الفواتير اليومي",
        detail: `${spikes.length} يوم يتجاوز ثلاثة أضعاف المعدل اليومي (${fmt(round2(avg))}). أمثلة: ${spikes
          .slice(0, 5)
          .map(([d, c]) => `${d}=${c}`)
          .join("، ")}`,
      });
    }
  }

  // Duplicate invoice numbers are a data-integrity anomaly too.
  const byNumber = new Map<string, number>();
  for (const inv of invoices) {
    const n = (inv.invoiceNumber ?? "").trim();
    if (!n) continue;
    byNumber.set(n, (byNumber.get(n) ?? 0) + 1);
  }
  const dups = [...byNumber.entries()].filter(([, c]) => c > 1);
  if (dups.length) {
    anomalies.push({
      code: "DUPLICATE_NUMBER",
      severity: "high",
      titleAr: "أرقام فواتير مكرّرة",
      detail: `${dups.length} رقم مكرّر: ${dups.slice(0, 5).map(([n, c]) => `${n} (×${c})`).join("، ")}`,
    });
  }

  if (anomalies.length === 0) {
    anomalies.push({
      code: "NONE",
      severity: "info",
      titleAr: "لا توجد أنماط شاذّة ضمن العيّنة المفحوصة",
      detail: `تم فحص ${invoices.length} فاتورة دون رصد شذوذ.`,
    });
  }

  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };
  anomalies.sort((a, b) => order[a.severity] - order[b.severity]);

  const high = anomalies.filter((a) => a.severity === "high").length;
  let summary =
    anomalies[0]?.code === "NONE"
      ? "لا يوجد نشاط غير اعتيادي يستدعي الانتباه."
      : `تم رصد ${anomalies.length} نمط غير اعتيادي${high ? `، منها ${high} عالي الخطورة` : ""} — يُنصح بالمراجعة.`;
  let source: Source = "rules";

  if (isAIAvailable() && anomalies[0]?.code !== "NONE") {
    try {
      const ai = await chatJSON<{ summary?: string }>(
        [
          {
            role: "system",
            content:
              "أنت محلّل مراقبة عمليات. ستحصل على قائمة أنماط شاذّة مرصودة في فواتير شركة، اكتب ملخّصًا موجزًا بالعربية يوضّح المخاطر المحتملة والإجراء المقترح. أعد JSON فقط {\"summary\": string}.",
          },
          { role: "user", content: JSON.stringify({ scanned: invoices.length, anomalies }) },
        ],
        { maxTokens: 500, timeoutMs: 20_000 },
      );
      if (ai && typeof ai.summary === "string" && ai.summary.trim()) {
        summary = ai.summary.trim();
        source = "ai";
      }
    } catch {
      // keep rule-based
    }
  }

  return { source, scanned: { invoices: invoices.length }, anomalies, summary };
}
