export type AccountNoteVisibilityKey =
  | "showCustomerDebitNotes"
  | "showSupplierCreditNotes";

/**
 * Cross-type account notes are hidden unless the active company explicitly
 * enables them. A platform superadmin with no active company keeps the
 * existing all-company navigation behavior.
 */
export function isAccountNoteVisible(
  user: any,
  key: AccountNoteVisibilityKey,
): boolean {
  if (!user) return false;
  if (user.role === "superadmin" && user.company?.id == null) return true;
  return user.company?.[key] === true;
}
