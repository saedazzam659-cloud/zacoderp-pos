// ─── Item Usage Control — frontend client (Phase ب) ─────────────────────────
// Companion to the backend `itemUsageControl.ts` guard. A document form fetches
// the per-screen routing rules ONCE via `useScreenItemModes(screenKey)` and then
// runs its item-picker options through `annotateItemCombo(...)` so the picker
// reflects each rule BEFORE the user tries to add a line:
//   hidden               → row dropped entirely
//   readonly             → row disabled (never addable)
//   requires_permission  → disabled for unprivileged, badge for privileged
//   requires_approval    → badge only (line saves as draft; POST is the gate)
//
// This is a UX layer only — the authoritative enforcement is the server guard
// (`checkItemsUsable`) on create/post. On any fetch error we fail OPEN (empty
// rule map) so a transient network blip never blocks the whole form; the backend
// still refuses a violating save.
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import type { ComboboxItem } from "@/components/ui/search-combobox";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export type UsageMode =
  | "allowed"
  | "hidden"
  | "readonly"
  | "requires_approval"
  | "requires_permission";

export interface UsageRule {
  mode: UsageMode;
  reason: string | null;
}

export interface ScreenModes {
  /** itemId → non-default rule. Absent ⇒ the item is freely usable. */
  modes: Record<number, UsageRule>;
  /** caller may override requires_permission / requires_approval gates. */
  privileged: boolean;
}

const EMPTY: ScreenModes = { modes: {}, privileged: false };

/**
 * Fetch the non-default usage rules for one screen across the company's
 * catalogue, plus whether the caller is usage-privileged. Scoped identically to
 * the form's own item fetch (Bearer token; superadmin relies on the resolved
 * acting-company), so if items load, their rules load too.
 */
export function useScreenItemModes(screenKey: string): ScreenModes {
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const q = useQuery({
    queryKey: ["item-usage-modes", screenKey, cid ?? "all"],
    enabled: !!screenKey,
    staleTime: 60_000,
    queryFn: async (): Promise<ScreenModes> => {
      const token = localStorage.getItem("zatca_token");
      const url =
        `${API}/api/inventory/items/usage-modes?screenKey=${encodeURIComponent(screenKey)}` +
        (cid ? `&companyId=${cid}` : "");
      try {
        const r = await fetch(url, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!r.ok) return EMPTY;
        const d = await r.json();
        return { modes: d?.modes ?? {}, privileged: !!d?.privileged };
      } catch {
        return EMPTY;
      }
    },
  });
  return q.data ?? EMPTY;
}

const BADGE_APPROVAL = "bg-sky-100 text-sky-700 border-sky-200";
const BADGE_PERMISSION = "bg-amber-100 text-amber-700 border-amber-200";

/**
 * Annotate item-picker options with their usage rule. The blank placeholder
 * option (value === "") is always kept untouched. Non-item rows without a rule
 * (or with mode "allowed") pass through unchanged.
 */
export function annotateItemCombo(items: ComboboxItem[], sm: ScreenModes): ComboboxItem[] {
  const { modes, privileged } = sm;
  const out: ComboboxItem[] = [];
  for (const it of items) {
    if (!it.value) { out.push(it); continue; }
    const rule = modes[Number(it.value)];
    if (!rule || rule.mode === "allowed") { out.push(it); continue; }
    switch (rule.mode) {
      case "hidden":
        continue;
      case "readonly":
        out.push({ ...it, disabled: true, disabledReason: rule.reason || "الصنف للقراءة فقط — غير قابل للإضافة في هذه الشاشة" });
        break;
      case "requires_permission":
        if (privileged) {
          out.push({ ...it, badge: "يتطلب صلاحية", badgeClass: BADGE_PERMISSION });
        } else {
          out.push({ ...it, disabled: true, disabledReason: rule.reason || "يتطلب صلاحية خاصة لإضافة هذا الصنف" });
        }
        break;
      case "requires_approval":
        out.push({ ...it, badge: "يتطلب موافقة", badgeClass: BADGE_APPROVAL });
        break;
      default:
        out.push(it);
    }
  }
  return out;
}
