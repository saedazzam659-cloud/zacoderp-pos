export type DisplayZatcaStatus = "approved" | "rejected" | "pending";

/**
 * Convert the persisted gateway verdict into the compact status vocabulary
 * used by invoice grids and reports.
 */
export function normalizeZatcaStatus(status: unknown): DisplayZatcaStatus | null {
  if (typeof status !== "string") return null;
  switch (status.trim().toLowerCase()) {
    case "approved":
    case "accepted":
    case "cleared":
    case "reported":
    case "reported_with_warnings":
      return "approved";
    case "rejected":
      return "rejected";
    case "pending":
      return "pending";
    default:
      return null;
  }
}
