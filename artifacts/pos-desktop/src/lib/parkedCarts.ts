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
export async function listParkedCarts(posSessionId: number): Promise<ParkedCart[]> {
  if (IS_TAURI) {
    try {
      return await tauriInvoke<ParkedCart[]>("parked_carts_list", { posSessionId });
    } catch (e) {
      console.warn("[parkedCarts] Tauri list failed, falling back to localStorage", e);
    }
  }
  const all = lsRead<ParkedCart[]>(LS_KEY, []);
  return all
    .filter(c => c.posSessionId === posSessionId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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

  if (IS_TAURI) {
    try {
      await tauriInvoke("parked_carts_upsert", { cart });
      return cart;
    } catch (e) {
      console.warn("[parkedCarts] Tauri upsert failed, falling back", e);
    }
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
export async function deleteParkedCart(id: string): Promise<void> {
  if (IS_TAURI) {
    try { await tauriInvoke("parked_carts_delete", { id }); return; }
    catch (e) { console.warn("[parkedCarts] Tauri delete failed, falling back", e); }
  }
  const all = lsRead<ParkedCart[]>(LS_KEY, []);
  lsWrite(LS_KEY, all.filter(c => c.id !== id));
}

// ─── Clear all carts for a session (called on logout / session close) ─
export async function clearSessionParkedCarts(posSessionId: number): Promise<void> {
  if (IS_TAURI) {
    try { await tauriInvoke("parked_carts_clear_session", { posSessionId }); return; }
    catch (e) { console.warn("[parkedCarts] Tauri clear failed, falling back", e); }
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
