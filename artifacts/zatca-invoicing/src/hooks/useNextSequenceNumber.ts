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
  | "journal_entry"
  | "stock_transfer" | "stock_adjustment" | "stock_count"
  | "receipt_voucher" | "payment_voucher"
  | "pos_receipt"
  | "production_order"
  | "contracting_project" | "contracting_bill";

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
export function useNextSequenceNumber(txType: SequenceTxType, enabled = true) {
  const [data, setData] = useState<PeekResult>({ number: null, hasSequence: false });
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const refetch = useCallback(async () => {
    if (!enabled) return;
    const my = ++seq.current;
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/api/sequences/peek/${txType}`, { headers: authHeaders() });
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
  }, [txType, enabled]);

  useEffect(() => { refetch(); }, [refetch]);

  return { ...data, loading, refetch };
}
