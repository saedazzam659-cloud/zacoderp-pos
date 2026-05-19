// =====================================================================
// Contracting AI — assistant + project analysis + ML training export
//
// Three endpoints:
//   POST /api/contracting-ai/assist       per-screen explainer + suggestions
//   POST /api/contracting-ai/analyze      project deep-dive (delays, cost,
//                                          risks) grounded in real data
//   GET  /api/contracting-ai/training-csv exports historical project rows
//                                          as CSV for offline ML training
//
// All endpoints share the OpenAI proxy used by the rest of the app
// (env vars AI_INTEGRATIONS_OPENAI_BASE_URL / _API_KEY) and degrade
// gracefully to deterministic rule-based responses when the proxy is
// unreachable so the UI never appears broken.
// =====================================================================
import { Router } from "express";
import { db } from "@workspace/db";
import {
  contractingProjectsTable, contractingWorkItemsTable,
  contractingProgressBillsTable, contractingEventsTable,
  contractingRisksTable, contractingResourcesTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { chat as aiChat, isAIAvailable } from "../lib/aiClient.js";
import { requireAiFeature, logAiUsage } from "../middleware/requireAiFeature.js";

const router = Router();
router.use(extractAuth);
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});
router.use(requirePermission("contracting", "view"));

type AssistResult = {
  explanation: string;
  suggestion: string;
  next_step: string;
  warning_if_any: string;
  source: "ai" | "fallback";
};

// Compact, model-friendly snapshot of one project. Keep it small — the
// model is more accurate when given less noisy context.
async function loadProjectSnapshot(companyId: number, projectId: number) {
  const [project] = await db.select().from(contractingProjectsTable)
    .where(and(eq(contractingProjectsTable.id, projectId), eq(contractingProjectsTable.companyId, companyId)));
  if (!project) return null;
  const items = await db.select().from(contractingWorkItemsTable)
    .where(eq(contractingWorkItemsTable.projectId, projectId));
  const bills = await db.select().from(contractingProgressBillsTable)
    .where(eq(contractingProgressBillsTable.projectId, projectId));
  const risks = await db.select().from(contractingRisksTable)
    .where(eq(contractingRisksTable.projectId, projectId));
  const recentEvents = await db.select().from(contractingEventsTable)
    .where(eq(contractingEventsTable.projectId, projectId))
    .orderBy(desc(contractingEventsTable.createdAt))
    .limit(15);
  return { project, items, bills, risks, recentEvents };
}

// ─────────────────── per-screen ASSIST ───────────────────
router.post("/assist", requireAiFeature("contracting_ai"), async (req, res) => {
  try {
    const cid = await resolveCompanyId(req);
    if (!cid) { res.status(400).json({ error: "لا يوجد شركة" }); return; }
    const {
      screen_context = "contracting.dashboard",
      current_action = "",
      user_message   = "",
      project_id     = null,
      lang           = "ar",
    } = req.body as any;

    const snap = project_id ? await loadProjectSnapshot(cid, Number(project_id)) : null;

    // Deterministic fallback when AI is off — keeps the UI useful and the
    // "explain my screen" feature working even on local/dev environments
    // without an integrations key.
    const fallback = (): AssistResult => {
      const screenHints: Record<string, { exp: string; sug: string; nxt: string }> = {
        "contracting.dashboard": {
          exp: "لوحة تحكم المقاولات تعرض ملخص جميع مشاريعك الإنشائية مع نسب الإنجاز، التكاليف المخططة مقارنة بالفعلية، عدد المخاطر النشطة، وآخر الأحداث.",
          sug: "ابدأ بمراجعة المشاريع المتأخرة (إن وجدت) — هي عادة المصدر الأول لتجاوز التكاليف. ثم افتح أعلى مخاطرة لمعرفة خطة المعالجة.",
          nxt: "اضغط على زر «مشروع جديد» أعلى الشاشة لتسجيل أول مشروع إنشائي.",
        },
        "contracting.projects": {
          exp: "هذه قائمة بكل المشاريع الإنشائية للشركة. يمكنك تصفية القائمة بالحالة والبحث بالاسم، وكل مشروع يعرض الكود، الحالة، نسبة الإنجاز، وقيمة العقد.",
          sug: "احرص على تحديث «نسبة الإنجاز» أسبوعياً على الأقل — هي المصدر الذي يعتمد عليه حساب المستخلصات والتنبؤ بالتأخير.",
          nxt: "افتح أحد المشاريع لعرض تبويب «بنود التنفيذ» وإضافة الأعمال (حفر، خرسانة، تشطيبات…).",
        },
        "contracting.project.detail": {
          exp: "تبويبات المشروع: نظرة عامة (الميزانية والإنجاز)، بنود التنفيذ (تفاصيل الأعمال)، الموارد (عمالة/معدات/مواد)، المستخلصات (الدفعات)، الأحداث (سجل العمليات)، والمخاطر.",
          sug: "للحصول على نسبة إنجاز دقيقة، حدّث نسبة كل بند تنفيذ على حدة — النظام يحسب نسبة المشروع كمعدل مرجح حسب التكلفة المخططة.",
          nxt: "افتح تبويب «المستخلصات» وأضف مستخلص جديد عند بلوغ المشروع نسبة إنجاز جديدة.",
        },
        "contracting.contractors": {
          exp: "قائمة المقاولين والموردين الذين تتعامل معهم في مشاريع المقاولات، مع تصنيف التخصص والتقييم.",
          sug: "حدّث تقييم المقاول بعد كل مشروع — يساعد على اختيار المقاول الأنسب للمشاريع القادمة.",
          nxt: "ربط المقاول بمورد موجود في نظام المشتريات يوفر عليك إعادة إدخال البيانات المالية.",
        },
      };
      const h = screenHints[screen_context] ?? screenHints["contracting.dashboard"];
      let warning = "";
      if (snap?.project) {
        const overrun = Number(snap.project.actualCost) > Number(snap.project.plannedBudget);
        const lateEnd = snap.project.plannedEndDate
          && new Date(snap.project.plannedEndDate) < new Date()
          && Number(snap.project.progressPercent) < 100;
        if (overrun) warning = "⚠ التكلفة الفعلية تجاوزت الميزانية المخططة.";
        else if (lateEnd) warning = "⚠ تجاوزت تاريخ النهاية المخطط ولم يكتمل المشروع بعد.";
      }
      return { explanation: h.exp, suggestion: h.sug, next_step: h.nxt, warning_if_any: warning, source: "fallback" };
    };

    if (!isAIAvailable()) {
      await logAiUsage(req, { status: "allowed", provider: "rule" });
      res.json(fallback()); return;
    }

    const projectBlock = snap ? `\nبيانات المشروع الحالي:
- اسم: ${snap.project.nameAr} (كود ${snap.project.code})
- حالة: ${snap.project.status}
- نسبة إنجاز: ${snap.project.progressPercent}%
- ميزانية مخططة: ${snap.project.plannedBudget} ر.س | تكلفة فعلية: ${snap.project.actualCost} ر.س | قيمة العقد: ${snap.project.contractValue} ر.س
- بداية مخططة: ${snap.project.plannedStartDate ?? "—"} | نهاية مخططة: ${snap.project.plannedEndDate ?? "—"}
- عدد بنود التنفيذ: ${snap.items.length} | مستخلصات: ${snap.bills.length} | مخاطر مفتوحة: ${snap.risks.filter(r => r.status === "open").length}
- آخر أحداث: ${snap.recentEvents.slice(0, 5).map(e => `${e.eventType}:${e.title}`).join(" | ")}` : "";

    const prompt = `أنت مساعد ذكي داخل نظام إدارة المقاولات لمستخدم غير تقني. اللغة: ${lang === "en" ? "English" : "العربية"}.
الشاشة الحالية: ${screen_context}
آخر إجراء قام به المستخدم: ${current_action || "—"}
سؤال المستخدم: ${user_message || "(لا يوجد سؤال محدد، اشرح الشاشة وأعطني توصيتك التالية)"}
${projectBlock}

أعد JSON فقط بهذا الشكل:
{
  "explanation": "شرح بسيط للشاشة (جملتان كحد أقصى)",
  "suggestion": "اقتراح عملي قابل للتطبيق فوراً",
  "next_step": "الخطوة التالية المباشرة (جملة واحدة)",
  "warning_if_any": "تحذير إن وُجد خلل (تأخير، تجاوز ميزانية، مخاطرة عالية…) وإلا اتركه فارغاً"
}`;

    const result = await aiChat([
        { role: "system", content: "أنت مساعد ذكي داخل نظام مقاولات سعودي. ترد دائماً بـ JSON صحيح، باللغة العربية الفصحى، مختصر وعملي." },
        { role: "user", content: prompt },
      ], { json: true,
      maxTokens: 800,
      providers: ["gemini"] });
    if (!result.ok) {
      await logAiUsage(req, { status: "allowed", provider: "rule", meta: { reason: result.reason } });
      res.json(fallback()); return;
    }
    const parsed: any = result.data ?? {};
    await logAiUsage(req, { status: "allowed", provider: result.provider });
    res.json({
      explanation:    String(parsed.explanation    ?? ""),
      suggestion:     String(parsed.suggestion     ?? ""),
      next_step:      String(parsed.next_step      ?? ""),
      warning_if_any: String(parsed.warning_if_any ?? ""),
      source: "ai" as const,
    });
  } catch (e: any) {
    await logAiUsage(req, { status: "error", meta: { error: String(e?.message || e) } });
    res.status(500).json({ error: e?.message ?? "خطأ" });
  }
});

// ─────────────────── project deep ANALYSIS ───────────────────
router.post("/analyze/:projectId", requireAiFeature("contracting_ai"), async (req, res) => {
  try {
    const cid = await resolveCompanyId(req);
    if (!cid) { res.status(400).json({ error: "لا يوجد شركة" }); return; }
    const projectId = Number(req.params.projectId);
    const snap = await loadProjectSnapshot(cid, projectId);
    if (!snap) { res.status(404).json({ error: "مشروع غير موجود" }); return; }

    // Compute deterministic indicators we always include in the response so
    // the UI has something to render even if the AI call fails. The model
    // adds the narrative; the math does not depend on it.
    const today = new Date();
    const start = snap.project.plannedStartDate ? new Date(snap.project.plannedStartDate) : null;
    const end   = snap.project.plannedEndDate   ? new Date(snap.project.plannedEndDate)   : null;
    const totalDays   = start && end ? Math.max(1, Math.round((+end - +start) / 86400000)) : null;
    const elapsedDays = start ? Math.max(0, Math.round((+today - +start) / 86400000)) : null;
    const expectedProgress = totalDays && elapsedDays !== null
      ? Math.min(100, (elapsedDays / totalDays) * 100) : null;
    const actualProgress = Number(snap.project.progressPercent);
    const schedulePerformanceIndex = expectedProgress && expectedProgress > 0
      ? actualProgress / expectedProgress : null;
    const costOverrun  = Number(snap.project.actualCost) - Number(snap.project.plannedBudget);
    const remainingBudget = Number(snap.project.plannedBudget) - Number(snap.project.actualCost);
    const burnRate = elapsedDays && elapsedDays > 0
      ? Number(snap.project.actualCost) / elapsedDays : null;
    const projectedFinalCost = burnRate && totalDays
      ? Math.round(burnRate * totalDays) : null;

    const indicators = {
      actualProgress,
      expectedProgress: expectedProgress != null ? Math.round(expectedProgress * 10) / 10 : null,
      schedulePerformanceIndex: schedulePerformanceIndex != null ? Math.round(schedulePerformanceIndex * 100) / 100 : null,
      costOverrun:        Math.round(costOverrun * 100) / 100,
      remainingBudget:    Math.round(remainingBudget * 100) / 100,
      projectedFinalCost,
      blockedItems:       snap.items.filter(i => i.status === "blocked").length,
      openHighRisks:      snap.risks.filter(r => r.score >= 6 && r.status !== "resolved").length,
    };

    const fallback = () => {
      const findings: string[] = [];
      if (indicators.schedulePerformanceIndex != null && indicators.schedulePerformanceIndex < 0.85)
        findings.push(`المشروع يسير أبطأ من الخطة بنسبة ${Math.round((1 - indicators.schedulePerformanceIndex) * 100)}%`);
      if (indicators.costOverrun > 0)
        findings.push(`التكلفة الفعلية تجاوزت الميزانية بـ ${indicators.costOverrun.toLocaleString("en-US")} ر.س`);
      if (indicators.blockedItems > 0)
        findings.push(`يوجد ${indicators.blockedItems} بند تنفيذ متوقف`);
      if (indicators.openHighRisks > 0)
        findings.push(`يوجد ${indicators.openHighRisks} مخاطرة عالية مفتوحة`);
      const recommendations: string[] = [];
      if (indicators.schedulePerformanceIndex != null && indicators.schedulePerformanceIndex < 0.85)
        recommendations.push("راجع المسار الحرج وأضف موارد للبنود المتأخرة");
      if (indicators.costOverrun > 0)
        recommendations.push("جمّد البنود غير الضرورية وأعد التفاوض مع الموردين قبل تجاوز الميزانية أكثر");
      if (indicators.blockedItems > 0)
        recommendations.push("افتح اجتماع طوارئ لرفع التوقف عن البنود المعلّقة");
      if (recommendations.length === 0)
        recommendations.push("استمر على الوتيرة الحالية وحدّث نسب الإنجاز أسبوعياً");
      return {
        summary: findings.length === 0
          ? "المشروع في وضع جيد بشكل عام؛ لا توجد إشارات تنبيه فورية."
          : `${findings.length} إشارات تنبيه: ${findings.join(" — ")}.`,
        delay_risk: indicators.schedulePerformanceIndex != null && indicators.schedulePerformanceIndex < 0.85 ? "high"
          : indicators.schedulePerformanceIndex != null && indicators.schedulePerformanceIndex < 1 ? "medium" : "low",
        cost_risk: indicators.costOverrun > 0 ? "high" : indicators.costOverrun > -0.1 * Number(snap.project.plannedBudget) ? "medium" : "low",
        findings, recommendations,
        source: "fallback" as const,
      };
    };

    if (!isAIAvailable()) {
      await logAiUsage(req, { status: "allowed", provider: "rule" });
      res.json({ indicators, ...fallback() });
      return;
    }

    const prompt = `أنت محلل مشاريع إنشائية. حلّل هذا المشروع وأعد رؤى دقيقة:

بيانات المشروع:
- اسم: ${snap.project.nameAr}
- نوع: ${snap.project.projectType} | حالة: ${snap.project.status}
- نسبة إنجاز فعلية: ${actualProgress}% | متوقعة حسب الجدول: ${indicators.expectedProgress}%
- مؤشر أداء الجدول (SPI): ${indicators.schedulePerformanceIndex}
- ميزانية: ${snap.project.plannedBudget} | تكلفة فعلية: ${snap.project.actualCost} | تجاوز: ${indicators.costOverrun} ر.س
- التكلفة المتوقعة عند الإكمال (وفق معدل الحرق): ${indicators.projectedFinalCost ?? "—"} ر.س
- بنود تنفيذ: ${snap.items.length} (متوقف: ${indicators.blockedItems})
- مخاطر مفتوحة عالية: ${indicators.openHighRisks}
- أحدث ${snap.recentEvents.length} أحداث: ${snap.recentEvents.slice(0,5).map(e=>e.title).join(" | ")}

أعد JSON فقط:
{
  "summary": "ملخص فني في 2-3 جمل",
  "delay_risk": "low|medium|high",
  "cost_risk": "low|medium|high",
  "findings": ["نقطة 1","نقطة 2",...],
  "recommendations": ["إجراء 1","إجراء 2",...]
}`;

    const result = await aiChat([
        { role: "system", content: "أنت محلل مشاريع إنشائية محترف. ترد بـ JSON دقيق وموضوعي بدون مبالغة." },
        { role: "user", content: prompt },
      ], { json: true,
      maxTokens: 1200,
      providers: ["gemini"] });
    if (!result.ok) {
      await logAiUsage(req, { status: "allowed", provider: "rule", meta: { reason: result.reason } });
      res.json({ indicators, ...fallback() });
      return;
    }
    const parsed: any = result.data ?? {};
    await logAiUsage(req, { status: "allowed", provider: result.provider });

    // Persist a system event so the analysis is auditable in the project
    // timeline (and so the ML training-data export captures it later).
    try {
      await db.insert(contractingEventsTable).values({
        companyId: cid, projectId,
        eventType: "ai_suggestion",
        title: "تحليل ذكاء اصطناعي للمشروع",
        description: String(parsed.summary ?? ""),
        severity: parsed.delay_risk === "high" || parsed.cost_risk === "high" ? "warn" : "info",
        meta: { spi: indicators.schedulePerformanceIndex, costOverrun: indicators.costOverrun },
      });
    } catch { /* non-fatal */ }

    res.json({
      indicators,
      summary: String(parsed.summary ?? ""),
      delay_risk: String(parsed.delay_risk ?? "low"),
      cost_risk:  String(parsed.cost_risk  ?? "low"),
      findings:        Array.isArray(parsed.findings)        ? parsed.findings.map(String)        : [],
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.map(String) : [],
      source: "ai" as const,
    });
  } catch (e: any) {
    await logAiUsage(req, { status: "error", meta: { error: String(e?.message || e) } });
    res.status(500).json({ error: e?.message ?? "خطأ" });
  }
});

// ─────────────────── ML training-data export ───────────────────
// Exports completed/in-progress historical projects as a flat CSV that an
// off-platform data-science team can use to train their own delay/cost
// prediction model. CSV is the lingua-franca of ML pipelines (pandas,
// scikit-learn, BigQuery ML…) so we don't lock the buyer into a stack.
//
// Row shape covers the inputs and the outcomes:
//   Inputs:  project_type, contract_value, planned_budget, planned_duration_days,
//            work_items_count, contractors_count, resources_count
//   Outputs: actual_cost, actual_duration_days, schedule_overrun_days,
//            cost_overrun_pct, final_status
//
// This becomes the seed of a feedback loop: as more projects close, the
// dataset grows, and the model can be retrained. We deliberately do NOT
// train inside the platform — that's a different operational concern.
router.get("/training-csv", async (req, res) => {
  try {
    const cid = await resolveCompanyId(req);
    if (!cid) { res.status(400).json({ error: "لا يوجد شركة" }); return; }

    const projects = await db.select().from(contractingProjectsTable)
      .where(eq(contractingProjectsTable.companyId, cid));

    const allItems = await db.select().from(contractingWorkItemsTable)
      .where(eq(contractingWorkItemsTable.companyId, cid));
    const allResources = await db.select().from(contractingResourcesTable)
      .where(eq(contractingResourcesTable.companyId, cid));
    const itemsByProj = new Map<number, number>();
    const resByProj   = new Map<number, number>();
    for (const i of allItems)     itemsByProj.set(i.projectId,         (itemsByProj.get(i.projectId) ?? 0) + 1);
    for (const r of allResources) if (r.projectId) resByProj.set(r.projectId, (resByProj.get(r.projectId) ?? 0) + 1);

    const headers = [
      "project_id","project_type","contract_value","planned_budget",
      "planned_start","planned_end","planned_duration_days",
      "actual_start","actual_end","actual_duration_days",
      "schedule_overrun_days","actual_cost","cost_overrun_pct",
      "progress_percent","work_items_count","resources_count",
      "final_status","created_at",
    ];
    const lines: string[] = [headers.join(",")];

    for (const p of projects) {
      const ps = p.plannedStartDate ? new Date(p.plannedStartDate) : null;
      const pe = p.plannedEndDate   ? new Date(p.plannedEndDate)   : null;
      const as = p.actualStartAt;
      const ae = p.actualEndAt;
      const plannedDays = ps && pe ? Math.round((+pe - +ps) / 86400000) : "";
      const actualDays  = as && ae ? Math.round((+ae - +as) / 86400000) : "";
      const overrunDays = pe && ae ? Math.round((+ae - +pe) / 86400000) : "";
      const planned = Number(p.plannedBudget);
      const actual  = Number(p.actualCost);
      const costOverrunPct = planned > 0 ? Math.round(((actual - planned) / planned) * 10000) / 100 : "";
      const cells = [
        p.id,
        p.projectType,
        p.contractValue, p.plannedBudget,
        p.plannedStartDate ?? "", p.plannedEndDate ?? "",
        plannedDays,
        as?.toISOString().slice(0,10) ?? "", ae?.toISOString().slice(0,10) ?? "",
        actualDays, overrunDays,
        p.actualCost, costOverrunPct,
        p.progressPercent,
        itemsByProj.get(p.id) ?? 0,
        resByProj.get(p.id) ?? 0,
        p.status,
        p.createdAt.toISOString().slice(0,10),
      ].map(c => {
        const s = String(c ?? "");
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      });
      lines.push(cells.join(","));
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="contracting-training-${new Date().toISOString().slice(0,10)}.csv"`);
    // BOM so Excel opens it as UTF-8 by default.
    res.send("\uFEFF" + lines.join("\n"));
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ" });
  }
});

export default router;
