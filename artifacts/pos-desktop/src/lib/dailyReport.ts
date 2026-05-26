// Daily Z-Report aggregator.
//
// Reads offline_invoices rows for a calendar day (UTC text match on
// created_at) from the local SQLite table via the Tauri command
// `daily_report_invoices(date)`. Falls back to the browser localStorage
// store used by lib/invoices.ts dev mode so the report works end-to-end
// in the Vite preview too.
//
// All aggregation happens in the frontend — the Rust side is a thin
// row-fetcher so we don't have to evolve a query API per KPI.

import { IS_TAURI, tauriInvoke, lsRead, LS_KEYS } from "./localStore";
import type { OfflineInvoicePayload } from "./invoices";

export interface DailyInvoiceRow {
  id: number;
  localUuid: string;
  invoiceNo: string;
  payloadJson: string;
  syncStatus: string;
  createdAt: string;
}

interface RustRow {
  id: number;
  local_uuid: string;
  invoice_no: string;
  payload_json: string;
  sync_status: string;
  created_at: string;
}

interface BrowserRow {
  id: number;
  localUuid: string;
  invoiceNo: string;
  payloadJson: string;
  syncStatus: string;
  createdAt: string;
}

export interface DailyTopItem {
  itemId: number;
  nameAr: string;
  qty: number;
  amount: number;
}

export interface DailyHourBucket {
  hour: number;          // 0..23
  sales: number;
  returns: number;
  count: number;
}

export interface DailyReport {
  date: string;          // YYYY-MM-DD
  invoiceCount: number;
  returnCount: number;
  salesGross: number;    // sum of grandTotal on sales
  salesVat: number;
  returnsGross: number;  // sum of grandTotal on returns (positive)
  returnsVat: number;
  net: number;           // salesGross - returnsGross
  averageInvoice: number;
  cashSales: number;
  cardSales: number;
  cashReturns: number;
  cardReturns: number;
  syncedCount: number;
  pendingCount: number;
  topItems: DailyTopItem[];
  hours: DailyHourBucket[];
  invoices: ReportInvoiceLine[];
}

export interface ReportInvoiceLine {
  invoiceNo: string;
  createdAt: string;
  kind: "sale" | "return";
  paymentMethod: "cash" | "card" | "other";
  customerName?: string;
  grandTotal: number;
  syncStatus: string;
}

/**
 * Compute the UTC half-open interval `[start, end)` that covers the user's
 * local calendar day. Format matches what SQLite `CURRENT_TIMESTAMP` writes
 * ("YYYY-MM-DD HH:MM:SS") so lexicographic comparison works correctly.
 */
function localDayToUtcRange(dateYmd: string): { start: string; end: string } {
  // Local midnight of the chosen day and the next day.
  const [y, m, d] = dateYmd.split("-").map(Number);
  const localStart = new Date(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0);
  const localEnd = new Date(y, (m ?? 1) - 1, (d ?? 1) + 1, 0, 0, 0, 0);
  const toSqliteUtc = (dt: Date) =>
    dt.toISOString().replace("T", " ").slice(0, 19); // "YYYY-MM-DD HH:MM:SS"
  return { start: toSqliteUtc(localStart), end: toSqliteUtc(localEnd) };
}

async function fetchRows(dateYmd: string): Promise<DailyInvoiceRow[]> {
  const { start, end } = localDayToUtcRange(dateYmd);
  if (IS_TAURI) {
    try {
      const rows = await tauriInvoke<RustRow[]>("daily_report_invoices", { startUtc: start, endUtc: end });
      return rows.map((r) => ({
        id: r.id,
        localUuid: r.local_uuid,
        invoiceNo: r.invoice_no,
        payloadJson: r.payload_json,
        syncStatus: r.sync_status,
        createdAt: r.created_at,
      }));
    } catch (e) {
      throw new Error(`فشل قراءة فواتير اليوم من قاعدة البيانات المحلية: ${(e as Error).message ?? e}`);
    }
  }
  // Browser fallback — filter the dev-mode localStorage list by local-day
  // membership of the createdAt timestamp.
  const all = lsRead<BrowserRow[]>(LS_KEYS.invoices, []);
  return all.filter((r) => {
    const t = r.createdAt;
    if (!t) return false;
    // Compare as Date so local timezone is respected (matches the Rust UTC
    // range query semantics).
    const ts = new Date(t).getTime();
    return ts >= new Date(`${start}Z`).getTime() && ts < new Date(`${end}Z`).getTime();
  });
}

function safeParsePayload(json: string): (OfflineInvoicePayload & { kind?: string }) | null {
  try { return JSON.parse(json); } catch { return null; }
}

function paymentBucket(p?: string): "cash" | "card" | "other" {
  if (p === "cash" || p === "card") return p;
  return "other";
}

export async function buildDailyReport(dateYmd: string): Promise<DailyReport> {
  const rows = await fetchRows(dateYmd);

  let salesGross = 0, salesVat = 0;
  let returnsGross = 0, returnsVat = 0;
  let invoiceCount = 0, returnCount = 0;
  let cashSales = 0, cardSales = 0, cashReturns = 0, cardReturns = 0;
  let syncedCount = 0, pendingCount = 0;

  const itemAgg = new Map<number, DailyTopItem>();
  const hours: DailyHourBucket[] = Array.from({ length: 24 }, (_, h) => ({
    hour: h, sales: 0, returns: 0, count: 0,
  }));
  const invoices: ReportInvoiceLine[] = [];

  for (const r of rows) {
    const p = safeParsePayload(r.payloadJson);
    if (!p) continue;

    const kindRaw = (p as any).kind;
    const isReturn = kindRaw === "return";
    // ReturnsScreen persists returns with NEGATIVE grandTotal/vat/qty so
    // the cloud-side replay can post a credit-note JE directly from the
    // payload. For aggregation we want unsigned magnitudes — the
    // "net = sales − returns" formula already encodes direction.
    const gross = Math.abs(Number(p.grandTotal) || 0);
    const vat = Math.abs(Number(p.vat) || 0);
    const pay = paymentBucket(p.paymentMethod);
    const hour = (() => {
      const t = p.timestamp ?? r.createdAt;
      const d = new Date(t);
      return Number.isFinite(d.getTime()) ? d.getHours() : 0;
    })();

    if (isReturn) {
      returnCount += 1;
      returnsGross += gross;
      returnsVat += vat;
      if (pay === "cash") cashReturns += gross;
      else if (pay === "card") cardReturns += gross;
      hours[hour].returns += gross;
    } else {
      invoiceCount += 1;
      salesGross += gross;
      salesVat += vat;
      if (pay === "cash") cashSales += gross;
      else if (pay === "card") cardSales += gross;
      hours[hour].sales += gross;
    }
    hours[hour].count += 1;

    if (r.syncStatus === "synced") syncedCount += 1;
    else pendingCount += 1;

    // Item-level aggregation. Lines on a return payload already carry
    // negative qty, so we normalize to absolute and apply the sign once
    // based on `isReturn` — otherwise the two negatives cancel out and
    // a return would *add* to the top-sellers list.
    if (Array.isArray(p.lines)) {
      for (const l of p.lines) {
        const id = Number((l as any).itemId);
        if (!Number.isFinite(id)) continue;
        const qty = Math.abs(Number(l.qty) || 0);
        const lineAmt = qty * Math.abs(Number(l.unitPrice) || 0);
        const sign = isReturn ? -1 : 1;
        const prev = itemAgg.get(id) ?? { itemId: id, nameAr: l.nameAr ?? `#${id}`, qty: 0, amount: 0 };
        prev.qty += sign * qty;
        prev.amount += sign * lineAmt;
        prev.nameAr = l.nameAr ?? prev.nameAr;
        itemAgg.set(id, prev);
      }
    }

    invoices.push({
      invoiceNo: r.invoiceNo,
      createdAt: r.createdAt,
      kind: isReturn ? "return" : "sale",
      paymentMethod: pay,
      customerName: p.customerName,
      grandTotal: gross,
      syncStatus: r.syncStatus,
    });
  }

  const net = salesGross - returnsGross;
  const averageInvoice = invoiceCount > 0 ? salesGross / invoiceCount : 0;

  const topItems = Array.from(itemAgg.values())
    .filter((i) => i.amount !== 0)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .slice(0, 10);

  return {
    date: dateYmd,
    invoiceCount, returnCount,
    salesGross, salesVat,
    returnsGross, returnsVat,
    net, averageInvoice,
    cashSales, cardSales, cashReturns, cardReturns,
    syncedCount, pendingCount,
    topItems, hours, invoices,
  };
}

/** Build a YYYY-MM-DD string from the user's LOCAL date (not UTC). */
export function todayLocalYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
