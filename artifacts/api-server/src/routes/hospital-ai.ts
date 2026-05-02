// ─────────────────────────────────────────────────────────────────────────
// Hospital AI + NPHIES integration blueprint.
//
// Real NPHIES connectivity requires CCHI accreditation and a signed mTLS
// certificate issued to the practitioner / facility. Until those are in
// place we ship:
//   1. A FHIR R4 Claim builder (`/nphies/build-claim`) — produces a fully
//      structured Claim resource from an invoice + patient + doctor and
//      saves it in `hospital_insurance_claims.fhirPayload` so it can be
//      inspected, queued, and (later) POST-ed unchanged once the cert is
//      activated.
//   2. A readiness checklist (`/nphies/status`) that reports which env
//      vars / files / flags are missing so the operator knows the exact
//      remaining work.
//   3. AI helpers that degrade gracefully to deterministic rule-based
//      responses when the OpenAI proxy is not configured: claim-risk
//      (predicts approval likelihood), diagnosis-suggest (maps a chief
//      complaint to ICD-10 candidates), and patient-stats (gender / age
//      bucket / visit type breakdown).
// ─────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import { db } from "@workspace/db";
import {
  hospitalInvoicesTable,
  hospitalInvoiceItemsTable,
  hospitalPatientsTable,
  hospitalDoctorsTable,
  hospitalAppointmentsTable,
  hospitalsTable,
  hospitalClaimsTable,
} from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("hospital"));
router.use(moduleAudit("hospital"));
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

const OPENAI_BASE = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
const OPENAI_KEY  = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

function guardCid(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.body?.companyId ?? req.query.companyId);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

// ════════════════════════════════════════════════════════════════════════
// 1. NPHIES STATUS — readiness checklist for the SaaS operator
// ════════════════════════════════════════════════════════════════════════
router.get("/nphies/status", async (_req, res) => {
  try {
    const checks = [
      {
        key: "cchi_accreditation",
        label: "اعتماد مجلس الضمان الصحي (CCHI) للمنشأة",
        labelEn: "CCHI accreditation for the facility",
        ok: !!process.env.NPHIES_FACILITY_LICENSE,
        hint: "ضع رقم الاعتماد في NPHIES_FACILITY_LICENSE بعد الحصول على الترخيص.",
      },
      {
        key: "mtls_cert",
        label: "شهادة mTLS صادرة من NPHIES",
        labelEn: "mTLS certificate issued by NPHIES",
        ok: !!process.env.NPHIES_CLIENT_CERT_PATH,
        hint: "احفظ ملف الشهادة وحدّد مساره في NPHIES_CLIENT_CERT_PATH.",
      },
      {
        key: "mtls_key",
        label: "المفتاح الخاص للشهادة",
        labelEn: "Private key for the certificate",
        ok: !!process.env.NPHIES_CLIENT_KEY_PATH,
        hint: "حدّد مسار المفتاح الخاص في NPHIES_CLIENT_KEY_PATH.",
      },
      {
        key: "endpoint",
        label: "عنوان واجهة NPHIES (Production)",
        labelEn: "NPHIES production endpoint",
        ok: !!process.env.NPHIES_BASE_URL,
        hint: "ضع عنوان NPHIES في NPHIES_BASE_URL.",
      },
      {
        key: "payer_directory",
        label: "ربط مزودي التأمين (Payers Directory)",
        labelEn: "Payer directory wired",
        ok: false,
        hint: "ميزة قادمة — ستربط شركات التأمين بأكواد الدفع المعتمدة.",
      },
    ];
    const ready = checks.every(c => c.ok);
    res.json({
      ready,
      mode: ready ? "live" : "blueprint",
      message: ready
        ? "جاهز لإرسال المطالبات الحقيقية إلى NPHIES."
        : "النظام يعمل في وضع المخطط (Blueprint) — يبني مطالبات FHIR R4 ويحفظها بدون إرسال فعلي.",
      checks,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// 2. BUILD FHIR R4 CLAIM (saves to hospital_insurance_claims.fhirPayload)
// ════════════════════════════════════════════════════════════════════════
router.post("/nphies/build-claim", async (req, res) => {
  try {
    const cid = guardCid(req, res); if (!cid) return;
    const invoiceId = Number(req.body?.invoiceId);
    if (!Number.isFinite(invoiceId) || invoiceId <= 0) {
      res.status(400).json({ error: "الفاتورة مطلوبة" }); return;
    }

    const [inv] = await db.select().from(hospitalInvoicesTable)
      .where(and(eq(hospitalInvoicesTable.id, invoiceId), eq(hospitalInvoicesTable.companyId, cid)));
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }

    const items = await db.select().from(hospitalInvoiceItemsTable)
      .where(eq(hospitalInvoiceItemsTable.invoiceId, invoiceId));

    const [patient] = await db.select().from(hospitalPatientsTable)
      .where(and(eq(hospitalPatientsTable.id, inv.patientId), eq(hospitalPatientsTable.companyId, cid)));
    if (!patient) { res.status(404).json({ error: "المريض غير موجود" }); return; }

    const [doctor] = inv.doctorId
      ? await db.select().from(hospitalDoctorsTable)
          .where(and(eq(hospitalDoctorsTable.id, inv.doctorId), eq(hospitalDoctorsTable.companyId, cid)))
      : [null as any];

    const [hospital] = inv.hospitalId
      ? await db.select().from(hospitalsTable)
          .where(and(eq(hospitalsTable.id, inv.hospitalId), eq(hospitalsTable.companyId, cid)))
      : [null as any];

    // ─── FHIR R4 Claim resource (NPHIES profile) ─────────────────────
    const claim = {
      resourceType: "Claim",
      id: `claim-${invoiceId}`,
      meta: {
        profile: ["http://nphies.sa/fhir/ksa/nphies-fs/StructureDefinition/Claim"],
      },
      identifier: [{
        system: "http://nphies.sa/identifier/claim",
        value: inv.docNumber,
      }],
      status: "active",
      type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/claim-type", code: "professional" }] },
      use: "claim",
      patient: { reference: `Patient/${patient.id}`,
        display: patient.fullNameAr },
      created: new Date().toISOString(),
      provider: doctor
        ? { reference: `Practitioner/${doctor.id}`, display: doctor.nameAr }
        : { display: hospital?.nameAr || "غير محدد" },
      priority: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/processpriority", code: "normal" }] },
      payee: { type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/payeetype", code: "provider" }] } },
      careTeam: doctor ? [{
        sequence: 1,
        provider: { reference: `Practitioner/${doctor.id}`, display: doctor.nameAr },
        role: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/claimcareteamrole", code: "primary" }] },
        qualification: doctor.specialty ? { text: doctor.specialty } : undefined,
      }] : [],
      insurance: [{
        sequence: 1,
        focal: true,
        coverage: {
          display: patient.insurerName || "غير محدد",
          identifier: patient.policyNo
            ? { system: "http://nphies.sa/identifier/coverage", value: patient.policyNo }
            : undefined,
        },
      }],
      item: items.map((it, idx) => ({
        sequence: idx + 1,
        productOrService: it.serviceCode
          ? { coding: [{ system: "http://nphies.sa/terminology/CodeSystem/services", code: it.serviceCode }],
              text: it.description }
          : { text: it.description },
        quantity: { value: Number(it.qty) },
        unitPrice: { value: Number(it.unitPrice), currency: "SAR" },
        net: { value: Number(it.total), currency: "SAR" },
      })),
      total: { value: Number(inv.totalAmount), currency: "SAR" },
    };

    const fhirPayload = JSON.stringify(claim, null, 2);

    // Save / upsert claim row.
    const claimNumber = `CLM-${inv.docNumber}-${Date.now().toString(36).toUpperCase()}`;
    const [saved] = await db.insert(hospitalClaimsTable).values({
      companyId: cid,
      invoiceId,
      payerName: patient.insurerName || "غير محدد",
      policyNo: patient.policyNo || null,
      claimNumber,
      status: "draft",
      totalAmount: String(inv.totalAmount),
      approvedAmount: "0",
      fhirPayload,
      notes: "تم إنشاؤها تلقائياً من الفاتورة عبر مولد FHIR R4.",
    }).returning();

    res.status(201).json({
      claim: saved,
      fhir: claim,
      mode: process.env.NPHIES_BASE_URL ? "ready_to_send" : "blueprint",
      note: process.env.NPHIES_BASE_URL
        ? "يمكن إرسال هذه المطالبة الآن إلى NPHIES."
        : "تم البناء وحفظها — الإرسال يتطلب اعتماد CCHI وشهادة mTLS.",
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// 3. CLAIM RISK — predicts approval likelihood for a draft claim
// ════════════════════════════════════════════════════════════════════════
router.post("/claim-risk", async (req, res) => {
  try {
    const cid = guardCid(req, res); if (!cid) return;
    const invoiceId = Number(req.body?.invoiceId);
    if (!Number.isFinite(invoiceId) || invoiceId <= 0) {
      res.status(400).json({ error: "الفاتورة مطلوبة" }); return;
    }

    const [inv] = await db.select().from(hospitalInvoicesTable)
      .where(and(eq(hospitalInvoicesTable.id, invoiceId), eq(hospitalInvoicesTable.companyId, cid)));
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }

    const [patient] = await db.select().from(hospitalPatientsTable)
      .where(and(eq(hospitalPatientsTable.id, inv.patientId), eq(hospitalPatientsTable.companyId, cid)));
    const items = await db.select().from(hospitalInvoiceItemsTable)
      .where(eq(hospitalInvoiceItemsTable.invoiceId, invoiceId));

    // Rule-based scoring (always runs, used as fallback + sanity baseline).
    const reasons: string[] = [];
    let score = 80;
    if (!patient?.insurerName) { score -= 25; reasons.push("لا توجد شركة تأمين مسجلة للمريض."); }
    if (!patient?.policyNo)    { score -= 20; reasons.push("رقم البوليصة مفقود."); }
    if (patient?.policyExpires && new Date(patient.policyExpires) < new Date()) {
      score -= 30; reasons.push("بوليصة التأمين منتهية الصلاحية.");
    }
    if (items.length === 0) { score -= 25; reasons.push("الفاتورة بدون بنود — يجب توثيق الخدمات الطبية."); }
    if (items.some(it => !it.serviceCode)) {
      score -= 10;
      reasons.push("بعض البنود بلا أكواد خدمة (ServiceCode) معتمدة.");
    }
    const totalNum = Number(inv.totalAmount || 0);
    if (totalNum > 10000) { score -= 5; reasons.push("الفاتورة عالية القيمة قد تتطلب موافقة مسبقة."); }
    if (Number(inv.insuranceCoverage || 0) === 0) {
      score -= 10; reasons.push("لم يتم تحديد نسبة تغطية التأمين.");
    }
    score = Math.max(0, Math.min(100, score));

    const verdict =
      score >= 80 ? "high"   :
      score >= 55 ? "medium" :
      score >= 30 ? "low"    : "very_low";
    const verdictLabel =
      verdict === "high"   ? "احتمال موافقة مرتفع" :
      verdict === "medium" ? "احتمال موافقة متوسط — راجع البيانات" :
      verdict === "low"    ? "احتمال موافقة منخفض — أصلح الملاحظات قبل الإرسال" :
                             "احتمال موافقة ضعيف جداً — لا تُرسل المطالبة";

    let aiNarrative: string | null = null;
    if (OPENAI_BASE && OPENAI_KEY && reasons.length > 0) {
      try {
        const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: "You are a Saudi medical claims auditor. Reply in Arabic, concise, max 80 words. Highlight the single most likely rejection cause and one corrective action." },
              { role: "user", content: `Score: ${score}/100. Issues: ${reasons.join(" | ")}. Total: ${totalNum} SAR.` },
            ],
            temperature: 0.3,
            max_tokens: 200,
          }),
        });
        if (r.ok) {
          const j = await r.json();
          aiNarrative = j.choices?.[0]?.message?.content?.trim() || null;
        }
      } catch { /* swallow — fall back to rule-based */ }
    }

    res.json({ score, verdict, verdictLabel, reasons, aiNarrative,
      mode: aiNarrative ? "ai+rules" : "rules" });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// 4. DIAGNOSIS SUGGEST — chief complaint → ICD-10 candidates
// ════════════════════════════════════════════════════════════════════════
const DIAGNOSIS_RULES: Array<{ keywords: string[]; code: string; ar: string; en: string }> = [
  { keywords: ["حرارة","حمى","سخونة","fever","temperature"], code: "R50.9", ar: "حمى غير محددة",            en: "Fever, unspecified" },
  { keywords: ["سعال","كحة","cough"],                      code: "R05.9", ar: "سعال غير محدد",             en: "Cough, unspecified" },
  { keywords: ["صداع","رأس","headache","migraine"],         code: "R51",   ar: "صداع",                      en: "Headache" },
  { keywords: ["ضغط","ارتفاع ضغط","hypertension","bp"],     code: "I10",   ar: "ارتفاع ضغط الدم الأساسي",    en: "Essential hypertension" },
  { keywords: ["سكر","سكري","diabetes"],                    code: "E11.9", ar: "السكري من النوع الثاني",      en: "Type 2 diabetes mellitus" },
  { keywords: ["ربو","تنفس","asthma","shortness"],          code: "J45.909", ar: "ربو غير محدد",             en: "Asthma, unspecified" },
  { keywords: ["إسهال","اسهال","diarrhea"],                code: "K59.1", ar: "إسهال وظيفي",                en: "Functional diarrhea" },
  { keywords: ["معدة","غثيان","قيء","nausea","vomit"],     code: "R11.2", ar: "غثيان مع قيء",               en: "Nausea with vomiting" },
  { keywords: ["ظهر","فقري","back pain","lumbar"],          code: "M54.5", ar: "ألم أسفل الظهر",             en: "Low back pain" },
  { keywords: ["زكام","رشح","انفلونزا","cold","flu"],      code: "J11.1", ar: "إنفلونزا مع أعراض تنفسية",    en: "Influenza with respiratory manifestations" },
  { keywords: ["حلق","التهاب حلق","sore throat"],           code: "J02.9", ar: "التهاب البلعوم الحاد",        en: "Acute pharyngitis, unspecified" },
];

router.post("/diagnosis-suggest", async (req, res) => {
  try {
    const complaint = String(req.body?.complaint ?? "").trim();
    if (!complaint) { res.status(400).json({ error: "الشكوى الرئيسية مطلوبة" }); return; }
    const lower = complaint.toLowerCase();

    const matches = DIAGNOSIS_RULES
      .map(r => ({ ...r, hits: r.keywords.filter(k => lower.includes(k.toLowerCase())).length }))
      .filter(r => r.hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 5)
      .map(r => ({ code: r.code, ar: r.ar, en: r.en, confidence: Math.min(0.9, 0.4 + r.hits * 0.2) }));

    let aiNarrative: string | null = null;
    if (OPENAI_BASE && OPENAI_KEY) {
      try {
        const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: "You are a Saudi licensed family physician helping with provisional ICD-10 mapping. Reply in Arabic with 1-2 sentences. Always remind the doctor that final diagnosis must be confirmed by clinical exam." },
              { role: "user", content: `Chief complaint: ${complaint}` },
            ],
            temperature: 0.4,
            max_tokens: 150,
          }),
        });
        if (r.ok) {
          const j = await r.json();
          aiNarrative = j.choices?.[0]?.message?.content?.trim() || null;
        }
      } catch { /* fall back */ }
    }

    res.json({
      suggestions: matches,
      aiNarrative,
      mode: aiNarrative ? "ai+rules" : "rules",
      disclaimer: "هذه اقتراحات مساعدة للتشخيص الأولي فقط — التشخيص النهائي يتطلب فحصاً سريرياً.",
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// 5. PATIENT STATS — gender / visit-type / appointment-status breakdowns
// ════════════════════════════════════════════════════════════════════════
router.get("/patient-stats", async (req, res) => {
  try {
    const cid = guardCid(req, res); if (!cid) return;

    const patients = await db.select().from(hospitalPatientsTable)
      .where(eq(hospitalPatientsTable.companyId, cid));
    const appts = await db.select().from(hospitalAppointmentsTable)
      .where(eq(hospitalAppointmentsTable.companyId, cid))
      .orderBy(desc(hospitalAppointmentsTable.scheduledAt))
      .limit(500);

    const byGender = { male: 0, female: 0 };
    const ageBuckets = { "0-12": 0, "13-25": 0, "26-45": 0, "46-65": 0, "65+": 0, "unknown": 0 };
    const now = new Date();
    for (const p of patients) {
      byGender[p.gender as "male" | "female"]++;
      if (!p.dob) { ageBuckets.unknown++; continue; }
      const age = Math.floor((now.getTime() - new Date(p.dob).getTime()) / (365.25 * 86400000));
      if (age <= 12)      ageBuckets["0-12"]++;
      else if (age <= 25) ageBuckets["13-25"]++;
      else if (age <= 45) ageBuckets["26-45"]++;
      else if (age <= 65) ageBuckets["46-65"]++;
      else                ageBuckets["65+"]++;
    }

    const byVisitType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const a of appts) {
      byVisitType[a.visitType] = (byVisitType[a.visitType] ?? 0) + 1;
      byStatus[a.status]       = (byStatus[a.status]       ?? 0) + 1;
    }

    const insured  = patients.filter(p => p.insurerName).length;
    const expired  = patients.filter(p => p.policyExpires && new Date(p.policyExpires) < now).length;

    res.json({
      totals: {
        patients: patients.length,
        appointmentsLast500: appts.length,
        insured,
        uninsured: patients.length - insured,
        expiredPolicies: expired,
      },
      byGender,
      ageBuckets,
      byVisitType,
      byStatus,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
