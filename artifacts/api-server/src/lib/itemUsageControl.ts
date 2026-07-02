import { db } from "@workspace/db";
import { itemUsageControlsTable } from "@workspace/db";
import { and, eq, inArray, ne } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────
// Item Usage Control — CENTRAL RESOLVER (Phase أ).
//
// This is the ONE place every screen will consult in Phase ب to decide how an
// item behaves on that screen. Keeping the logic here (not scattered across ~40
// screens) means a new screen is a one-line wiring and the 5-state semantics
// stay identical everywhere. The DEFAULT when no row exists is `allowed`.
// ─────────────────────────────────────────────────────────────────────────
export const USAGE_MODES = [
  "allowed",
  "hidden",
  "readonly",
  "requires_approval",
  "requires_permission",
] as const;
export type UsageMode = (typeof USAGE_MODES)[number];
export const DEFAULT_USAGE_MODE: UsageMode = "allowed";

export function isValidUsageMode(m: unknown): m is UsageMode {
  return typeof m === "string" && (USAGE_MODES as readonly string[]).includes(m);
}

export function normalizeUsageMode(m: unknown): UsageMode {
  return isValidUsageMode(m) ? m : DEFAULT_USAGE_MODE;
}

// A screen key is a lowercase slug (letters/digits/underscore/dot, ≤ 64 chars).
// Free-form so new screens need no code change, but bounded to prevent abuse.
export function isValidScreenKey(k: unknown): k is string {
  return typeof k === "string" && /^[a-z0-9_.]{1,64}$/.test(k);
}

export interface UsageControlEntry {
  screenKey: string;
  mode: UsageMode;
  reason: string | null;
}

// All non-default rules for a single item, keyed by screen. Absent screens are
// implicitly `allowed`. Used by the item form + the per-item resolver.
export async function getItemUsageControls(
  companyId: number,
  itemId: number,
): Promise<Record<string, UsageControlEntry>> {
  const rows = await db
    .select()
    .from(itemUsageControlsTable)
    .where(and(eq(itemUsageControlsTable.companyId, companyId), eq(itemUsageControlsTable.itemId, itemId)));
  const map: Record<string, UsageControlEntry> = {};
  for (const r of rows) {
    map[r.screenKey] = { screenKey: r.screenKey, mode: normalizeUsageMode(r.mode), reason: r.reason ?? null };
  }
  return map;
}

// The effective mode for (item, screen). `allowed` when no explicit rule.
export async function resolveUsageMode(
  companyId: number,
  itemId: number,
  screenKey: string,
): Promise<UsageMode> {
  const [row] = await db
    .select()
    .from(itemUsageControlsTable)
    .where(
      and(
        eq(itemUsageControlsTable.companyId, companyId),
        eq(itemUsageControlsTable.itemId, itemId),
        eq(itemUsageControlsTable.screenKey, screenKey),
      ),
    )
    .limit(1);
  return row ? normalizeUsageMode(row.mode) : DEFAULT_USAGE_MODE;
}

// For a given screen, return itemId→mode for the items that carry a NON-default
// rule (the rest are `allowed`). Phase ب screens use this to filter/annotate an
// item list in one batched query. Pass the candidate item ids to stay indexed.
export async function getScreenModesForItems(
  companyId: number,
  screenKey: string,
  itemIds: number[],
): Promise<Record<number, UsageMode>> {
  const map: Record<number, UsageMode> = {};
  if (itemIds.length === 0) return map;
  const rows = await db
    .select()
    .from(itemUsageControlsTable)
    .where(
      and(
        eq(itemUsageControlsTable.companyId, companyId),
        eq(itemUsageControlsTable.screenKey, screenKey),
        inArray(itemUsageControlsTable.itemId, itemIds),
        ne(itemUsageControlsTable.mode, DEFAULT_USAGE_MODE),
      ),
    );
  for (const r of rows) map[r.itemId] = normalizeUsageMode(r.mode);
  return map;
}

// ─────────────────────────────────────────────────────────────────────────
// Phase ب — ENFORCEMENT layer.
//
// A rule carries both the effective mode and the (optional) admin-authored
// reason so screens and guards can show a meaningful message. `allowed`
// screens are never materialised (absent = allowed).
// ─────────────────────────────────────────────────────────────────────────
export interface UsageRule {
  mode: UsageMode;
  reason: string | null;
}

// ALL non-default rules for a screen across the whole company catalogue,
// keyed by itemId. This powers the frontend batch endpoint so a form can
// annotate its item picker in ONE query (hidden = drop, readonly /
// requires_permission = disable, requires_approval = badge).
export async function getScreenRules(
  companyId: number,
  screenKey: string,
): Promise<Record<number, UsageRule>> {
  const rows = await db
    .select()
    .from(itemUsageControlsTable)
    .where(
      and(
        eq(itemUsageControlsTable.companyId, companyId),
        eq(itemUsageControlsTable.screenKey, screenKey),
        ne(itemUsageControlsTable.mode, DEFAULT_USAGE_MODE),
      ),
    );
  const map: Record<number, UsageRule> = {};
  for (const r of rows) map[r.itemId] = { mode: normalizeUsageMode(r.mode), reason: r.reason ?? null };
  return map;
}

// Same as getScreenRules but scoped to a candidate id list — used by the
// server-side save/post guard which only ever knows the doc's own lines.
export async function getScreenRulesForItems(
  companyId: number,
  screenKey: string,
  itemIds: number[],
): Promise<Record<number, UsageRule>> {
  const map: Record<number, UsageRule> = {};
  const ids = Array.from(new Set(itemIds.filter(n => Number.isInteger(n) && n > 0)));
  if (ids.length === 0) return map;
  const rows = await db
    .select()
    .from(itemUsageControlsTable)
    .where(
      and(
        eq(itemUsageControlsTable.companyId, companyId),
        eq(itemUsageControlsTable.screenKey, screenKey),
        inArray(itemUsageControlsTable.itemId, ids),
        ne(itemUsageControlsTable.mode, DEFAULT_USAGE_MODE),
      ),
    );
  for (const r of rows) map[r.itemId] = { mode: normalizeUsageMode(r.mode), reason: r.reason ?? null };
  return map;
}

// A user is "usage-privileged" (may bypass requires_permission at add-time and
// requires_approval at post-time) when they are the platform operator, the
// company admin, or hold the grantable `item_usage_override.post` permission.
// Kept dependency-free (no import of the permissions middleware) on purpose so
// the resolver stays a leaf module.
export function isUsagePrivileged(authUser: any): boolean {
  if (!authUser) return false;
  if (authUser.role === "superadmin" || authUser.role === "admin") return true;
  const p = (authUser.permissions ?? {}) as Record<string, any>;
  return p.item_usage_override?.post === true;
}

export interface UsageViolation {
  itemId: number;
  mode: UsageMode;
  reason: string | null;
}

// The ONE authoritative gate every document create/post route calls.
//   phase "save" → creating/finalising a document line set (blocks hidden,
//                  readonly, and requires_permission for unprivileged users).
//   phase "post" → the "save" set PLUS requires_approval for unprivileged
//                  users (approval == the existing draft→posted transition).
// Returns the offending lines (empty ⇒ allowed). Routes turn a non-empty
// result into a 403 with a human message. Idempotent + read-only.
export async function checkItemsUsable(
  companyId: number,
  screenKey: string,
  itemIds: number[],
  authUser: any,
  phase: "save" | "post",
): Promise<UsageViolation[]> {
  const rules = await getScreenRulesForItems(companyId, screenKey, itemIds);
  const ids = Object.keys(rules);
  if (ids.length === 0) return [];
  const privileged = isUsagePrivileged(authUser);
  const violations: UsageViolation[] = [];
  for (const idStr of ids) {
    const id = Number(idStr);
    const { mode, reason } = rules[id]!;
    let blocked = false;
    switch (mode) {
      case "hidden":
      case "readonly":
        blocked = true;
        break;
      case "requires_permission":
        blocked = !privileged;
        break;
      case "requires_approval":
        blocked = phase === "post" && !privileged;
        break;
      default:
        blocked = false;
    }
    if (blocked) violations.push({ itemId: id, mode, reason });
  }
  return violations;
}

// Arabic label per mode — used to build the guard's rejection message so the
// user sees WHY a line was blocked (mirrors the frontend labels).
export const USAGE_MODE_LABEL_AR: Record<UsageMode, string> = {
  allowed: "مسموح",
  hidden: "مخفي",
  readonly: "للقراءة فقط",
  requires_approval: "يتطلب موافقة",
  requires_permission: "يتطلب صلاحية",
};

// Extract the candidate itemIds from a document's line array (any shape that
// carries `itemId`). De-duped, positive integers only. Central so every route
// feeds the guard the same way.
export function lineItemIds(lines: unknown): number[] {
  if (!Array.isArray(lines)) return [];
  const ids = lines
    .map((l: any) => Number(l?.itemId))
    .filter((n: number) => Number.isInteger(n) && n > 0);
  return Array.from(new Set(ids));
}

// Human (Arabic) rejection message a route returns as a 403 when the usage
// guard blocks a save/post. Lists the offending modes, item ids, and any
// admin-authored reasons so the user understands WHY and what to request.
export function usageViolationMessage(violations: UsageViolation[], phase: "save" | "post"): string {
  if (violations.length === 0) return "";
  const ids = violations.map(v => v.itemId).join("، ");
  const modes = Array.from(new Set(violations.map(v => USAGE_MODE_LABEL_AR[v.mode])));
  const reasons = Array.from(new Set(violations.map(v => v.reason).filter((r): r is string => !!r && r.trim().length > 0)));
  const head = phase === "post"
    ? "تعذّر ترحيل المستند بسبب قيود توجيه الأصناف"
    : "تعذّر حفظ المستند بسبب قيود توجيه الأصناف";
  let msg = `${head} (${modes.join("، ")}). أرقام الأصناف: ${ids}.`;
  if (reasons.length) msg += ` السبب: ${reasons.join("؛ ")}.`;
  msg += " يلزم صلاحية «تجاوز قيود توجيه الأصناف» للمتابعة.";
  return msg;
}
