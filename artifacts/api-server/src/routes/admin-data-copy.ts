import { Router, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import {
  usersTable, companiesTable, accountsTable, branchesTable,
  fiscalPeriodsTable, journalEntriesTable, journalEntryLinesTable,
} from "@workspace/db";
import { and, asc, eq, gte, inArray, lte, isNull } from "drizzle-orm";
import { resolveBearerToken } from "../middleware/auth.js";
import { writeAudit } from "../middleware/permissions.js";

const router = Router();

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
    res.status(403).json({ error: "هذه الصفحة للمشرف العام فقط" }); return;
  }
  (req as any).authUser = user;
  next();
}

function loginIp(req: Request): string | null {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length) return xf.split(",")[0].trim().slice(0, 64);
  if (Array.isArray(xf) && xf.length) return String(xf[0]).slice(0, 64);
  return ((req.socket as any)?.remoteAddress ?? null)?.slice(0, 64) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/data-copy/companies
// Lightweight company picker list (superadmin-scoped, excludes deleted).
// ─────────────────────────────────────────────────────────────────────────────
router.get("/companies", requireSuperAdmin, async (_req, res) => {
  const rows = await db
    .select({
      id: companiesTable.id,
      code: companiesTable.code,
      nameAr: companiesTable.nameAr,
      nameEn: companiesTable.nameEn,
      vatNumber: companiesTable.vatNumber,
      status: companiesTable.status,
    })
    .from(companiesTable)
    .where(isNull(companiesTable.deletedAt))
    .orderBy(asc(companiesTable.nameAr));
  res.json({ companies: rows });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/data-copy/journal-entries
// ─────────────────────────────────────────────────────────────────────────────
//
// Copies journal entries (header + lines) from a source company to a target
// company with strict integrity guards.
//
// FK remapping strategy:
//   • accountId  → matched by accounts.code (per-company unique semantically)
//   • branchId   → matched by branches.code (case-insensitive)
//   • periodId   → resolved by entryDate against target company's fiscal_periods
//   • costCenter → free text, copied as-is (warning surfaced if no matching row)
//
// Body shape:
//   {
//     sourceCompanyId, targetCompanyId,
//     fromDate?, toDate?,                     // YYYY-MM-DD inclusive
//     statusFilter?: ("draft"|"posted")[],    // default ["draft","posted"]
//     entryIds?: number[] | null,             // optional explicit list
//     docNumberOnConflict: "skip"|"rename"|"keep",
//     onMissingAccount:    "skip_entry"|"abort",
//     onMissingBranch:     "null"|"skip_entry"|"abort",
//     onMissingPeriod:     "null"|"skip_entry"|"abort",
//     copyAsDraft: boolean,                   // force status='draft' on target
//     dryRun: boolean,
//   }
//
// Response (both modes):
//   {
//     dryRun, totalSource, copied, skipped, failed,
//     issues: [{ entryId, docNumber, kind, detail }],
//     mappingSummary: { accounts: {matched, unmatched}, branches: {...} },
//   }
router.post("/journal-entries", requireSuperAdmin, async (req, res) => {
  const user = (req as any).authUser;
  const ip = loginIp(req);
  const ua = req.headers["user-agent"]?.toString()?.slice(0, 500) ?? null;

  const b = req.body ?? {};
  const sourceCompanyId = Number(b.sourceCompanyId);
  const targetCompanyId = Number(b.targetCompanyId);

  if (!sourceCompanyId || !targetCompanyId || sourceCompanyId === targetCompanyId) {
    res.status(400).json({ error: "اختر شركة مصدر وشركة هدف مختلفتين" });
    return;
  }

  const fromDate: string | null = typeof b.fromDate === "string" && b.fromDate ? b.fromDate : null;
  const toDate:   string | null = typeof b.toDate   === "string" && b.toDate   ? b.toDate   : null;
  const statusFilter: ("draft" | "posted")[] =
    Array.isArray(b.statusFilter) && b.statusFilter.length
      ? b.statusFilter.filter((s: any) => s === "draft" || s === "posted")
      : ["draft", "posted"];
  const entryIds: number[] | null = Array.isArray(b.entryIds) && b.entryIds.length
    ? b.entryIds.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n))
    : null;

  const docNumberOnConflict = (["skip", "rename", "keep"].includes(b.docNumberOnConflict) ? b.docNumberOnConflict : "rename") as "skip" | "rename" | "keep";
  const onMissingAccount    = (["skip_entry", "abort"].includes(b.onMissingAccount)   ? b.onMissingAccount   : "skip_entry") as "skip_entry" | "abort";
  const onMissingBranch     = (["null", "skip_entry", "abort"].includes(b.onMissingBranch) ? b.onMissingBranch : "null") as "null" | "skip_entry" | "abort";
  const onMissingPeriod     = (["null", "skip_entry", "abort"].includes(b.onMissingPeriod) ? b.onMissingPeriod : "null") as "null" | "skip_entry" | "abort";
  const copyAsDraft = b.copyAsDraft !== false; // default true
  const dryRun = !!b.dryRun;

  // Validate companies exist.
  const cos = await db.select({
    id: companiesTable.id, nameAr: companiesTable.nameAr, deletedAt: companiesTable.deletedAt,
  }).from(companiesTable).where(inArray(companiesTable.id, [sourceCompanyId, targetCompanyId]));
  const src = cos.find(c => c.id === sourceCompanyId);
  const tgt = cos.find(c => c.id === targetCompanyId);
  if (!src || src.deletedAt) { res.status(404).json({ error: "الشركة المصدر غير موجودة" }); return; }
  if (!tgt || tgt.deletedAt) { res.status(404).json({ error: "الشركة الهدف غير موجودة" }); return; }

  // Build account & branch maps.
  const [srcAccounts, tgtAccounts, srcBranches, tgtBranches, tgtPeriods, tgtEntriesAll] = await Promise.all([
    db.select({ id: accountsTable.id, code: accountsTable.code, isPosting: accountsTable.isPosting, isActive: accountsTable.isActive })
      .from(accountsTable).where(eq(accountsTable.companyId, sourceCompanyId)),
    db.select({ id: accountsTable.id, code: accountsTable.code, isPosting: accountsTable.isPosting, isActive: accountsTable.isActive })
      .from(accountsTable).where(eq(accountsTable.companyId, targetCompanyId)),
    db.select({ id: branchesTable.id, code: branchesTable.code })
      .from(branchesTable).where(eq(branchesTable.companyId, sourceCompanyId)),
    db.select({ id: branchesTable.id, code: branchesTable.code })
      .from(branchesTable).where(eq(branchesTable.companyId, targetCompanyId)),
    db.select({
      id: fiscalPeriodsTable.id, startDate: fiscalPeriodsTable.startDate,
      endDate: fiscalPeriodsTable.endDate, status: fiscalPeriodsTable.status,
    }).from(fiscalPeriodsTable).where(eq(fiscalPeriodsTable.companyId, targetCompanyId)),
    db.select({ docNumber: journalEntriesTable.docNumber })
      .from(journalEntriesTable).where(eq(journalEntriesTable.companyId, targetCompanyId)),
  ]);

  const tgtAcctByCode = new Map<string, { id: number; isPosting: boolean; isActive: boolean }>();
  for (const a of tgtAccounts) tgtAcctByCode.set(a.code.trim(), { id: a.id, isPosting: a.isPosting, isActive: a.isActive });
  const srcAcctById = new Map<number, { code: string }>();
  for (const a of srcAccounts) srcAcctById.set(a.id, { code: a.code });

  const tgtBrByCode = new Map<string, number>();
  for (const br of tgtBranches) tgtBrByCode.set(br.code.trim().toLowerCase(), br.id);
  const srcBrById = new Map<number, { code: string }>();
  for (const br of srcBranches) srcBrById.set(br.id, { code: br.code });

  const tgtDocNumbers = new Set<string>();
  for (const e of tgtEntriesAll) if (e.docNumber) tgtDocNumbers.add(e.docNumber);

  // Fetch source entries (filtered).
  const filters = [eq(journalEntriesTable.companyId, sourceCompanyId)];
  if (fromDate) filters.push(gte(journalEntriesTable.entryDate, fromDate));
  if (toDate)   filters.push(lte(journalEntriesTable.entryDate, toDate));
  if (statusFilter.length) filters.push(inArray(journalEntriesTable.status, statusFilter));
  if (entryIds)  filters.push(inArray(journalEntriesTable.id, entryIds));
  const srcEntries = await db.select().from(journalEntriesTable)
    .where(and(...filters))
    .orderBy(asc(journalEntriesTable.entryDate), asc(journalEntriesTable.id));

  const totalSource = srcEntries.length;
  const issues: Array<{ entryId: number; docNumber: string | null; kind: string; detail: string }> = [];
  let copied = 0, skipped = 0, failed = 0;

  // Resolve target fiscal period for a date.
  function resolvePeriodFor(dateStr: string): number | null {
    for (const p of tgtPeriods) {
      if (dateStr >= p.startDate && dateStr <= p.endDate) return p.id;
    }
    return null;
  }
  // Generate a non-colliding docNumber when policy = rename.
  function renameDoc(orig: string | null): string {
    const base = (orig ?? "JE") + "-CP";
    let candidate = base;
    let i = 1;
    while (tgtDocNumbers.has(candidate)) {
      i += 1;
      candidate = `${base}-${i}`;
    }
    tgtDocNumbers.add(candidate);
    return candidate;
  }

  // Track unmatched accounts/branches across the whole batch for summary.
  const unmatchedAccountCodes = new Set<string>();
  const unmatchedBranchCodes  = new Set<string>();

  // Aborts short-circuit further processing entirely.
  let aborted: { reason: string } | null = null;

  // Pre-load source lines for all entries in one round-trip.
  const srcEntryIds = srcEntries.map(e => e.id);
  const allLines = srcEntryIds.length
    ? await db.select().from(journalEntryLinesTable)
        .where(inArray(journalEntryLinesTable.entryId, srcEntryIds))
        .orderBy(asc(journalEntryLinesTable.entryId), asc(journalEntryLinesTable.sortOrder))
    : [];
  const linesByEntry = new Map<number, typeof allLines>();
  for (const ln of allLines) {
    const arr = linesByEntry.get(ln.entryId) ?? [];
    arr.push(ln);
    linesByEntry.set(ln.entryId, arr);
  }

  // Plan each entry: determine if it would be copied / skipped / failed.
  type Plan = {
    entry: typeof srcEntries[number];
    lines: typeof allLines;
    targetDoc: string | null;
    targetBranchId: number | null;
    targetPeriodId: number | null;
    mappedLines: Array<{ accountId: number | null; costCenter: string | null; debit: string; credit: string; description: string | null; sortOrder: number }>;
    action: "copy" | "skip" | "fail";
    reason?: string;
  };
  const plans: Plan[] = [];

  for (const e of srcEntries) {
    if (aborted) break;
    const lines = linesByEntry.get(e.id) ?? [];

    // Branch mapping.
    let targetBranchId: number | null = null;
    if (e.branchId != null) {
      const srcBr = srcBrById.get(e.branchId);
      const code = srcBr?.code?.trim().toLowerCase();
      const matched = code ? tgtBrByCode.get(code) ?? null : null;
      if (matched != null) {
        targetBranchId = matched;
      } else {
        if (srcBr?.code) unmatchedBranchCodes.add(srcBr.code);
        if (onMissingBranch === "abort") { aborted = { reason: `الفرع برمز "${srcBr?.code ?? "?"}" غير موجود في الشركة الهدف` }; break; }
        if (onMissingBranch === "skip_entry") {
          issues.push({ entryId: e.id, docNumber: e.docNumber, kind: "missing_branch", detail: `الفرع "${srcBr?.code ?? "?"}" غير موجود → تخطي القيد` });
          plans.push({ entry: e, lines, targetDoc: null, targetBranchId: null, targetPeriodId: null, mappedLines: [], action: "skip", reason: "missing_branch" });
          continue;
        }
        // policy "null"
        targetBranchId = null;
        issues.push({ entryId: e.id, docNumber: e.docNumber, kind: "missing_branch", detail: `الفرع "${srcBr?.code ?? "?"}" غير موجود → تم ضبطه على null` });
      }
    }

    // Period resolution.
    const matchedPeriod = resolvePeriodFor(e.entryDate);
    let targetPeriodId: number | null = null;
    if (matchedPeriod != null) {
      targetPeriodId = matchedPeriod;
    } else {
      if (onMissingPeriod === "abort") { aborted = { reason: `لا توجد فترة مالية في الشركة الهدف تغطي ${e.entryDate}` }; break; }
      if (onMissingPeriod === "skip_entry") {
        issues.push({ entryId: e.id, docNumber: e.docNumber, kind: "missing_period", detail: `لا توجد فترة مالية تغطي ${e.entryDate} → تخطي القيد` });
        plans.push({ entry: e, lines, targetDoc: null, targetBranchId, targetPeriodId: null, mappedLines: [], action: "skip", reason: "missing_period" });
        continue;
      }
      // policy "null"
      issues.push({ entryId: e.id, docNumber: e.docNumber, kind: "missing_period", detail: `لا توجد فترة مالية تغطي ${e.entryDate} → تم ضبطها على null` });
    }

    // Account remapping for lines.
    const mappedLines: Plan["mappedLines"] = [];
    let entryAccountFailed = false;
    for (const ln of lines) {
      let mappedAcctId: number | null = null;
      if (ln.accountId != null) {
        const srcAcc = srcAcctById.get(ln.accountId);
        const code = srcAcc?.code?.trim();
        const tgt = code ? tgtAcctByCode.get(code) : null;
        if (tgt) {
          mappedAcctId = tgt.id;
          if (!tgt.isPosting || !tgt.isActive) {
            issues.push({ entryId: e.id, docNumber: e.docNumber, kind: "account_inactive", detail: `الحساب "${code}" غير نشط أو غير قابل للترحيل في الهدف` });
          }
        } else {
          if (code) unmatchedAccountCodes.add(code);
          if (onMissingAccount === "abort") { aborted = { reason: `الحساب برمز "${code ?? "?"}" غير موجود في الشركة الهدف` }; break; }
          // skip_entry policy
          entryAccountFailed = true;
          issues.push({ entryId: e.id, docNumber: e.docNumber, kind: "missing_account", detail: `الحساب "${code ?? "?"}" غير موجود في الهدف → تخطي القيد` });
          break;
        }
      }
      mappedLines.push({
        accountId: mappedAcctId,
        costCenter: ln.costCenter,
        debit: String(ln.debit),
        credit: String(ln.credit),
        description: ln.description,
        sortOrder: ln.sortOrder,
      });
    }
    if (aborted) break;
    if (entryAccountFailed) {
      plans.push({ entry: e, lines, targetDoc: null, targetBranchId, targetPeriodId, mappedLines: [], action: "skip", reason: "missing_account" });
      continue;
    }

    // Validate balance (debit==credit). Should already be true at source but double-check.
    let totDebit = 0, totCredit = 0;
    for (const ml of mappedLines) { totDebit += Number(ml.debit) || 0; totCredit += Number(ml.credit) || 0; }
    if (Math.abs(totDebit - totCredit) > 0.005) {
      issues.push({ entryId: e.id, docNumber: e.docNumber, kind: "unbalanced", detail: `القيد غير متوازن (${totDebit.toFixed(2)} ≠ ${totCredit.toFixed(2)}) → تخطي` });
      plans.push({ entry: e, lines, targetDoc: null, targetBranchId, targetPeriodId, mappedLines: [], action: "skip", reason: "unbalanced" });
      continue;
    }

    // docNumber collision policy.
    let targetDoc = e.docNumber;
    if (e.docNumber && tgtDocNumbers.has(e.docNumber)) {
      if (docNumberOnConflict === "skip") {
        issues.push({ entryId: e.id, docNumber: e.docNumber, kind: "doc_conflict", detail: `رقم المستند "${e.docNumber}" موجود في الهدف → تخطي` });
        plans.push({ entry: e, lines, targetDoc: null, targetBranchId, targetPeriodId, mappedLines: [], action: "skip", reason: "doc_conflict" });
        continue;
      }
      if (docNumberOnConflict === "rename") {
        targetDoc = renameDoc(e.docNumber);
        issues.push({ entryId: e.id, docNumber: e.docNumber, kind: "doc_renamed", detail: `أُعيدت تسمية "${e.docNumber}" إلى "${targetDoc}"` });
      }
      // "keep" → leave as-is (will create duplicate; allowed because docNumber has no UNIQUE constraint).
    } else if (targetDoc) {
      tgtDocNumbers.add(targetDoc);
    }

    plans.push({ entry: e, lines, targetDoc, targetBranchId, targetPeriodId, mappedLines, action: "copy" });
  }

  if (aborted) {
    res.status(400).json({
      error: aborted.reason,
      aborted: true,
      totalSource, copied: 0, skipped: 0, failed: 0,
      issues,
      mappingSummary: {
        accounts: { unmatched: Array.from(unmatchedAccountCodes) },
        branches: { unmatched: Array.from(unmatchedBranchCodes) },
      },
    });
    return;
  }

  // Tally counts from plans.
  for (const p of plans) {
    if (p.action === "copy") copied += 1;
    else if (p.action === "skip") skipped += 1;
    else failed += 1;
  }

  if (dryRun) {
    res.json({
      dryRun: true, totalSource, copied, skipped, failed, issues,
      mappingSummary: {
        accounts: { unmatched: Array.from(unmatchedAccountCodes) },
        branches: { unmatched: Array.from(unmatchedBranchCodes) },
      },
    });
    return;
  }

  // ── Execute inside a single transaction so a failure rolls everything back.
  let actuallyCopied = 0;
  try {
    await db.transaction(async (tx) => {
      for (const p of plans) {
        if (p.action !== "copy") continue;
        const e = p.entry;
        const [inserted] = await tx.insert(journalEntriesTable).values({
          companyId: targetCompanyId,
          docNumber: p.targetDoc,
          entryDate: e.entryDate,
          currency: e.currency,
          exchangeRate: e.exchangeRate,
          description: e.description,
          entryType: e.entryType,
          branchId: p.targetBranchId,
          periodId: p.targetPeriodId,
          status: copyAsDraft ? "draft" : e.status,
        }).returning({ id: journalEntriesTable.id });
        if (!inserted) throw new Error("insert returned nothing");

        if (p.mappedLines.length) {
          await tx.insert(journalEntryLinesTable).values(
            p.mappedLines.map(ml => ({
              entryId: inserted.id,
              accountId: ml.accountId,
              costCenter: ml.costCenter,
              debit: ml.debit,
              credit: ml.credit,
              description: ml.description,
              sortOrder: ml.sortOrder,
            })),
          );
        }
        actuallyCopied += 1;
      }
    });
  } catch (err: any) {
    res.status(500).json({
      error: "فشل تنفيذ النسخ — تم التراجع عن جميع التغييرات",
      detail: String(err?.message ?? err).slice(0, 300),
      totalSource, copied: 0, skipped, failed: copied, issues,
    });
    return;
  }

  await writeAudit({
    userId: user.id, username: user.username, role: user.role, companyId: null,
    module: "data-copy", action: "execute",
    method: "POST", path: "/api/admin/data-copy/journal-entries",
    statusCode: 200, ip, userAgent: ua,
    metadata: {
      sourceCompanyId, targetCompanyId,
      filters: { fromDate, toDate, statusFilter, entryIds },
      policies: { docNumberOnConflict, onMissingAccount, onMissingBranch, onMissingPeriod, copyAsDraft },
      result: { totalSource, copied: actuallyCopied, skipped, failed, issuesCount: issues.length },
    },
  });

  res.json({
    dryRun: false,
    totalSource,
    copied: actuallyCopied,
    skipped,
    failed,
    issues,
    mappingSummary: {
      accounts: { unmatched: Array.from(unmatchedAccountCodes) },
      branches: { unmatched: Array.from(unmatchedBranchCodes) },
    },
  });
});

export default router;
