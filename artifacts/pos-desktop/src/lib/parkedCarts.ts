// Park / hold-and-resume invoice support — Task #175.
//
// A "parked cart" is an in-progress sale the cashier sets aside (e.g. while
// the customer runs to the car for their wallet) so the next customer can be
// checked out without losing the partial work. It lives ONLY on this device
// — it is NEVER pushed to the cloud (the cloud is the source of truth for
// FINALIZED invoices; parked carts are scratchpad state).
//
// Scoped to the open POS session: clearing the session (logout, shift close)
// purges that session's parked carts so a new cashier doesn't inherit them.
//
// Storage: prefers SQLite via Tauri invoke (parked_carts table, see db.rs).
// Browser/dev mode and any Tauri error fall back to localStorage so the
// feature still works end-to-end in the Vite preview.

import { IS_TAURI, tauriInvoke, lsRead, lsWrite } from "./localStore";
import type { LocalItem } from "./items";

export interface ParkedCartLine {
  itemId: number;
  nameAr: string;
  salePrice: number;
  vatRate: number;
  barcode?: string | null;
  qty: number;
  /** Multi-unit sale: present when the line was sold as a non-base unit
   * (carton / half-carton). `salePrice` already holds the per-unit price and
   * `qty` counts these units; these fields let resume rebuild the cart line's
   * unit (name shown on screen + factor used for stock deduction). */
  unitId?: string | null;
  unitName?: string | null;
  unitFactor?: number | null;
}

export interface ParkedCart {
  id: string;                 // local UUID
  posSessionId: number;       // scope: only this cashier's session sees it
  label: string;              // user-visible name (auto "سلة #N" or customer note)
  customerNote?: string | null;
  lines: ParkedCartLine[];
  grandTotal: number;
  createdAt: string;          // ISO
  updatedAt: string;          // ISO
}

const LS_KEY = "pos_desktop_parked_carts_v1";

function uuid(): string {
  return (crypto as any).randomUUID?.()
    ?? `cart-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function lineFromItem(item: LocalItem, qty: number): ParkedCartLine {
  return {
    itemId: item.id,
    nameAr: item.nameAr,
    salePrice: item.salePrice,
    vatRate: item.vatRate,
    barcode: item.barcode ?? null,
    qty,
  };
}

// ─── List (session-scoped) ──────────────────────────────────────────
// MERGE strategy (defensive): we always read BOTH SQLite AND localStorage
// and union by id. Previous behavior was Tauri-OR-localStorage which silently
// lost carts whenever the Tauri save succeeded but the Tauri list call later
// rejected (e.g. arg-rename mismatch, schema drift in an upgraded install).
// SQLite is treated as authoritative on conflicts (more recent updatedAt
// wins inside the merge).
export async function listParkedCarts(posSessionId: number): Promise<ParkedCart[]> {
  const fromTauri: ParkedCart[] = [];
  if (IS_TAURI) {
    try {
      const rows = await tauriInvoke<ParkedCart[]>("parked_carts_list", { posSessionId });
      fromTauri.push(...rows);
    } catch (e) {
      console.warn("[parkedCarts] Tauri list failed, using localStorage mirror only", e);
    }
  }
  const fromLs = lsRead<ParkedCart[]>(LS_KEY, [])
    .filter(c => c.posSessionId === posSessionId);

  // Merge by id; whichever side has the more recent updatedAt wins.
  const byId = new Map<string, ParkedCart>();
  for (const c of [...fromTauri, ...fromLs]) {
    const prev = byId.get(c.id);
    if (!prev || c.updatedAt.localeCompare(prev.updatedAt) > 0) {
      byId.set(c.id, c);
    }
  }
  return Array.from(byId.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ─── Save (upsert) ──────────────────────────────────────────────────
export async function saveParkedCart(input: {
  id?: string;
  posSessionId: number;
  label?: string;
  customerNote?: string | null;
  lines: ParkedCartLine[];
}): Promise<ParkedCart> {
  const now = new Date().toISOString();
  const grandTotal = input.lines.reduce((s, l) => s + l.salePrice * l.qty, 0);
  const cart: ParkedCart = {
    id: input.id ?? uuid(),
    posSessionId: input.posSessionId,
    label: input.label?.trim() || `سلة ${new Date(now).toLocaleTimeString("ar-SA")}`,
    customerNote: input.customerNote ?? null,
    lines: input.lines,
    grandTotal,
    createdAt: now,
    updatedAt: now,
  };

  // Always mirror to localStorage — even when Tauri succeeds — so that a
  // later list-side rejection (arg mismatch, schema drift) doesn't make the
  // cart vanish from the user's view. listParkedCarts() unions both stores.
  if (IS_TAURI) {
    try { await tauriInvoke("parked_carts_upsert", { cart }); }
    catch (e) { console.warn("[parkedCarts] Tauri upsert failed, relying on localStorage mirror", e); }
  }
  const all = lsRead<ParkedCart[]>(LS_KEY, []);
  const existingIdx = all.findIndex(c => c.id === cart.id);
  if (existingIdx >= 0) {
    cart.createdAt = all[existingIdx].createdAt;
    all[existingIdx] = cart;
  } else {
    all.push(cart);
  }
  lsWrite(LS_KEY, all);
  return cart;
}

// ─── Delete (one) ───────────────────────────────────────────────────
// Since save mirrors to BOTH SQLite and localStorage, delete must do the
// same — otherwise a row deleted from SQLite would resurface from the LS
// mirror on the next merge-read ("ghost carts").
export async function deleteParkedCart(id: string): Promise<void> {
  if (IS_TAURI) {
    try { await tauriInvoke("parked_carts_delete", { id }); }
    catch (e) { console.warn("[parkedCarts] Tauri delete failed, clearing LS mirror only", e); }
  }
  const all = lsRead<ParkedCart[]>(LS_KEY, []);
  lsWrite(LS_KEY, all.filter(c => c.id !== id));
}

// ─── Clear all carts for a session (called on logout / session close) ─
// Same mirror-cleanup rationale as deleteParkedCart.
export async function clearSessionParkedCarts(posSessionId: number): Promise<void> {
  if (IS_TAURI) {
    try { await tauriInvoke("parked_carts_clear_session", { posSessionId }); }
    catch (e) { console.warn("[parkedCarts] Tauri clear failed, clearing LS mirror only", e); }
  }
  const all = lsRead<ParkedCart[]>(LS_KEY, []);
  lsWrite(LS_KEY, all.filter(c => c.posSessionId !== posSessionId));
}

// ─── Cross-component handoff: "resume this cart" ─────────────────────
// ParkedCarts page writes the id here and switches the view to "sales".
// SalesScreen reads + clears it on mount and hydrates its state from the
// matching cart. Using sessionStorage so a hard refresh during the handoff
// window doesn't carry it over silently.
const RESUME_KEY = "pos_desktop_resume_parked_cart_id";
export function setResumeCartId(id: string): void { try { sessionStorage.setItem(RESUME_KEY, id); } catch { /* ignore */ } }
export function takeResumeCartId(): string | null {
  try {
    const v = sessionStorage.getItem(RESUME_KEY);
    if (v) sessionStorage.removeItem(RESUME_KEY);
    return v;
  } catch { return null; }
}
