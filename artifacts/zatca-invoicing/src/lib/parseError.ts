// Centralized helper to extract a user-friendly error message
// from various server/HTTP error shapes (fetch + axios + raw JSON strings).
export function parseError(e: any, fallback = "حدث خطأ غير متوقع"): string {
  if (!e) return fallback;
  // Axios-style error
  if (e.response?.data?.error) return String(e.response.data.error);
  if (e.response?.data?.message) return String(e.response.data.message);
  // Plain Error.message — may contain JSON or plain text
  const msg = typeof e === "string" ? e : (e.message ?? "");
  if (!msg) return fallback;
  // Try to parse as JSON {error: "..."}
  try {
    const j = JSON.parse(msg);
    return j.error ?? j.message ?? msg;
  } catch { /* not JSON */ }
  return msg;
}
