import { hasZatcaArtifacts } from "./invoiceDeletionTombstone.js";

export const RETURN_LINE_SNAPSHOT_KEYS = ["lines", "returnLines", "salesReturnLines", "sales_return_lines"] as const;

export type RestoreAssessment = {
  allowed: boolean;
  reason: string | null;
  lineCount: number | null;
};

export function getReturnLineSnapshot(payload: any): any[] | null {
  for (const key of RETURN_LINE_SNAPSHOT_KEYS) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return null;
}

/** Fail closed for any deleted sales return that cannot be restored in full. */
export function assessSalesReturnRestoreSnapshot(snap: any): RestoreAssessment {
  const payload = snap?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { allowed: false, reason: "invalid_snapshot", lineCount: null };
  }
  if (Number(payload.id) !== Number(snap.recordId)) {
    return { allowed: false, reason: "record_id_mismatch", lineCount: null };
  }
  if (snap.companyId == null || Number(payload.companyId) !== Number(snap.companyId)) {
    return { allowed: false, reason: "company_id_mismatch", lineCount: null };
  }
  const lines = getReturnLineSnapshot(payload);
  if (payload.status !== "draft") return { allowed: false, reason: "not_draft", lineCount: lines?.length ?? 0 };
  if (payload.journalEntryId != null) return { allowed: false, reason: "posted_document", lineCount: lines?.length ?? 0 };
  if (hasZatcaArtifacts(payload)) return { allowed: false, reason: "zatca_artifacts", lineCount: lines?.length ?? 0 };
  if (!lines?.length) return { allowed: false, reason: "missing_return_lines", lineCount: 0 };
  if (!payload.returnDate) return { allowed: false, reason: "incomplete_snapshot", lineCount: lines.length };
  if (lines.some(line => !line || typeof line !== "object" || !String(line.itemName ?? "").trim())) {
    return { allowed: false, reason: "incomplete_return_lines", lineCount: lines.length };
  }
  return { allowed: true, reason: null, lineCount: lines.length };
}