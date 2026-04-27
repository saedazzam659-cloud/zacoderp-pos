// Voice-assistant router. Powers the in-app Arabic voice control feature:
//
//   GET  /api/voice-assistant/settings              — admin-only full config
//   GET  /api/voice-assistant/settings/me/effective — every user (safe slice)
//   PUT  /api/voice-assistant/settings              — admin-only upsert
//   POST /api/voice-assistant/parse-command         — transcript → action JSON
//   GET  /api/voice-assistant/log                   — paginated command log
//
// `parse-command` first tries a local keyword match (handled on the client too,
// but we double-check on the server in case the client skipped it). If no
// confident hit, it asks Anthropic Claude to pick from the canonical action
// catalogue and returns the structured result. Every call — match or AI — is
// persisted in `voice_command_log`.

import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "@workspace/db";
import {
  voiceAssistantSettingsTable,
  voiceCommandLogTable,
  workSessionsTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { writeAudit } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
router.use((req, res, next) => {
  if (!(req as any).authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

function getCid(req: any): number | null {
  const cid = resolveCompanyId(req, req.body?.companyId ?? req.query?.companyId);
  return cid ?? null;
}
function isAdmin(req: any): boolean {
  const role = req.authUser?.role;
  return role === "admin" || role === "superadmin";
}

const ALLOWED_MODELS = new Set([
  "claude-haiku-4-5",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-5",
  "claude-opus-4-7",
]);
const ALLOWED_LANGS = new Set(["ar-SA", "ar-EG", "ar-AE", "en-US", "en-GB"]);

function defaults(companyId: number) {
  return {
    companyId,
    enabled:               false,
    autoActivateOnLogin:   false,
    language:              "ar-SA",
    aiModel:               "claude-haiku-4-5",
    wakeWord:              null as string | null,
    confidenceThreshold:   50,
    voiceBiometricsEnabled: false,
    notes:                 "",
    updatedAt:             null as string | null,
    isDefault:             true,
  };
}

// ─── GET /settings/me/effective ───────────────────────────────────────────────
// Tiny non-admin slice consumed by the floating mic widget on every page so
// it knows whether to even render the FAB. We omit everything else (notes,
// AI model, recipients) to avoid leaking admin-only config to cashiers.
router.get("/settings/me/effective", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const [row] = await db.select().from(voiceAssistantSettingsTable)
      .where(eq(voiceAssistantSettingsTable.companyId, cid)).limit(1);
    res.json({
      enabled:              row?.enabled              ?? false,
      autoActivateOnLogin:  row?.autoActivateOnLogin  ?? false,
      language:             row?.language             ?? "ar-SA",
      confidenceThreshold:  row?.confidenceThreshold  ?? 50,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /settings ────────────────────────────────────────────────────────────
router.get("/settings", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    if (!isAdmin(req)) { res.status(403).json({ error: "هذه الصفحة متاحة فقط لمسؤولي الشركة" }); return; }

    const [row] = await db.select().from(voiceAssistantSettingsTable)
      .where(eq(voiceAssistantSettingsTable.companyId, cid)).limit(1);
    if (!row) { res.json(defaults(cid)); return; }

    res.json({
      companyId:            row.companyId,
      enabled:              row.enabled,
      autoActivateOnLogin:  row.autoActivateOnLogin,
      language:             row.language,
      aiModel:              row.aiModel,
      wakeWord:             row.wakeWord ?? null,
      confidenceThreshold:  row.confidenceThreshold,
      voiceBiometricsEnabled: row.voiceBiometricsEnabled,
      notes:                row.notes ?? "",
      updatedAt:            row.updatedAt?.toISOString() ?? null,
      isDefault:            false,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PUT /settings ────────────────────────────────────────────────────────────
router.put("/settings", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    if (!isAdmin(req)) { res.status(403).json({ error: "ممنوع — للمشرفين فقط" }); return; }

    const b = req.body ?? {};
    const language = String(b.language ?? "ar-SA");
    if (!ALLOWED_LANGS.has(language)) { res.status(400).json({ error: "اللغة غير مدعومة" }); return; }
    const aiModel = String(b.aiModel ?? "claude-haiku-4-5");
    if (!ALLOWED_MODELS.has(aiModel)) { res.status(400).json({ error: "نموذج الذكاء الاصطناعي غير مدعوم" }); return; }

    const confidenceThreshold = Math.max(0, Math.min(100,
      Number.isFinite(Number(b.confidenceThreshold)) ? Number(b.confidenceThreshold) : 50));
    const wakeWord = b.wakeWord ? String(b.wakeWord).trim().slice(0, 64) || null : null;
    const notes    = b.notes    ? String(b.notes).slice(0, 2000)              : "";

    const payload = {
      companyId:              cid,
      enabled:                Boolean(b.enabled),
      autoActivateOnLogin:    Boolean(b.autoActivateOnLogin),
      language,
      aiModel,
      wakeWord,
      confidenceThreshold,
      // Voice biometrics is a placeholder: stored but not enforced. The
      // actual speaker-verification step requires a paid vendor (Azure
      // Speaker Recognition or similar) and will be wired up in a future
      // task. Storing the toggle now keeps the migration cost out of that
      // future task.
      voiceBiometricsEnabled: Boolean(b.voiceBiometricsEnabled),
      notes,
      updatedByUserId:        (req as any).authUser?.id ?? null,
      updatedAt:              new Date(),
    };

    const [existing] = await db.select().from(voiceAssistantSettingsTable)
      .where(eq(voiceAssistantSettingsTable.companyId, cid)).limit(1);

    let saved;
    if (existing) {
      [saved] = await db.update(voiceAssistantSettingsTable)
        .set(payload)
        .where(eq(voiceAssistantSettingsTable.companyId, cid))
        .returning();
    } else {
      [saved] = await db.insert(voiceAssistantSettingsTable).values(payload).returning();
    }

    try {
      await writeAudit({
        userId: (req as any).authUser.id,
        username: (req as any).authUser.username,
        role: (req as any).authUser.role,
        companyId: cid,
        module: "voice_assistant_settings",
        action: "update",
        method: "PUT",
        path: "/api/voice-assistant/settings",
        statusCode: 200,
        ip: req.ip ?? null,
        userAgent: req.headers["user-agent"] as string ?? null,
        metadata: {
          enabled: payload.enabled,
          autoActivateOnLogin: payload.autoActivateOnLogin,
          language: payload.language,
          aiModel: payload.aiModel,
          // Track the policy intent toggle even though it's not enforced yet
          // — admins should be able to see in the audit trail when the switch
          // was flipped so the eventual enforcement rollout has a clear paper
          // trail of who pre-opted-in.
          voiceBiometricsEnabled: payload.voiceBiometricsEnabled,
        },
      });
    } catch { /* never block the save on audit */ }

    res.json({
      ok:                   true,
      companyId:            saved.companyId,
      enabled:              saved.enabled,
      autoActivateOnLogin:  saved.autoActivateOnLogin,
      language:             saved.language,
      aiModel:              saved.aiModel,
      wakeWord:             saved.wakeWord ?? null,
      confidenceThreshold:  saved.confidenceThreshold,
      voiceBiometricsEnabled: saved.voiceBiometricsEnabled,
      notes:                saved.notes ?? "",
      updatedAt:            saved.updatedAt?.toISOString() ?? null,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Voice action catalogue ───────────────────────────────────────────────────
//
// Mirror of the client's `voiceCommands.ts` catalogue. Kept inline here so the
// API server has zero cross-artifact import. If a route or verb is added to
// either side, also add it here so the AI parser knows about it. (The client
// catalogue stays canonical for offline matching; this list is canonical for
// the AI side.)
const ROUTE_CATALOG: Array<{ route: string; label: string; phrases: string[] }> = [
  { route: "/",                       label: "الرئيسية",                  phrases: ["الرئيسية", "لوحة التحكم"] },
  { route: "/zatca",                  label: "ربط زاتكا",                 phrases: ["ربط زاتكا", "زاتكا", "الفاتورة الإلكترونية"] },
  { route: "/invoices",               label: "الفواتير الإلكترونية",      phrases: ["الفواتير الإلكترونية"] },
  { route: "/sales",                  label: "المبيعات",                  phrases: ["المبيعات", "شاشة المبيعات"] },
  { route: "/sales/invoices",         label: "فواتير المبيعات",           phrases: ["فواتير المبيعات"] },
  { route: "/sales/invoices/new",     label: "فاتورة مبيعات جديدة",       phrases: ["فاتورة مبيعات جديدة", "فاتورة جديدة"] },
  { route: "/sales/quotations",       label: "عروض الأسعار",              phrases: ["عروض الأسعار"] },
  { route: "/sales/returns",          label: "مرتجعات المبيعات",          phrases: ["مرتجعات المبيعات"] },
  { route: "/customers",              label: "العملاء",                   phrases: ["العملاء"] },
  { route: "/purchasing",             label: "المشتريات",                 phrases: ["المشتريات"] },
  { route: "/purchasing/invoices",    label: "فواتير المشتريات",          phrases: ["فواتير المشتريات"] },
  { route: "/purchasing/invoices/new", label: "فاتورة مشتريات جديدة",     phrases: ["فاتورة مشتريات جديدة"] },
  { route: "/suppliers",              label: "الموردون",                  phrases: ["الموردون"] },
  { route: "/inventory",              label: "المخزون",                   phrases: ["المخزون"] },
  { route: "/inventory/items",        label: "الأصناف",                   phrases: ["الأصناف", "المنتجات"] },
  { route: "/inventory/warehouses",   label: "المستودعات",                phrases: ["المستودعات"] },
  { route: "/cash",                   label: "الخزينة",                   phrases: ["الخزينة", "النقدية"] },
  { route: "/cash/receipts",          label: "سندات القبض",               phrases: ["سندات القبض"] },
  { route: "/cash/payments",          label: "سندات الصرف",               phrases: ["سندات الصرف"] },
  { route: "/accounting",             label: "المحاسبة",                  phrases: ["المحاسبة"] },
  { route: "/accounting/journals",    label: "القيود",                    phrases: ["القيود اليومية", "اليومية"] },
  { route: "/accounting/accounts",    label: "شجرة الحسابات",             phrases: ["شجرة الحسابات", "الحسابات"] },
  { route: "/accounting/reports",     label: "التقارير المحاسبية",        phrases: ["التقارير المحاسبية"] },
  { route: "/vat-declaration",        label: "إقرار ضريبة القيمة المضافة", phrases: ["إقرار الضريبة", "ضريبة القيمة المضافة"] },
  { route: "/hr",                     label: "الموارد البشرية",           phrases: ["الموارد البشرية"] },
  { route: "/general-settings",       label: "الإعدادات العامة",          phrases: ["الإعدادات العامة"] },
  { route: "/users",                  label: "المستخدمون",                phrases: ["المستخدمون"] },
  { route: "/work-sessions",          label: "جلسات العمل",               phrases: ["جلسات العمل"] },
  { route: "/voice-assistant/settings", label: "إعدادات المساعد الصوتي",  phrases: ["إعدادات المساعد الصوتي"] },
];
const VERB_CATALOG: Array<{ verb: string; label: string; phrases: string[] }> = [
  { verb: "save",   label: "حفظ",         phrases: ["احفظ", "حفظ"] },
  { verb: "cancel", label: "إلغاء",       phrases: ["الغ", "إلغاء", "أغلق"] },
  { verb: "new",    label: "جديد",        phrases: ["جديد", "أضف جديد"] },
  { verb: "back",   label: "رجوع",        phrases: ["رجوع", "للوراء"] },
  { verb: "home",   label: "الرئيسية",    phrases: ["الصفحة الأولى"] },
  { verb: "logout", label: "تسجيل خروج",  phrases: ["تسجيل خروج", "خروج من النظام"] },
  { verb: "search", label: "بحث",         phrases: ["بحث", "ابحث"] },
  { verb: "reload", label: "تحديث",       phrases: ["حدث الصفحة", "تحديث"] },
];

function buildPrompt(transcript: string, contextRoute: string | null): string {
  const lines: string[] = [];
  lines.push(`أنت مساعد صوتي عربي لنظام محاسبي/فاتورة إلكترونية.`);
  lines.push(`مهمتك: تحويل ما قاله المستخدم إلى أمر منظّم (action) من القائمة أدناه فقط.`);
  lines.push(`لا تخترع مسارات. إذا لم يوجد تطابق واضح، أعد kind="unknown".`);
  lines.push("");
  lines.push("القائمة المتاحة (لكل عنصر اختر أحسن تطابق):");
  lines.push("");
  lines.push("الصفحات (kind=\"navigate\"):");
  for (const r of ROUTE_CATALOG) {
    lines.push(`  - route="${r.route}"  label="${r.label}"  مرادفات: ${r.phrases.join(" | ")}`);
  }
  lines.push("");
  lines.push("الأفعال العامة (kind=\"verb\"):");
  for (const v of VERB_CATALOG) {
    lines.push(`  - verb="${v.verb}"  label="${v.label}"  مرادفات: ${v.phrases.join(" | ")}`);
  }
  lines.push("");
  if (contextRoute) lines.push(`المستخدم الآن في الصفحة: ${contextRoute}`);
  lines.push(`نص المستخدم: «${transcript}»`);
  lines.push("");
  lines.push(`أعد JSON واحدة فقط بالشكل التالي بدون أي شرح أو تعليق:`);
  lines.push(`{ "kind": "navigate", "route": "/sales", "label": "المبيعات", "confidence": 0-100 }`);
  lines.push(`أو: { "kind": "verb", "verb": "save", "label": "حفظ", "confidence": 0-100 }`);
  lines.push(`أو: { "kind": "unknown", "reason": "تعذّر فهم الأمر", "confidence": 0 }`);
  return lines.join("\n");
}

function offlineMatch(transcript: string): { kind: "navigate"|"verb"; route?: string; verb?: string; label: string } | null {
  const norm = (s: string) => s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "")
    .replace(/[\u0622\u0623\u0625]/g, "\u0627")
    .replace(/\u0649/g, "\u064A")
    .replace(/\u0629/g, "\u0647")
    .replace(/\s+/g, " ")
    .trim();
  const t = norm(transcript);
  if (!t) return null;
  let best: { kind: "navigate"|"verb"; route?: string; verb?: string; label: string; len: number } | null = null;
  for (const r of ROUTE_CATALOG) {
    for (const p of r.phrases) {
      const np = norm(p);
      if (!np) continue;
      if (t === np) return { kind: "navigate", route: r.route, label: r.label };
      if (t.includes(np) && (!best || np.length > best.len)) {
        best = { kind: "navigate", route: r.route, label: r.label, len: np.length };
      }
    }
  }
  for (const v of VERB_CATALOG) {
    for (const p of v.phrases) {
      const np = norm(p);
      if (!np) continue;
      if (t === np) return { kind: "verb", verb: v.verb, label: v.label };
      if (t.includes(np) && (!best || np.length > best.len)) {
        best = { kind: "verb", verb: v.verb, label: v.label, len: np.length };
      }
    }
  }
  if (!best) return null;
  return { kind: best.kind, route: best.route, verb: best.verb, label: best.label };
}

// ─── POST /parse-command ──────────────────────────────────────────────────────
router.post("/parse-command", async (req, res) => {
  const cid = getCid(req);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
  const userId = (req as any).authUser.id as number;

  const transcript   = String(req.body?.transcript ?? "").trim();
  const contextRoute = req.body?.contextRoute ? String(req.body.contextRoute).slice(0, 256) : null;
  const confidence   = Number.isFinite(Number(req.body?.confidence)) ? Number(req.body.confidence) : null;

  if (!transcript) { res.status(400).json({ error: "النص الصوتي فارغ" }); return; }

  // Resolve the user's currently-open work-session (if any) for log linkage.
  let workSessionId: number | null = null;
  try {
    const [s] = await db.select({ id: workSessionsTable.id }).from(workSessionsTable)
      .where(and(
        eq(workSessionsTable.userId, userId),
        eq(workSessionsTable.companyId, cid),
        eq(workSessionsTable.status, "active"),
      )).limit(1);
    workSessionId = s?.id ?? null;
  } catch { /* ignore */ }

  // Verify the feature is enabled for this tenant.
  const [settings] = await db.select().from(voiceAssistantSettingsTable)
    .where(eq(voiceAssistantSettingsTable.companyId, cid)).limit(1);
  if (!settings?.enabled) {
    res.status(503).json({ error: "المساعد الصوتي غير مفعّل لهذه الشركة" });
    return;
  }

  // Below the per-tenant confidence floor → reject without burning AI tokens.
  if (confidence !== null && confidence < settings.confidenceThreshold) {
    await db.insert(voiceCommandLogTable).values({
      companyId: cid, userId, workSessionId,
      transcript, status: "unrecognized",
      action: "unknown",
      errorMessage: `الثقة منخفضة (${confidence}% < ${settings.confidenceThreshold}%)`,
      confidence, contextRoute,
    });
    res.json({ kind: "unknown", reason: "ثقة منخفضة في التعرّف الصوتي", source: "offline", confidence });
    return;
  }

  // 1) Try server-side offline match first (catches the obvious cases).
  const offline = offlineMatch(transcript);
  if (offline) {
    await db.insert(voiceCommandLogTable).values({
      companyId: cid, userId, workSessionId,
      transcript,
      parsed: offline as any,
      action: offline.kind === "navigate" ? "navigate" : `verb:${offline.verb}`,
      route: offline.route ?? null,
      status: "success",
      confidence, contextRoute,
    });
    res.json({ ...offline, source: "offline", confidence: 100 });
    return;
  }

  // 2) Ask Claude. If the env var isn't configured, fall back to "unknown"
  //    rather than 500ing — the feature should degrade gracefully.
  const apiKey  = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "";
  const baseURL = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL || undefined;
  if (!apiKey) {
    await db.insert(voiceCommandLogTable).values({
      companyId: cid, userId, workSessionId,
      transcript, status: "failed", action: "unknown",
      errorMessage: "خدمة الذكاء الاصطناعي غير مهيّأة",
      confidence, contextRoute,
    });
    res.status(503).json({ kind: "unknown", reason: "خدمة الذكاء الاصطناعي غير مهيّأة", source: "ai" });
    return;
  }

  const client = new Anthropic({ apiKey, baseURL });
  let parsed: any = { kind: "unknown", reason: "فشل التحليل" };
  try {
    const msg = await client.messages.create({
      model:     settings.aiModel,
      max_tokens: 256,
      messages:  [{ role: "user", content: buildPrompt(transcript, contextRoute) }],
    });
    const text = (msg.content?.[0] as any)?.text ?? "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch { /* keep default */ }
    }
  } catch (e: any) {
    await db.insert(voiceCommandLogTable).values({
      companyId: cid, userId, workSessionId,
      transcript, status: "failed", action: "unknown",
      errorMessage: e?.message ?? "AI error",
      confidence, contextRoute,
    });
    res.status(502).json({ kind: "unknown", reason: "تعذّر الاتصال بنموذج الذكاء الاصطناعي", source: "ai" });
    return;
  }

  // Validate the AI's pick is in our catalogue (defence-in-depth).
  if (parsed.kind === "navigate") {
    const ok = ROUTE_CATALOG.some(r => r.route === parsed.route);
    if (!ok) parsed = { kind: "unknown", reason: "مسار غير معروف" };
  } else if (parsed.kind === "verb") {
    const ok = VERB_CATALOG.some(v => v.verb === parsed.verb);
    if (!ok) parsed = { kind: "unknown", reason: "أمر غير معروف" };
  }

  // Persist & respond.
  await db.insert(voiceCommandLogTable).values({
    companyId: cid, userId, workSessionId,
    transcript,
    parsed,
    action: parsed.kind === "navigate" ? "navigate" :
            parsed.kind === "verb"     ? `verb:${parsed.verb}` : "unknown",
    route:  parsed.route ?? null,
    status: parsed.kind === "unknown" ? "unrecognized" : "success",
    errorMessage: parsed.kind === "unknown" ? (parsed.reason ?? null) : null,
    confidence, contextRoute,
  });

  res.json({ ...parsed, source: "ai" });
});

// ─── GET /log ─────────────────────────────────────────────────────────────────
router.get("/log", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const limit  = Math.min(200, Math.max(1, Number(req.query.limit  ?? 50)));
    const offset = Math.max(0, Number(req.query.offset ?? 0));
    const userScope = isAdmin(req)
      ? undefined
      : eq(voiceCommandLogTable.userId, (req as any).authUser.id);
    const rows = await db.select().from(voiceCommandLogTable)
      .where(and(eq(voiceCommandLogTable.companyId, cid), userScope))
      .orderBy(desc(voiceCommandLogTable.createdAt))
      .limit(limit).offset(offset);
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
