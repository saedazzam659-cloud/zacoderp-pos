import { db, contractingProjectsTable, getActiveExternalDb } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { contractingBranchAllowed } from "./contracting-security.js";
import { canAccessModule } from "../middleware/permissions.js";

/** Idempotent against both the central database and the active agent tenant DB. */
const readiness = new WeakMap<object, Promise<void>>();
let centralReadiness: Promise<void> | undefined;
export async function ensureProjectFinancialLinks(): Promise<void> {
  const active = getActiveExternalDb();
  const cached = active ? readiness.get(active) : centralReadiness;
  if (cached) return cached;
  const pending = (async () => {
    for (const table of ["purchase_invoices", "purchase_returns", "sales_invoices", "sales_returns", "payment_voucher_lines", "goods_receipts", "goods_deliveries", "journal_entry_lines"]) {
      await db.execute(sql.raw(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS project_id INTEGER`));
      await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS ${table}_project_link_idx ON ${table}(project_id) WHERE project_id IS NOT NULL`));
    }
  })();
  if (active) readiness.set(active, pending);
  else centralReadiness = pending;
  try { await pending; }
  catch (error) {
    if (active) readiness.delete(active);
    else centralReadiness = undefined;
    throw error;
  }
}

export async function resolveProjectLink(
  companyId: number,
  value: unknown,
  branchId: unknown,
  user: any,
): Promise<number | null> {
  if (value === null || value === undefined || value === "") return null;
  if (!canAccessModule(user, "contracting", "view"))
    throw Object.assign(new Error("لا تملك صلاحية الاطلاع على مشاريع المقاولات"), { status: 403 });
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error("معرّف المشروع غير صالح"), { status: 422 });
  const [project] = await db.select({ id: contractingProjectsTable.id, branchId: contractingProjectsTable.branchId })
    .from(contractingProjectsTable)
    .where(and(eq(contractingProjectsTable.id, id), eq(contractingProjectsTable.companyId, companyId)));
  if (!project) throw Object.assign(new Error("المشروع غير موجود في هذه الشركة"), { status: 422 });
  if (!contractingBranchAllowed(user, project.branchId) ||
    (branchId != null && project.branchId != null && Number(branchId) !== project.branchId)) {
    throw Object.assign(new Error("لا تملك صلاحية فرع المشروع أو أن فرع المستند لا يطابقه"), { status: 403 });
  }
  return project.id;
}