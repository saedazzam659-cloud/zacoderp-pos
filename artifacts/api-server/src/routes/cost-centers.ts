import { Router } from "express";
import { db } from "@workspace/db";
import {
  costCentersTable,
  journalEntriesTable, journalEntryLinesTable, accountsTable,
} from "@workspace/db";
import { eq, and, asc, gte, lte, desc, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId, branchScopeFilter } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("accounts"));
router.use(moduleAudit("accounts"));

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

// Validate parent belongs to same company; detect cycles by walking up the chain.
async function validateParent(cid: number, selfId: number | null, parentId: number | null): Promise<string | null> {
  if (!parentId) return null;
  if (selfId && parentId === selfId) return "لا يمكن أن يكون المركز أباً لنفسه";
  let current: number | null = parentId;
  let hops = 0;
  while (current) {
    if (++hops > 50) return "هرم مراكز التكلفة عميق جداً";
    const [row] = await db.select({ id: costCentersTable.id, parentId: costCentersTable.parentId, companyId: costCentersTable.companyId })
      .from(costCentersTable).where(eq(costCentersTable.id, current));
    if (!row) return "المركز الأب غير موجود";
    if (row.companyId !== cid) return "المركز الأب يخص شركة أخرى";
    if (selfId && row.id === selfId) return "لا يمكن إنشاء حلقة في الهرم (المركز يصبح أباً لنفسه)";
    current = row.parentId;
  }
  return null;
}

// ─── LIST ─────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const rows = await db.select().from(costCentersTable)
      .where(eq(costCentersTable.companyId, cid))
      .orderBy(asc(costCentersTable.code));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET ONE ──────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    const [row] = await db.select().from(costCentersTable)
      .where(and(eq(costCentersTable.id, id), eq(costCentersTable.companyId, cid)));
    if (!row) { res.status(404).json({ error: "مركز التكلفة غير موجود" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Generate the next default cost-center code in the form CC-#### by counting
// existing rows for the company. Used only when the user did not type a code
// — explicit user codes are kept verbatim.
async function nextDefaultCode(cid: number): Promise<string> {
  const existing = await db.select({ id: costCentersTable.id })
    .from(costCentersTable).where(eq(costCentersTable.companyId, cid));
  // Probe up to 50 times in case of code collisions caused by manually-typed
  // codes that happen to hit the auto-pattern; bumps the counter each round.
  for (let i = 1; i <= 50; i++) {
    const candidate = `CC-${String(existing.length + i).padStart(4, "0")}`;
    const [dup] = await db.select({ id: costCentersTable.id }).from(costCentersTable)
      .where(and(eq(costCentersTable.companyId, cid), eq(costCentersTable.code, candidate)));
    if (!dup) return candidate;
  }
  return `CC-${Date.now()}`;
}

// ─── CREATE ───────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { code, nameAr, nameEn, parentId, level, isPosting, isActive, notes } = req.body;
    if (!nameAr || !String(nameAr).trim()) {
      res.status(400).json({ error: "اسم مركز التكلفة مطلوب" }); return;
    }

    // Auto-generate the code if the user left it blank; explicit codes still
    // pass through verbatim so semantic naming (e.g. "ADMIN") keeps working.
    const finalCode = (code && String(code).trim())
      ? String(code).trim()
      : await nextDefaultCode(cid);

    // Uniqueness check (code per company)
    const [dup] = await db.select().from(costCentersTable)
      .where(and(eq(costCentersTable.companyId, cid), eq(costCentersTable.code, finalCode)));
    if (dup) { res.status(400).json({ error: "كود مركز التكلفة مستخدم بالفعل" }); return; }

    const pid = parentId ? Number(parentId) : null;
    const parentErr = await validateParent(cid, null, pid);
    if (parentErr) { res.status(400).json({ error: parentErr }); return; }

    const [row] = await db.insert(costCentersTable).values({
      companyId: cid,
      code: finalCode,
      nameAr, nameEn: nameEn || null,
      parentId: pid,
      level: level ?? (pid ? 2 : 1),
      isPosting: isPosting ?? true,
      isActive:  isActive  ?? true,
      notes: notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── UPDATE ───────────────────────────────────────────────────────────────────
router.put("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    const { code, nameAr, nameEn, parentId, level, isPosting, isActive, notes } = req.body;
    const pid = parentId ? Number(parentId) : null;
    const parentErr = await validateParent(cid, id, pid);
    if (parentErr) { res.status(400).json({ error: parentErr }); return; }

    // If code is changing, ensure uniqueness within company
    const trimmedCode = String(code).trim();
    const [existing] = await db.select().from(costCentersTable)
      .where(and(eq(costCentersTable.id, id), eq(costCentersTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "مركز التكلفة غير موجود" }); return; }
    if (existing.code !== trimmedCode) {
      const [dup] = await db.select().from(costCentersTable)
        .where(and(eq(costCentersTable.companyId, cid), eq(costCentersTable.code, trimmedCode)));
      if (dup) { res.status(400).json({ error: "كود مركز التكلفة مستخدم بالفعل" }); return; }
    }

    const [row] = await db.update(costCentersTable).set({
      code: trimmedCode,
      nameAr, nameEn: nameEn || null,
      parentId: pid,
      level: level ?? (pid ? 2 : 1),
      isPosting: isPosting ?? true,
      isActive:  isActive  ?? true,
      notes: notes || null,
      updatedAt: new Date(),
    }).where(and(eq(costCentersTable.id, id), eq(costCentersTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "مركز التكلفة غير موجود" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── TRANSACTIONS (for the second tab) ────────────────────────────────────────
// Returns every journal-entry line whose `cost_center` text equals this
// center's code, joined with the entry header (date, doc, description) and
// the account it posts to. Optional `from`/`to` (YYYY-MM-DD) date filters
// scope the result to a window. Includes:
//   - rows[]   : per-line records (date, doc, account, debit, credit, …)
//   - totals   : { totalDebit, totalCredit, balance }   (balance = debit−credit)
//   - byAccount: { accountId, accountCode, accountName, debit, credit, balance }[]
router.get("/:id/transactions", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    const [center] = await db.select().from(costCentersTable)
      .where(and(eq(costCentersTable.id, id), eq(costCentersTable.companyId, cid)));
    if (!center) { res.status(404).json({ error: "مركز التكلفة غير موجود" }); return; }

    const from = String(req.query.from || "").trim();
    const to   = String(req.query.to   || "").trim();

    const conds: any[] = [
      eq(journalEntriesTable.companyId, cid),
      eq(journalEntryLinesTable.costCenter, center.code),
      // Posted-only: draft/void entries must not influence reported balances
      // or the AI insights derived from them.
      eq(journalEntriesTable.status, "posted"),
    ];
    if (from) conds.push(gte(journalEntriesTable.entryDate, from));
    if (to)   conds.push(lte(journalEntriesTable.entryDate, to));
    // Branch-scope: restricted users (viewAllBranches=false) only see entries
    // tied to one of their allowed branches. Returns SQL false → empty result
    // when the user has zero linked branches.
    const branchCond = branchScopeFilter(req as any, journalEntriesTable.branchId);
    if (branchCond) conds.push(branchCond);

    const rows = await db.select({
      lineId:       journalEntryLinesTable.id,
      entryId:      journalEntriesTable.id,
      docNumber:    journalEntriesTable.docNumber,
      entryDate:    journalEntriesTable.entryDate,
      entryType:    journalEntriesTable.entryType,
      entryStatus:  journalEntriesTable.status,
      entryDescription: journalEntriesTable.description,
      lineDescription: journalEntryLinesTable.description,
      accountId:    journalEntryLinesTable.accountId,
      accountCode:  accountsTable.code,
      accountNameAr: accountsTable.nameAr,
      accountNameEn: accountsTable.nameEn,
      debit:        journalEntryLinesTable.debit,
      credit:       journalEntryLinesTable.credit,
    })
      .from(journalEntryLinesTable)
      .leftJoin(journalEntriesTable, eq(journalEntriesTable.id, journalEntryLinesTable.entryId))
      .leftJoin(accountsTable, eq(accountsTable.id, journalEntryLinesTable.accountId))
      .where(and(...conds))
      .orderBy(desc(journalEntriesTable.entryDate), desc(journalEntriesTable.id));

    let totalDebit = 0, totalCredit = 0;
    const byAcc = new Map<number, any>();
    for (const r of rows) {
      const d = Number(r.debit  ?? 0);
      const c = Number(r.credit ?? 0);
      totalDebit  += d;
      totalCredit += c;
      if (r.accountId) {
        const k = Number(r.accountId);
        const cur = byAcc.get(k) || {
          accountId:     k,
          accountCode:   r.accountCode || "",
          accountNameAr: r.accountNameAr || "",
          accountNameEn: r.accountNameEn || "",
          debit: 0, credit: 0, count: 0,
        };
        cur.debit  += d;
        cur.credit += c;
        cur.count  += 1;
        byAcc.set(k, cur);
      }
    }
    const byAccount = Array.from(byAcc.values())
      .map(a => ({ ...a, balance: a.debit - a.credit }))
      .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));

    res.json({
      center:    { id: center.id, code: center.code, nameAr: center.nameAr, nameEn: center.nameEn },
      range:     { from: from || null, to: to || null },
      rows,
      totals:    { totalDebit, totalCredit, balance: totalDebit - totalCredit, lineCount: rows.length },
      byAccount,
    });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "cost-center transactions failed");
    res.status(500).json({ error: e.message });
  }
});

// ─── AI INSIGHTS (for the second tab) ─────────────────────────────────────────
// Sends a compact summary of a cost-center's transactions to the OpenAI
// proxy and returns a structured insights JSON. Mirrors the
// /sales-analytics/payment-mix-report/ai-insights pattern.
router.post("/:id/ai-insights", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    const [center] = await db.select().from(costCentersTable)
      .where(and(eq(costCentersTable.id, id), eq(costCentersTable.companyId, cid)));
    if (!center) { res.status(404).json({ error: "مركز التكلفة غير موجود" }); return; }

    const OPENAI_BASE = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    const OPENAI_KEY  = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    if (!OPENAI_BASE || !OPENAI_KEY) {
      res.status(503).json({ error: "خدمة الذكاء الاصطناعي غير متاحة" });
      return;
    }

    const { totals, byAccount, range, language } = req.body ?? {};
    if (!totals || !Array.isArray(byAccount)) {
      res.status(400).json({ error: "بيانات التحليل غير مكتملة" });
      return;
    }
    const lang: "ar" | "en" = language === "en" ? "en" : "ar";
    const fmt = (n: any) => Number(n ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 });

    let summary = `مركز التكلفة: ${center.code} — ${center.nameAr}\n`;
    if (range?.from || range?.to) {
      summary += `الفترة: ${range.from || "البداية"} → ${range.to || "اليوم"}\n`;
    }
    summary += `إجمالي المدين: ${fmt(totals.totalDebit)} ر.س\n`;
    summary += `إجمالي الدائن: ${fmt(totals.totalCredit)} ر.س\n`;
    summary += `الرصيد: ${fmt(totals.balance)} ر.س (${Number(totals.balance) >= 0 ? "مدين" : "دائن"})\n`;
    summary += `عدد البنود: ${totals.lineCount}\n\n`;
    summary += `أكبر الحسابات المرتبطة بهذا المركز:\n`;
    for (const a of byAccount.slice(0, 10)) {
      summary += `- ${a.accountCode} ${a.accountNameAr}: مدين ${fmt(a.debit)} / دائن ${fmt(a.credit)} / رصيد ${fmt(a.balance)}\n`;
    }

    const systemPrompt = lang === "ar"
      ? `أنت مستشار محاسبي خبير لشركة سعودية. حلّل بيانات مركز تكلفة محدد. ركّز على: حجم النشاط، التوازن بين المدين والدائن، طبيعة الحسابات السائدة (مصاريف/إيرادات/أصول)، وأي تركّز غير صحي. قدّم رؤى عملية بالعربية الفصحى.
ردّ بصيغة JSON فقط:
{
  "headline":       "<ملخص النشاط في جملة قوية>",
  "highlights":     ["<نقطة قوة 1>", "<نقطة قوة 2>", "<نقطة قوة 3>"],
  "concerns":       ["<تحذير 1>", "<تحذير 2>"],
  "recommendation": "<توصية واحدة عملية>"
}`
      : `You are an expert accounting advisor for a Saudi company. Analyze a specific cost center: activity volume, debit/credit balance, dominant account types (expense/revenue/asset), and any unhealthy concentration.
Respond ONLY in JSON:
{
  "headline":       "<one strong summary sentence>",
  "highlights":     ["<strength 1>", "<strength 2>", "<strength 3>"],
  "concerns":       ["<warning 1>", "<warning 2>"],
  "recommendation": "<one actionable recommendation>"
}`;

    const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: "gpt-5.4",
        max_completion_tokens: 1024,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: summary },
        ],
      }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      res.status(502).json({ error: `فشل الذكاء الاصطناعي: ${r.status} ${txt.slice(0, 200)}` });
      return;
    }
    const data: any = await r.json();
    const content: string = data?.choices?.[0]?.message?.content ?? "{}";
    let parsed: any = {};
    try { parsed = JSON.parse(content); } catch { /* ignore */ }
    res.json({
      headline:       String(parsed.headline ?? ""),
      highlights:     Array.isArray(parsed.highlights) ? parsed.highlights.map(String) : [],
      concerns:       Array.isArray(parsed.concerns)   ? parsed.concerns.map(String)   : [],
      recommendation: String(parsed.recommendation ?? ""),
      source:         "ai",
    });
  } catch (e: any) {
    req.log?.error?.({ err: e }, "cost-center ai-insights failed");
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE ───────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    // Block delete if any children exist
    const children = await db.select({ id: costCentersTable.id }).from(costCentersTable)
      .where(and(eq(costCentersTable.companyId, cid), eq(costCentersTable.parentId, id)));
    if (children.length > 0) {
      res.status(400).json({ error: "لا يمكن حذف مركز له مراكز فرعية" }); return;
    }
    await db.delete(costCentersTable).where(and(eq(costCentersTable.id, id), eq(costCentersTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
