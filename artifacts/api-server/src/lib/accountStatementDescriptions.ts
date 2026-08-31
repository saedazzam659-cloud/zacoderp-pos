type EmployeeCustodyStatementSource = {
  custodyId?: number | null;
  entryType?: string | null;
  employeeNameAr?: string | null;
  employeeNameEn?: string | null;
  purpose?: string | null;
  settlementDescription?: string | null;
};

export type PartyDocumentStatementSourceKind =
  | "purchase_invoice"
  | "sales_invoice"
  | "purchase_return"
  | "sales_return";

type PartyDocumentStatementDescriptionInput = {
  entryType?: string | null;
  sourceKind?: PartyDocumentStatementSourceKind | null;
  paymentType?: string | null;
  debit?: number | string | null;
  credit?: number | string | null;
  isLinkedPartyAccount: boolean;
  existingSourceDescription: string | null | undefined;
};

/**
 * Separates the two AP/AR pass-through legs of an immediately paid document
 * for display in the account statement only. The source/party checks are
 * intentionally inputs so this helper cannot infer identity from an account
 * type and accidentally relabel a control, tax, cash, or manual-JE line.
 */
export function partyDocumentStatementDescription(
  input: PartyDocumentStatementDescriptionInput,
): string | null | undefined {
  const {
    entryType,
    sourceKind,
    paymentType,
    isLinkedPartyAccount,
    existingSourceDescription,
  } = input;

  if (
    !sourceKind ||
    entryType !== sourceKind ||
    (paymentType !== "cash" && paymentType !== "bank") ||
    !isLinkedPartyAccount
  ) {
    return existingSourceDescription;
  }

  const debit = Number(input.debit ?? 0);
  const credit = Number(input.credit ?? 0);
  const method = paymentType === "cash" ? "نقدي" : "بنكي";

  if (sourceKind === "purchase_invoice" && debit > 0) {
    return `سداد فاتورة مشتريات - ${method}`;
  }
  if (sourceKind === "sales_invoice" && credit > 0) {
    return `تحصيل فاتورة مبيعات - ${method}`;
  }
  if (sourceKind === "purchase_return" && credit > 0) {
    return `استرداد مرتجع مشتريات - ${method}`;
  }
  if (sourceKind === "sales_return" && debit > 0) {
    return `رد قيمة مرتجع مبيعات - ${method}`;
  }

  return existingSourceDescription;
}

/**
 * Builds the source-aware description for HR monetary custody entries.
 * Keeping this separate from the SQL route makes the display contract easy to
 * test and ensures the same description reaches screen, Excel, PDF, and print.
 */
export function employeeCustodyStatementDescription(
  source: EmployeeCustodyStatementSource,
): string | null {
  const isCustodyEntryType =
    source.entryType === "employee_custody" ||
    source.entryType === "employee_custody_settlement" ||
    source.entryType === "employee_custody_return";
  // A custody created from a Payment Voucher deliberately reuses that
  // voucher's JE, whose entry_type remains "payment". The source-row link is
  // therefore the authoritative signal that this statement row belongs to a
  // custody disbursement.
  if (!isCustodyEntryType && source.custodyId == null) {
    return null;
  }

  const employeeName =
    (source.employeeNameAr ?? "").trim() ||
    (source.employeeNameEn ?? "").trim();
  const purpose = (source.purpose ?? "").trim();
  const settlementDescription = (source.settlementDescription ?? "").trim();
  const title =
    source.entryType === "employee_custody_return"
      ? "إرجاع عهدة"
      : source.entryType === "employee_custody_settlement"
      ? "تسوية عهدة"
      : "صرف عهدة";

  const parts = [
    title,
    employeeName ? `الموظف: ${employeeName}` : "",
    purpose ? `الغرض: ${purpose}` : "",
    source.entryType === "employee_custody_settlement" && settlementDescription
      ? `تفاصيل التسوية: ${settlementDescription}`
      : "",
  ].filter(Boolean);

  return parts.length > 1 ? parts.join(" — ") : null;
}