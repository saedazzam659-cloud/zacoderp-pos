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
