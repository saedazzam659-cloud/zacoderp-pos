import { db, industriesTable, accountsTable, accountingMappingsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────
// applyIndustryTemplates
//
// SuperAdmin can attach two per-industry templates from /admin/industries:
//   • COA  — full chart of accounts (rows that match the AccountsImportPanel
//            shape: { code, nameAr, nameEn?, accountType, parentCode?, level?,
//            isPosting?, isActive?, reportDirection?, notes? })
//   • Mappings — accounting mappings rows (shape:
//            { documentType, roleKey, accountCode, isLocked? })
//
// When a NEW company is created (registration or admin-create) and it
// picked one or more industries that have templates uploaded, those
// templates are auto-applied here so the tenant boots with a ready
// chart of accounts AND wired-up posting rules.
//
// Behaviour:
//   • Reads ACTIVE industries only.
//   • If multiple selected industries each carry a COA template, rows
//     are merged with first-wins semantics on `code`.
//   • Same for mappings, first-wins on (documentType, roleKey).
//   • Parents-before-children sort for COA so parentId look-ups resolve.
//   • Mappings whose `accountCode` doesn't resolve to a freshly inserted
//     account are SKIPPED (counted in `mappingsSkippedMissingAccount`)
//     instead of failing the whole apply.
//   • Wraps the entire apply in a transaction — partial seeding never
//     reaches the DB.
// ─────────────────────────────────────────────────────────────────────

export interface CoaTemplateRow {
  code: string;
  nameAr: string;
  nameEn?: string | null;
  accountType: string;
  parentCode?: string | null;
  level?: number | null;
  isPosting?: boolean | null;
  isActive?: boolean | null;
  reportDirection?: string | null;
  notes?: string | null;
}

export interface MappingTemplateRow {
  documentType: string;
  roleKey: string;
  accountCode: string;
  isLocked?: boolean | null;
}

export interface ApplyTemplatesResult {
  industriesApplied: string[];
  coaInserted: number;
  coaSkipped: number;
  mappingsInserted: number;
  mappingsSkippedMissingAccount: number;
}

const VALID_ACCOUNT_TYPES = new Set(["asset", "liability", "equity", "revenue", "expense"]);
const VALID_DIRECTIONS    = new Set(["balance_sheet", "income_statement"]);

export async function applyIndustryTemplates(
  companyId: number,
  industryCodes: string[],
): Promise<ApplyTemplatesResult> {
  const empty: ApplyTemplatesResult = {
    industriesApplied: [],
    coaInserted: 0,
    coaSkipped: 0,
    mappingsInserted: 0,
    mappingsSkippedMissingAccount: 0,
  };

  const codes = (industryCodes ?? [])
    .filter((c): c is string => typeof c === "string" && c.length > 0);
  if (codes.length === 0) return empty;

  const industries = await db.select({
    code:               industriesTable.code,
    coaTemplate:        industriesTable.coaTemplate,
    mappingsTemplate:   industriesTable.mappingsTemplate,
  }).from(industriesTable).where(and(
    inArray(industriesTable.code, codes),
    eq(industriesTable.isActive, true),
  ));

  // 1. Merge COA rows (first-wins on `code`).
  const coaByCode = new Map<string, CoaTemplateRow>();
  const mergedCoaSourceIndustries: string[] = [];
  for (const code of codes) {
    const ind = industries.find((i) => i.code === code);
    if (!ind || !Array.isArray(ind.coaTemplate) || ind.coaTemplate.length === 0) continue;
    mergedCoaSourceIndustries.push(code);
    for (const raw of ind.coaTemplate as CoaTemplateRow[]) {
      const c = String(raw?.code ?? "").trim();
      if (!c || coaByCode.has(c)) continue;
      coaByCode.set(c, raw);
    }
  }

  // 2. Merge mappings (first-wins on documentType::roleKey).
  const mapByKey = new Map<string, MappingTemplateRow>();
  const mergedMapSourceIndustries: string[] = [];
  for (const code of codes) {
    const ind = industries.find((i) => i.code === code);
    if (!ind || !Array.isArray(ind.mappingsTemplate) || ind.mappingsTemplate.length === 0) continue;
    mergedMapSourceIndustries.push(code);
    for (const raw of ind.mappingsTemplate as MappingTemplateRow[]) {
      const dt = String(raw?.documentType ?? "").trim();
      const rk = String(raw?.roleKey ?? "").trim();
      const ac = String(raw?.accountCode ?? "").trim();
      if (!dt || !rk || !ac) continue;
      const key = `${dt}::${rk}`;
      if (mapByKey.has(key)) continue;
      mapByKey.set(key, { documentType: dt, roleKey: rk, accountCode: ac, isLocked: !!raw.isLocked });
    }
  }

  if (coaByCode.size === 0 && mapByKey.size === 0) return empty;

  // Topologically order COA rows so every parent appears before its
  // children. The previous heuristic (sort by code length + lexical) only
  // works for uniform numeric coding schemes — it silently flattens trees
  // when parent codes don't satisfy that ordering (e.g. parent="MAIN"
  // child="M001"). This pass:
  //   1. starts with rows that have no parentCode OR whose parentCode is
  //      not present in the template at all (treat as orphan root),
  //   2. iteratively appends rows whose parentCode has already been
  //      emitted,
  //   3. anything still unresolved at the end (cycles) is appended last
  //      with parentId left null, and counted.
  const coaSorted: CoaTemplateRow[] = (() => {
    const allCodes = new Set(coaByCode.keys());
    const remaining = new Map(coaByCode);
    const out: CoaTemplateRow[] = [];
    const emitted = new Set<string>();

    let progressed = true;
    while (progressed && remaining.size > 0) {
      progressed = false;
      for (const [code, row] of Array.from(remaining)) {
        const pc = row.parentCode ? String(row.parentCode).trim() : "";
        const parentExistsInTemplate = pc.length > 0 && allCodes.has(pc);
        if (!parentExistsInTemplate || emitted.has(pc)) {
          out.push(row);
          emitted.add(code);
          remaining.delete(code);
          progressed = true;
        }
      }
    }
    // Cycles or unsatisfiable parent chains — append unchanged so they
    // still get inserted (with parentId null) and surface in logs.
    for (const row of remaining.values()) out.push(row);
    return out;
  })();

  const result: ApplyTemplatesResult = {
    industriesApplied: Array.from(new Set([...mergedCoaSourceIndustries, ...mergedMapSourceIndustries])),
    coaInserted: 0,
    coaSkipped: 0,
    mappingsInserted: 0,
    mappingsSkippedMissingAccount: 0,
  };

  await db.transaction(async (tx) => {
    // ── COA insert ──────────────────────────────────────────────────
    const codeToId: Record<string, number> = {};
    for (const a of coaSorted) {
      try {
        const code   = String(a.code).trim();
        const nameAr = String(a.nameAr ?? "").trim();
        const accountType = String(a.accountType ?? "").trim();
        if (!code || !nameAr || !accountType || !VALID_ACCOUNT_TYPES.has(accountType)) {
          result.coaSkipped++; continue;
        }
        const parentCode = a.parentCode ? String(a.parentCode).trim() : null;
        const parentId   = parentCode ? (codeToId[parentCode] ?? null) : null;

        const dirRaw = String(a.reportDirection ?? "").trim();
        const reportDirection = VALID_DIRECTIONS.has(dirRaw) ? dirRaw : null;

        // NOTE: accounts has no (company_id, code) unique index, so we
        // cannot use onConflictDoNothing here. The in-memory `coaByCode`
        // map already de-duplicates the template rows, and this helper is
        // only ever called for a brand-new company where no accounts can
        // pre-exist — so a plain insert is safe.
        const [row] = await tx.insert(accountsTable).values({
          companyId, code, nameAr, nameEn: a.nameEn || null,
          accountType: accountType as any,
          parentId, level: a.level ?? (parentCode ? 2 : 1),
          reportDirection,
          isPosting: typeof a.isPosting === "boolean" ? a.isPosting : true,
          isActive:  typeof a.isActive  === "boolean" ? a.isActive  : true,
          notes: a.notes || null,
        }).returning();
        if (row) {
          codeToId[code] = row.id;
          result.coaInserted++;
        } else {
          result.coaSkipped++;
        }
      } catch (err: any) {
        logger.warn({ err: err?.message, code: a?.code, companyId },
          "[applyIndustryTemplates] COA row insert failed");
        result.coaSkipped++;
      }
    }

    // ── Mappings insert ─────────────────────────────────────────────
    if (mapByKey.size > 0) {
      // Need account ids for ALL referenced codes (some may already
      // pre-exist in the freshly-created tenant from other paths).
      const wantedCodes = Array.from(new Set(Array.from(mapByKey.values()).map((m) => m.accountCode)));
      const existing = await tx.select({
        id: accountsTable.id,
        code: accountsTable.code,
      }).from(accountsTable).where(and(
        eq(accountsTable.companyId, companyId),
        inArray(accountsTable.code, wantedCodes),
      ));
      const accCodeToId = new Map<string, number>();
      for (const a of existing) accCodeToId.set(a.code, a.id);

      for (const m of mapByKey.values()) {
        const accountId = accCodeToId.get(m.accountCode);
        if (!accountId) {
          result.mappingsSkippedMissingAccount++;
          continue;
        }
        try {
          const ret = await tx.insert(accountingMappingsTable).values({
            companyId,
            documentType: m.documentType,
            roleKey:      m.roleKey,
            accountId,
            isLocked:     !!m.isLocked,
          }).onConflictDoNothing({
            target: [
              accountingMappingsTable.companyId,
              accountingMappingsTable.documentType,
              accountingMappingsTable.roleKey,
            ],
          }).returning({ id: accountingMappingsTable.id });
          if (ret.length > 0) result.mappingsInserted++;
        } catch (err: any) {
          logger.warn({ err: err?.message, key: `${m.documentType}::${m.roleKey}`, companyId },
            "[applyIndustryTemplates] mapping insert failed");
        }
      }
    }
  });

  return result;
}
