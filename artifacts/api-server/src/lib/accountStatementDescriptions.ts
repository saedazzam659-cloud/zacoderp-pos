type EmployeeCustodyStatementSource = {
  entryType?: string | null;
  employeeNameAr?: string | null;
  employeeNameEn?: string | null;
  purpose?: string | null;
  settlementDescription?: string | null;
};

/**
 * Builds the source-aware description for HR monetary custody entries.
 * Keeping this separate from the SQL route makes the display contract easy to
 * test and ensures the same description reaches screen, Excel, PDF, and print.
 */
export function employeeCustodyStatementDescription(
  source: EmployeeCustodyStatementSource,
): string | null {
  if (
    source.entryType !== "employee_custody" &&
    source.entryType !== "employee_custody_settlement" &&
    source.entryType !== "employee_custody_return"
  ) {
    return null;
  }

  const employeeName =
    (source.employeeNameAr ?? "").trim() ||
    (source.employeeNameEn ?? "").trim();
  const purpose = (source.purpose ?? "").trim();
  const settlementDescription = (source.settlementDescription ?? "").trim();
  const title =
    source.entryType === "employee_custody"
      ? "صرف عهدة"
      : source.entryType === "employee_custody_return"
      ? "إرجاع عهدة"
      : "تسوية عهدة";

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