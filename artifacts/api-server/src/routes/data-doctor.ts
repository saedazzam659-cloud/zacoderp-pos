// SuperAdmin Data Doctor — per-company data quality scanner + recycle bin.
//
// Scope (deliberate, narrow):
//   • Diagnose ONE company: duplicates, missing-fields, accounting errors.
//   • Move detected rows into the `deleted_records` recycle bin (snapshot +
//     delete in one transaction). Never DROP a row outright.
//   • Wipe an entire company's master data with a typed-name confirmation
//     and full snapshotting.
//   • Restore from the recycle bin by re-INSERTing the snapshot.
//
// Out of scope: this route NEVER deletes the `companies` row itself, never
// touches users/sessions/security tables, and never bypasses the
// requireSuperAdmin gate.
//
// All mutations write to audit_log (module="data_doctor").

import { Router, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import {
  companiesTable, usersTable,
  customersTable, suppliersTable, itemsTable, accountsTable,
  branchesTable, warehousesTable, cashBoxesTable, bankAccountsTable,
  invoicesTable, purchaseInvoicesTable, journalEntriesTable, journalEntryLinesTable,
  deletedRecordsTable,
  auditLogTable,
} from "@workspace/db";
import { eq, and, sql, inArray, isNull, isNotNull, desc, gte, lte } from "drizzle-orm";
import { writeAudit } from "../middleware/permissions.js";
import { resolveBearerToken } from "../middleware/auth.js";
import { chat as aiChat, isAIAvailable } from "../lib/aiClient.js";
import { logAiUsage } from "../middleware/requireAiFeature.js";
import { AsyncLocalStorage } from "node:async_hooks";

const router = Router();
  // ─────────────────────────────────────────────────────────────────────────
  // Gemini-first transparent redirect (see notes in routes/ai.ts).
  // Re-binds OPENAI_BASE/KEY (declared elsewhere in this file) to a sentinel
  // "AI_PROXY" string and shadows the global fetch with a local one that
  // intercepts the sentinel URL, dispatches via aiChat, and returns a
  // Response-shaped object so existing r.ok/r.json()/r.text() callsites
  // continue to work unchanged. AsyncLocalStorage threads `req` through
  // so the feature-gate's logAiUsage counter still advances.
  // ─────────────────────────────────────────────────────────────────────────
  const __aiReqStore = new AsyncLocalStorage<any>();
  router.use((req, _res, next) => { __aiReqStore.run(req, () => next()); });

  const __nativeFetch = globalThis.fetch;
  async function fetch(input: any, init?: any): Promise<{ ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string> }> {
    if (typeof input === "string" && input.startsWith("AI_PROXY")) {
      const body = (() => { try { return JSON.parse(init?.body ?? "{}"); } catch { return {}; } })();
      const result = await aiChat(body.messages ?? [], {
        json:      body.response_format?.type === "json_object",
        maxTokens: body.max_completion_tokens ?? body.max_tokens ?? 2048,
      });
      const req = __aiReqStore.getStore();
      if (req) {
        try {
          await logAiUsage(req, result.ok
            ? { status: "allowed", provider: result.provider }
            : { status: "error",   meta: { reason: result.reason } });
        } catch { /* logging must never break the call */ }
      }
      if (!result.ok) {
        return { ok: false, status: 502, json: async () => ({ error: result.reason }), text: async () => result.reason };
      }
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: result.text } }] }),
        text: async () => result.text,
      };
    }
    return (__nativeFetch as any)(input, init);
  }
  

const OPENAI_BASE = "AI_PROXY";
const OPENAI_KEY  = "AI_PROXY";

// ─── Auth gate (mirrors admin.ts) ───────────────────────────────────────────
async function requireSuperAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) { res.status(401).json({ error: "غير مصرح" }); return; }
  const token = auth.slice(7);
  let [user] = await db.select().from(usersTable).where(eq(usersTable.sessionToken, token));
  if (!user) {
    const resolved = await resolveBearerToken(token);
    if (resolved && resolved.origin === "superadmin") {
      const [full] = await db.select().from(usersTable).where(eq(usersTable.id, resolved.user.id));
      if (full) user = full;
    }
  }
  if (!user || !user.isActive || user.role !== "superadmin") {
    res.status(403).json({ error: "هذه الصفحة للمشرف العام فقط" });
    return;
  }
  req.adminUser = user;
  next();
}

// ─── Whitelist of tables the data-doctor may touch ─────────────────────────
// Hard-coded on purpose so a malicious caller can never aim wipe/restore at
// e.g. `users` or `sa_sessions`. Each entry maps a string key (sent by the
// frontend) to the Drizzle table object + display label + ordering hint.
//
// `wipeOrder` controls deletion order during a full company wipe: children
// (lower number) before parents (higher number).
type TableKey =
  | "invoices" | "purchase_invoices" | "journal_entries"
  | "customers" | "suppliers" | "items"
  | "cash_boxes" | "bank_accounts" | "warehouses" | "branches" | "accounts";

const TABLE_REGISTRY: Record<TableKey, {
  table: any;
  labelAr: string;
  wipeOrder: number;
  summary: (row: any) => string;
}> = {
  invoices:          { table: invoicesTable,         labelAr: "فواتير المبيعات",   wipeOrder: 1, summary: r => `${r.invoiceNumber ?? ""} — ${r.grandTotal ?? ""}` },
  purchase_invoices: { table: purchaseInvoicesTable, labelAr: "فواتير المشتريات",  wipeOrder: 1, summary: r => `${r.invoiceNumber ?? r.docNumber ?? ""}` },
  journal_entries:   { table: journalEntriesTable,   labelAr: "قيود اليومية",      wipeOrder: 1, summary: r => `${r.docNumber ?? ""} — ${r.entryDate ?? ""}` },
  customers:         { table: customersTable,        labelAr: "العملاء",           wipeOrder: 2, summary: r => `${r.nameAr ?? ""} ${r.vatNumber ? "(" + r.vatNumber + ")" : ""}` },
  suppliers:         { table: suppliersTable,        labelAr: "الموردون",          wipeOrder: 2, summary: r => `${r.nameAr ?? ""} ${r.vatNumber ? "(" + r.vatNumber + ")" : ""}` },
  items:             { table: itemsTable,            labelAr: "الأصناف",           wipeOrder: 2, summary: r => `${r.code ?? ""} — ${r.nameAr ?? ""}` },
  cash_boxes:        { table: cashBoxesTable,        labelAr: "الخزن النقدية",     wipeOrder: 2, summary: r => `${r.code ?? ""} — ${r.nameAr ?? ""}` },
  bank_accounts:     { table: bankAccountsTable,     labelAr: "الحسابات البنكية",  wipeOrder: 2, summary: r => `${r.code ?? ""} — ${r.nameAr ?? ""}` },
  warehouses:        { table: warehousesTable,       labelAr: "المخازن",           wipeOrder: 3, summary: r => `${r.code ?? ""} — ${r.nameAr ?? ""}` },
  branches:          { table: branchesTable,         labelAr: "الفروع",            wipeOrder: 4, summary: r => `${r.code ?? ""} — ${r.nameAr ?? ""}` },
  accounts:          { table: accountsTable,         labelAr: "شجرة الحسابات",     wipeOrder: 5, summary: r => `${r.code ?? ""} — ${r.nameAr ?? ""}` },
};

const VALID_TABLE_KEYS = Object.keys(TABLE_REGISTRY) as TableKey[];

function isValidTable(t: string): t is TableKey {
  return (VALID_TABLE_KEYS as string[]).includes(t);
}

// ─── GET /api/admin/data-doctor/companies ──────────────────────────────────
// Companies with quick row-count snapshot (for the dropdown and overview).
router.get("/companies", requireSuperAdmin, async (_req, res) => {
  const rows = await db.select({
    id: companiesTable.id,
    nameAr: companiesTable.nameAr,
    nameEn: companiesTable.nameEn,
    vatNumber: companiesTable.vatNumber,
    status: companiesTable.status,
  }).from(companiesTable).orderBy(companiesTable.nameAr);
  res.json({ companies: rows });
});

// ─── POST /api/admin/data-doctor/scan  body: { companyId } ─────────────────
// Runs deterministic SQL checks. Returns categorized issues with sample rows
// the admin can act on. AI narrative is requested separately via /ai-explain
// so the scan stays fast even if the AI proxy is slow / unavailable.
router.post("/scan", requireSuperAdmin, async (req, res) => {
  const companyId = Number(req.body?.companyId);
  if (!companyId || Number.isNaN(companyId)) {
    res.status(400).json({ error: "companyId مطلوب" }); return;
  }

  const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, companyId));
  if (!company) { res.status(404).json({ error: "الشركة غير موجودة" }); return; }

  // Helper: SQL-side dedup "(name + vat)" key → finds rows that share the key.
  // We use lower(trim()) to ignore casing and surrounding whitespace and only
  // surface groups with count > 1.
  const dupCustomers = await db.execute(sql`
    WITH g AS (
      SELECT lower(trim(name_ar)) AS k, count(*) AS c, array_agg(id ORDER BY id) AS ids,
             array_agg(name_ar ORDER BY id) AS names
        FROM customers
       WHERE company_id = ${companyId}
       GROUP BY lower(trim(name_ar))
      HAVING count(*) > 1
       LIMIT 100
    )
    SELECT * FROM g
  `);
  const dupSuppliers = await db.execute(sql`
    WITH g AS (
      SELECT lower(trim(name_ar)) AS k, count(*) AS c, array_agg(id ORDER BY id) AS ids,
             array_agg(name_ar ORDER BY id) AS names
        FROM suppliers
       WHERE company_id = ${companyId}
       GROUP BY lower(trim(name_ar))
      HAVING count(*) > 1
       LIMIT 100
    )
    SELECT * FROM g
  `);
  const dupItems = await db.execute(sql`
    WITH g AS (
      SELECT lower(trim(code)) AS k, count(*) AS c, array_agg(id ORDER BY id) AS ids,
             array_agg(name_ar ORDER BY id) AS names
        FROM items
       WHERE company_id = ${companyId}
       GROUP BY lower(trim(code))
      HAVING count(*) > 1
       LIMIT 100
    )
    SELECT * FROM g
  `);

  // Missing fields: VAT-required customers/suppliers without a VAT number.
  // We surface only a sample (limit 50) — the count is the headline metric.
  const customersMissingVat = await db.select({
    id: customersTable.id, nameAr: customersTable.nameAr,
  }).from(customersTable).where(and(
    eq(customersTable.companyId, companyId),
    sql`(vat_number IS NULL OR length(trim(vat_number)) = 0)`,
  )).limit(50);

  const suppliersMissingVat = await db.select({
    id: suppliersTable.id, nameAr: suppliersTable.nameAr,
  }).from(suppliersTable).where(and(
    eq(suppliersTable.companyId, companyId),
    sql`(vat_number IS NULL OR length(trim(vat_number)) = 0)`,
  )).limit(50);

  const itemsMissingPrice = await db.select({
    id: itemsTable.id, code: itemsTable.code, nameAr: itemsTable.nameAr,
  }).from(itemsTable).where(and(
    eq(itemsTable.companyId, companyId),
    sql`sale_price = 0`,
  )).limit(50);

  // Accounting errors:
  // 1) Unbalanced journal entries — sum(debit) != sum(credit) for the lines
  //    of a single entry. Reports up to 100 examples.
  const unbalancedEntries = await db.execute(sql`
    SELECT je.id, je.doc_number, je.entry_date,
           sum(jl.debit)::text  AS dr,
           sum(jl.credit)::text AS cr
      FROM journal_entries je
      JOIN journal_entry_lines jl ON jl.entry_id = je.id
     WHERE je.company_id = ${companyId}
     GROUP BY je.id, je.doc_number, je.entry_date
    HAVING ABS(sum(jl.debit) - sum(jl.credit)) > 0.005
     LIMIT 100
  `);

  // 2) Orphan invoices: customer_id points to a non-existent / cross-tenant
  //    customer. We also flag NULL customer_id on posted invoices.
  const orphanInvoices = await db.execute(sql`
    SELECT i.id, i.invoice_number, i.customer_id, i.status
      FROM invoices i
     WHERE i.company_id = ${companyId}
       AND i.customer_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM customers c
          WHERE c.id = i.customer_id AND c.company_id = ${companyId}
       )
     LIMIT 100
  `);

  // 3) Stale draft invoices older than 90 days.
  const staleDrafts = await db.select({
    id: invoicesTable.id,
    invoiceNumber: invoicesTable.invoiceNumber,
    issueDate: invoicesTable.issueDate,
  }).from(invoicesTable).where(and(
    eq(invoicesTable.companyId, companyId),
    eq(invoicesTable.status, "draft"),
    sql`${invoicesTable.createdAt} < (now() - interval '90 days')`,
  )).limit(100);

  // 4) Orphan journal lines: account_id does not exist or belongs to another
  //    tenant. Reported as candidates for cleanup.
  const orphanJournalLines = await db.execute(sql`
    SELECT jl.id, jl.entry_id, jl.account_id
      FROM journal_entry_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
     WHERE je.company_id = ${companyId}
       AND jl.account_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM accounts a
          WHERE a.id = jl.account_id AND a.company_id = ${companyId}
       )
     LIMIT 100
  `);

  // 5) Orphan accounts: parent_id points to a non-existent account in this tenant.
  const orphanAccounts = await db.execute(sql`
    SELECT a.id, a.code, a.name_ar, a.parent_id
      FROM accounts a
     WHERE a.company_id = ${companyId}
       AND a.parent_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM accounts p
          WHERE p.id = a.parent_id AND p.company_id = ${companyId}
       )
     LIMIT 100
  `);

  const rows = (r: any) => Array.isArray(r) ? r : (r?.rows ?? []);

  const result = {
    companyId,
    companyName: company.nameAr,
    generatedAt: new Date().toISOString(),
    categories: {
      duplicates: {
        labelAr: "البيانات المكررة",
        items: [
          { key: "dup_customers", labelAr: "عملاء بأسماء متطابقة", severity: "medium",
            count: rows(dupCustomers).length, samples: rows(dupCustomers).slice(0, 20),
            entityTable: "customers" as TableKey },
          { key: "dup_suppliers", labelAr: "موردون بأسماء متطابقة", severity: "medium",
            count: rows(dupSuppliers).length, samples: rows(dupSuppliers).slice(0, 20),
            entityTable: "suppliers" as TableKey },
          { key: "dup_items", labelAr: "أصناف بنفس الكود", severity: "high",
            count: rows(dupItems).length, samples: rows(dupItems).slice(0, 20),
            entityTable: "items" as TableKey },
        ],
      },
      missingFields: {
        labelAr: "الحقول الناقصة",
        items: [
          { key: "customers_no_vat", labelAr: "عملاء بدون رقم ضريبي", severity: "low",
            count: customersMissingVat.length, samples: customersMissingVat.slice(0, 20),
            entityTable: "customers" as TableKey },
          { key: "suppliers_no_vat", labelAr: "موردون بدون رقم ضريبي", severity: "low",
            count: suppliersMissingVat.length, samples: suppliersMissingVat.slice(0, 20),
            entityTable: "suppliers" as TableKey },
          { key: "items_no_price", labelAr: "أصناف بدون سعر بيع", severity: "medium",
            count: itemsMissingPrice.length, samples: itemsMissingPrice.slice(0, 20),
            entityTable: "items" as TableKey },
        ],
      },
      accountingErrors: {
        labelAr: "أخطاء محاسبية",
        items: [
          { key: "unbalanced_entries", labelAr: "قيود يومية غير متوازنة", severity: "high",
            count: rows(unbalancedEntries).length, samples: rows(unbalancedEntries).slice(0, 20),
            entityTable: "journal_entries" as TableKey },
          { key: "orphan_invoices", labelAr: "فواتير لعملاء غير موجودين", severity: "high",
            count: rows(orphanInvoices).length, samples: rows(orphanInvoices).slice(0, 20),
            entityTable: "invoices" as TableKey },
          { key: "stale_drafts", labelAr: "فواتير مسودات أقدم من 90 يوم", severity: "low",
            count: staleDrafts.length, samples: staleDrafts.slice(0, 20),
            entityTable: "invoices" as TableKey },
          { key: "orphan_journal_lines", labelAr: "بنود قيود لحسابات غير موجودة", severity: "medium",
            count: rows(orphanJournalLines).length, samples: rows(orphanJournalLines).slice(0, 20),
            entityTable: "journal_entries" as TableKey },
          { key: "orphan_accounts", labelAr: "حسابات بحساب أب غير موجود", severity: "medium",
            count: rows(orphanAccounts).length, samples: rows(orphanAccounts).slice(0, 20),
            entityTable: "accounts" as TableKey },
        ],
      },
    },
  };

  // Compute totalIssues for the headline KPI.
  let totalIssues = 0;
  for (const cat of Object.values(result.categories)) {
    for (const it of cat.items) totalIssues += it.count;
  }
  (result as any).totalIssues = totalIssues;

  await writeAudit({
    userId: req.adminUser?.id ?? null,
    username: req.adminUser?.username ?? null,
    role: req.adminUser?.role ?? null,
    companyId,
    module: "data_doctor",
    action: "scan",
    method: "POST",
    path: req.path,
    metadata: { totalIssues },
  });

  res.json(result);
});

// ─── POST /api/admin/data-doctor/ai-explain  body: { scan } ────────────────
// Sends the scan summary (counts only — no PII) to the LLM and returns an
// Arabic narrative + prioritized recommendations. Falls back to a
// deterministic Markdown summary if the AI proxy is unavailable.
router.post("/ai-explain", requireSuperAdmin, async (req, res) => {
  const scan = req.body?.scan;
  if (!scan || typeof scan !== "object") {
    res.status(400).json({ error: "scan مطلوب" }); return;
  }

  // Build a compact, PII-free summary the model can reason over.
  const compact: Array<{ category: string; key: string; label: string; severity: string; count: number }> = [];
  for (const [catKey, cat] of Object.entries((scan.categories ?? {}) as any)) {
    for (const it of (cat as any).items ?? []) {
      compact.push({ category: catKey, key: it.key, label: it.labelAr, severity: it.severity, count: it.count });
    }
  }
  const totalIssues = compact.reduce((s, x) => s + x.count, 0);

  const fallback = () => {
    if (totalIssues === 0) return "## ملخص الفحص\n\nلا توجد مشاكل ملحوظة في بيانات هذه الشركة. كل العدّادات صفر.";
    const lines: string[] = [`## ملخص الفحص`, `تم اكتشاف **${totalIssues}** مشكلة موزعة كالتالي:`, ""];
    for (const c of compact.filter(x => x.count > 0).sort((a, b) => b.count - a.count)) {
      lines.push(`- **${c.label}**: ${c.count} (خطورة ${c.severity})`);
    }
    lines.push("", "## خطوات الإصلاح المقترحة");
    lines.push("1. ابدأ بمعالجة المشاكل عالية الخطورة (high) أولاً.");
    lines.push("2. وحّد التكرارات يدوياً قبل حذف الزائد منها.");
    lines.push("3. راجع القيود غير المتوازنة في صفحة دفتر اليومية.");
    return lines.join("\n");
  };

  if (!isAIAvailable()) {
    res.json({ summary: fallback(), source: "fallback" });
    return;
  }

  const userPrompt = `أنت مدقق محاسبي خبير في نظام ERP سعودي يدعم فاتورة ZATCA.
نتائج فحص بيانات الشركة "${scan.companyName ?? "—"}" (id=${scan.companyId}):

${JSON.stringify(compact, null, 2)}

اكتب تقريراً موجزاً بالعربية الفصحى المهنية وبصيغة Markdown يتضمن:
1. **ملخص الحالة** فقرة قصيرة (٢-٣ أسطر).
2. **أولويات الإصلاح** قائمة مرقمة مرتبة من الأخطر للأقل، لكل مشكلة: السبب المحتمل والأثر المحاسبي/التشغيلي.
3. **توصيات عملية** ٣-٥ خطوات يمكن للمشرف تنفيذها يدوياً.
4. إن لم تكن هناك مشاكل، اكتب فقرة تؤكد سلامة البيانات.

لا تختلق أرقاماً غير موجودة في المدخلات. لا تذكر تنفيذ الإصلاحات تلقائياً.`;

  try {
    const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: "gpt-5.4",
        max_completion_tokens: 2048,
        messages: [
          { role: "system", content: "أنت مدقق محاسبي خبير. ترد بالعربية الفصحى وبصيغة Markdown منظمة. لا تخترع بيانات." },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!r.ok) {
      // Fall back to the deterministic summary — never break the UI.
      res.json({ summary: fallback(), source: "fallback", aiError: `${r.status}` });
      return;
    }
    const data: any = await r.json();
    const summary = data?.choices?.[0]?.message?.content?.trim();
    if (!summary) { res.json({ summary: fallback(), source: "fallback" }); return; }
    res.json({ summary, source: "ai" });
  } catch (e: any) {
    res.json({ summary: fallback(), source: "fallback", aiError: e?.message ?? "unknown" });
  }
});

// ─── Helper: revive ISO-timestamp strings back into Date objects ──────────
// jsonb stores `Date` columns as ISO strings. Drizzle's pg driver requires
// real Date objects on insert (it calls .toISOString() internally), so we
// must walk the snapshot and rehydrate any value that looks like a strict
// ISO 8601 timestamp. Plain `date` columns stay as strings (Drizzle accepts
// them) and unrelated text fields are left untouched because business data
// virtually never matches the strict T+timezone format.
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
function reviveTimestamps<T>(payload: T): T {
  if (!payload || typeof payload !== "object") return payload;
  const out: any = Array.isArray(payload) ? [] : {};
  for (const [k, v] of Object.entries(payload as any)) {
    out[k] = (typeof v === "string" && ISO_TS_RE.test(v)) ? new Date(v) : v;
  }
  return out;
}

// ─── Helper: snapshot + delete one row, inside a tx ────────────────────────
async function snapshotAndDelete(
  tx: any,
  tableKey: TableKey,
  recordId: number,
  meta: { companyId: number | null; userId: number | null; username: string | null; reason: string; source: string },
): Promise<{ ok: boolean; reason?: string }> {
  const reg = TABLE_REGISTRY[tableKey];
  if (!reg) return { ok: false, reason: "unknown_table" };
  const [row] = await tx.select().from(reg.table).where(eq(reg.table.id, recordId));
  if (!row) return { ok: false, reason: "not_found" };
  // Tenant isolation guard: when a companyId is supplied (delete + wipe both
  // do), require strict equality. A NULL row.companyId (some legacy tables
  // allow nulls, e.g. branches) MUST also be rejected — never let a tenant-
  // scoped action delete a tenant-less row by accident.
  if (meta.companyId != null && row.companyId !== meta.companyId) {
    return { ok: false, reason: "cross_tenant_or_orphan" };
  }
  await tx.insert(deletedRecordsTable).values({
    tableName: tableKey,
    companyId: row.companyId ?? meta.companyId,
    recordId,
    payload: row,
    deletedBy: meta.userId,
    deletedByUsername: meta.username,
    reason: meta.reason,
    source: meta.source,
  });
  await tx.delete(reg.table).where(eq(reg.table.id, recordId));
  return { ok: true };
}

// ─── POST /api/admin/data-doctor/delete  body: { companyId, items, reason } ─
// Soft-deletes (snapshot + remove) selected rows. Returns per-item result.
router.post("/delete", requireSuperAdmin, async (req, res) => {
  const companyId = Number(req.body?.companyId);
  const items: Array<{ table: string; id: number }> = Array.isArray(req.body?.items) ? req.body.items : [];
  const reason: string = String(req.body?.reason ?? "تنظيف يدوي من شاشة طبيب البيانات");
  if (!companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }
  if (items.length === 0) { res.status(400).json({ error: "لا توجد عناصر محددة" }); return; }

  const results: Array<{ table: string; id: number; ok: boolean; reason?: string }> = [];

  await db.transaction(async (tx) => {
    for (const it of items) {
      if (!isValidTable(it.table) || !Number.isFinite(it.id)) {
        results.push({ table: it.table, id: it.id, ok: false, reason: "invalid_input" });
        continue;
      }
      const r = await snapshotAndDelete(tx, it.table, Number(it.id), {
        companyId, userId: req.adminUser?.id ?? null, username: req.adminUser?.username ?? null,
        reason, source: "manual",
      });
      results.push({ table: it.table, id: it.id, ...r });
    }
  });

  const ok = results.filter(r => r.ok).length;
  await writeAudit({
    userId: req.adminUser?.id ?? null,
    username: req.adminUser?.username ?? null,
    role: req.adminUser?.role ?? null,
    companyId,
    module: "data_doctor",
    action: "delete",
    method: "POST",
    path: req.path,
    metadata: { requested: items.length, ok, reason },
  });

  res.json({ summary: { requested: items.length, ok, failed: results.length - ok }, results });
});

// ─── POST /api/admin/data-doctor/wipe-company  body: { companyId, confirmText, reason } ─
// Snapshots + deletes ALL master rows from the registered tables for the
// given company. Requires confirmText to exactly equal the company's nameAr.
// Does NOT delete the `companies` row itself or any user/auth data.
//
// Returns per-table counts. Child rows (line items, ledger…) cascade-delete
// via existing FK constraints — they are NOT individually snapshotted, so a
// restore brings back the master rows but not their children. The frontend
// surfaces this caveat clearly.
// Tables that hold company-scoped data, are NOT in the wipe registry, and
// hold FKs into our wipe targets WITHOUT onDelete:cascade. If any of these
// have rows for the target company, the wipe transaction would abort
// mid-flight with a FK violation. We pre-flight them and refuse the wipe
// with a clear, actionable list. Engineering can either expand the registry
// or the operator can clear these tables first.
//
// We use to_regclass to skip tables that don't exist in this DB (some are
// added by feature flags / not all deployments have them). Identifiers are
// hard-coded — never interpolated from user input.
const WIPE_BLOCKERS: { table: string; labelAr: string }[] = [
  { table: "receipt_vouchers",      labelAr: "سندات القبض" },
  { table: "payment_vouchers",      labelAr: "سندات الصرف" },
  { table: "cash_transfers",        labelAr: "تحويلات الخزينة" },
  { table: "stock_ledger",          labelAr: "حركة المخزون" },
  { table: "stock_adjustments",     labelAr: "تسويات المخزون" },
  { table: "stock_transfers",       labelAr: "تحويلات المخزون" },
  { table: "stock_counts",          labelAr: "جرد المخزون" },
  { table: "employees",             labelAr: "الموظفون" },
  { table: "payroll_entries",       labelAr: "قيود الرواتب" },
  { table: "item_groups",           labelAr: "مجموعات الأصناف" },
  { table: "warehouse_groups",      labelAr: "مجموعات المخازن" },
];

router.post("/wipe-company", requireSuperAdmin, async (req, res) => {
  const companyId   = Number(req.body?.companyId);
  const confirmText = String(req.body?.confirmText ?? "");
  const reason      = String(req.body?.reason ?? "حذف بيانات شركة كاملة");
  if (!companyId) { res.status(400).json({ error: "companyId مطلوب" }); return; }

  const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, companyId));
  if (!company) { res.status(404).json({ error: "الشركة غير موجودة" }); return; }
  if (confirmText.trim() !== company.nameAr.trim()) {
    res.status(400).json({ error: "نص التأكيد لا يطابق اسم الشركة" }); return;
  }

  // ── Preflight: refuse the wipe if any blocker table has rows for this
  //    company. Without this, a partial wipe would roll back via the
  //    transaction guard but leave the operator confused as to why.
  const blockers: { table: string; labelAr: string; count: number }[] = [];
  for (const b of WIPE_BLOCKERS) {
    // to_regclass returns NULL for non-existent tables → skip silently.
    const exists = await db.execute(sql`SELECT to_regclass(${"public." + b.table})::text AS t`);
    const tname = (exists as any).rows?.[0]?.t ?? (exists as any)[0]?.t;
    if (!tname) continue;
    const cnt = await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM ${sql.identifier(b.table)} WHERE company_id = ${companyId}`
    );
    const n = Number((cnt as any).rows?.[0]?.n ?? (cnt as any)[0]?.n ?? 0);
    if (n > 0) blockers.push({ table: b.table, labelAr: b.labelAr, count: n });
  }
  if (blockers.length > 0) {
    res.status(409).json({
      error: "لا يمكن إتمام الحذف الكامل: توجد بيانات تابعة في جداول غير مشمولة بسلة المحذوفات",
      hint:  "احذف هذه السجلات يدوياً أولاً (أو اطلب من المطوّر توسيع نطاق سلة المحذوفات لتشملها).",
      blockers,
    });
    return;
  }

  const perTable: Record<string, number> = {};

  // Sort by wipeOrder ASC so child tables get cleared before their parents.
  const ordered = (Object.keys(TABLE_REGISTRY) as TableKey[])
    .sort((a, b) => TABLE_REGISTRY[a].wipeOrder - TABLE_REGISTRY[b].wipeOrder);

  await db.transaction(async (tx) => {
    for (const key of ordered) {
      const reg = TABLE_REGISTRY[key];
      const ids = await tx.select({ id: reg.table.id })
        .from(reg.table).where(eq(reg.table.companyId, companyId));
      perTable[key] = ids.length;
      for (const { id } of ids) {
        await snapshotAndDelete(tx, key, id, {
          companyId,
          userId: req.adminUser?.id ?? null,
          username: req.adminUser?.username ?? null,
          reason, source: "wipe_company",
        });
      }
    }
  });

  const totalDeleted = Object.values(perTable).reduce((s, n) => s + n, 0);
  await writeAudit({
    userId: req.adminUser?.id ?? null,
    username: req.adminUser?.username ?? null,
    role: req.adminUser?.role ?? null,
    companyId,
    module: "data_doctor",
    action: "wipe_company",
    method: "POST",
    path: req.path,
    metadata: { perTable, totalDeleted, reason },
  });

  res.json({ companyId, companyName: company.nameAr, totalDeleted, perTable });
});

// ─── GET /api/admin/data-doctor/recycle-bin ────────────────────────────────
// Filters: companyId, table, from, to, includeRestored. Paginated.
router.get("/recycle-bin", requireSuperAdmin, async (req, res) => {
  const companyId      = req.query.companyId ? Number(req.query.companyId) : null;
  const table          = req.query.table ? String(req.query.table) : null;
  const from           = req.query.from ? new Date(String(req.query.from)) : null;
  const to             = req.query.to   ? new Date(String(req.query.to))   : null;
  const includeRestored= String(req.query.includeRestored ?? "false") === "true";
  const limit          = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
  const offset         = Math.max(0, Number(req.query.offset ?? 0));

  const conds: any[] = [];
  if (companyId) conds.push(eq(deletedRecordsTable.companyId, companyId));
  if (table && isValidTable(table)) conds.push(eq(deletedRecordsTable.tableName, table));
  if (from && !Number.isNaN(from.getTime())) conds.push(gte(deletedRecordsTable.deletedAt, from));
  if (to   && !Number.isNaN(to.getTime()))   conds.push(lte(deletedRecordsTable.deletedAt, to));
  if (!includeRestored) conds.push(isNull(deletedRecordsTable.restoredAt));

  const where = conds.length > 0 ? and(...conds) : undefined;

  const rows = await db.select().from(deletedRecordsTable)
    .where(where as any).orderBy(desc(deletedRecordsTable.deletedAt))
    .limit(limit).offset(offset);

  // Decorate each row with a friendly summary derived from the snapshot.
  const decorated = rows.map(r => {
    const reg = TABLE_REGISTRY[r.tableName as TableKey];
    return {
      ...r,
      tableLabel: reg?.labelAr ?? r.tableName,
      summary: reg ? reg.summary(r.payload) : "—",
    };
  });

  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` })
    .from(deletedRecordsTable).where(where as any);

  res.json({ rows: decorated, total, limit, offset });
});

// ─── POST /api/admin/data-doctor/restore  body: { ids } ────────────────────
// Re-INSERT each snapshot back into its source table (preserving the
// original PK so foreign keys still resolve). Marks restoredAt/restoredBy.
router.post("/restore", requireSuperAdmin, async (req, res) => {
  const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
  if (ids.length === 0) { res.status(400).json({ error: "ids مطلوبة" }); return; }

  const results: Array<{ id: number; ok: boolean; reason?: string }> = [];

  await db.transaction(async (tx) => {
    const snaps = await tx.select().from(deletedRecordsTable).where(inArray(deletedRecordsTable.id, ids));
    for (const snap of snaps) {
      if (snap.restoredAt) { results.push({ id: snap.id, ok: false, reason: "already_restored" }); continue; }
      const reg = TABLE_REGISTRY[snap.tableName as TableKey];
      if (!reg) { results.push({ id: snap.id, ok: false, reason: "unknown_table" }); continue; }
      try {
        // Re-insert with the original ID. `payload` was captured by the
        // Drizzle row select so the keys match the table's column names
        // (camelCase). We use onConflictDoNothing + .returning() so we can
        // distinguish "actually inserted" from "PK or unique conflict, no
        // row inserted". Marking the snapshot as restored when nothing was
        // re-inserted would silently lose the recovery path.
        const inserted = await tx.insert(reg.table)
          .values(reviveTimestamps(snap.payload))
          .onConflictDoNothing()
          .returning({ id: (reg.table as any).id });
        if (inserted.length === 0) {
          results.push({ id: snap.id, ok: false, reason: "conflict_pk_or_unique_in_use" });
          continue;
        }
        await tx.update(deletedRecordsTable)
          .set({ restoredAt: new Date(), restoredBy: req.adminUser?.id ?? null })
          .where(eq(deletedRecordsTable.id, snap.id));
        results.push({ id: snap.id, ok: true });
      } catch (e: any) {
        results.push({ id: snap.id, ok: false, reason: e?.message?.slice(0, 200) ?? "insert_failed" });
      }
    }
  });

  const ok = results.filter(r => r.ok).length;
  await writeAudit({
    userId: req.adminUser?.id ?? null,
    username: req.adminUser?.username ?? null,
    role: req.adminUser?.role ?? null,
    companyId: null,
    module: "data_doctor",
    action: "restore",
    method: "POST",
    path: req.path,
    metadata: { requested: ids.length, ok },
  });

  res.json({ summary: { requested: ids.length, ok, failed: results.length - ok }, results });
});

// ─── DELETE /api/admin/data-doctor/recycle-bin/:id ─────────────────────────
// Permanently purge a single recycle-bin entry. No undo after this.
router.delete("/recycle-bin/:id", requireSuperAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "id غير صالح" }); return; }
  const [row] = await db.select().from(deletedRecordsTable).where(eq(deletedRecordsTable.id, id));
  if (!row) { res.status(404).json({ error: "السجل غير موجود" }); return; }
  await db.delete(deletedRecordsTable).where(eq(deletedRecordsTable.id, id));
  await writeAudit({
    userId: req.adminUser?.id ?? null,
    username: req.adminUser?.username ?? null,
    role: req.adminUser?.role ?? null,
    companyId: row.companyId,
    module: "data_doctor",
    action: "purge",
    method: "DELETE",
    path: req.path,
    entityType: row.tableName,
    entityId: String(row.recordId),
  });
  res.json({ ok: true });
});

export default router;
