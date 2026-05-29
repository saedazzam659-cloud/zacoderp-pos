import { useCallback, useEffect, useRef, useState } from "react";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authHeaders(): Record<string, string> {
  const t = localStorage.getItem("zatca_token");
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (t) h["Authorization"] = `Bearer ${t}`;
  return h;
}

export type SequenceTxType =
  | "sales_quotation"
  | "sales_invoice" | "sales_return" | "sales_order"
  | "purchase_invoice" | "purchase_return" | "purchase_order"
  | "goods_receipt" | "goods_delivery"
  | "journal_entry"
  | "stock_transfer" | "stock_adjustment" | "stock_count"
  | "receipt_voucher" | "payment_voucher"
  | "pos_receipt"
  | "production_order"
  | "contracting_project" | "contracting_bill"
  | "cost_center" | "fixed_asset" | "maintenance_order"
  | "crm_lead" | "hotel_booking" | "installment_contract"
  | "cash_transfer" | "offer" | "employee" | "hr_contract";

export interface PeekResult {
  number: string | null;
  hasSequence: boolean;
  sequenceCode?: string;
  exhausted?: boolean;
}

/**
 * Loads the next document-number from the central sequence engine
 * (مسلسل الحركات) WITHOUT incrementing it. Use to populate read-only
 * document-number fields on every operational form.
 *
 * Behaviour:
 *   • While loading: returns { number: null, hasSequence: false, loading: true }.
 *   • If a sequence is configured: number is the formatted next value and
 *     hasSequence === true → field should be rendered read-only.
 *   • If no active sequence is configured for this tx type: hasSequence === false
 *     → callers should fall back to a free-typed input ("تلقائي" placeholder).
 *   • If the sequence is configured but exhausted: number is null with
 *     exhausted === true so the UI can warn the user before submit.
 *
 * Pass `enabled=false` to skip the fetch (useful when editing an existing
 * record, where the saved docNumber is shown instead).
 */
export function useNextSequenceNumber(
  txType: SequenceTxType,
  enabled = true,
  /** Optional document date (YYYY-MM-DD). When supplied, the peek is
   *  resolved against the fiscal period containing this date — so a JE
   *  the user backdated to 2025 reflects the 2025-eligible sequence, not
   *  the FY 2026 scoped sequence the form opened on. Re-fetches whenever
   *  the date string changes. */
  date?: string | null,
  /** Optional branch id. Each (sequence, branch) pair has its OWN running
   *  counter, so the badge MUST peek the same branch the form will submit —
   *  otherwise it reads the company-wide (branch 0) counter and stays frozen
   *  at the start number while saves advance the real branch counter. Pass the
   *  form's selected branch here; omit/empty/0 → company-wide counter. */
  branchId?: number | string | null,
) {
  const [data, setData] = useState<PeekResult>({ number: null, hasSequence: false });
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const refetch = useCallback(async () => {
    if (!enabled) return;
    const my = ++seq.current;
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (date && date !== "") qs.set("date", date);
      const bid = branchId != null && branchId !== "" ? Number(branchId) : 0;
      if (Number.isFinite(bid) && bid > 0) qs.set("branchId", String(bid));
      const q = qs.toString();
      const url = `${API_BASE}/api/sequences/peek/${txType}${q ? `?${q}` : ""}`;
      const r = await fetch(url, { headers: authHeaders() });
      if (!r.ok) {
        if (my === seq.current) setData({ number: null, hasSequence: false });
        return;
      }
      const j = await r.json() as PeekResult;
      if (my === seq.current) setData(j);
    } catch {
      if (my === seq.current) setData({ number: null, hasSequence: false });
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [txType, enabled, date, branchId]);

  useEffect(() => { refetch(); }, [refetch]);

  return { ...data, loading, refetch };
}
