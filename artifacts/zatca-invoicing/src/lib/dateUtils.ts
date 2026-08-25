export function getDaysRemaining(endDateStr: string | null, today = new Date()): number | null {
  if (!endDateStr) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDateStr)) return null;

  // Compare calendar dates at UTC midnight. Building both sides from calendar
  // parts avoids timezone and daylight-saving offsets. "Today" is explicitly
  // the Saudi business date so UI badges match server-side alert windows.
  const [y, m, d] = endDateStr.split("-").map(Number);
  const endMs = Date.UTC(y, m - 1, d);
  const parsed = new Date(endMs);
  if (
    parsed.getUTCFullYear() !== y
    || parsed.getUTCMonth() !== m - 1
    || parsed.getUTCDate() !== d
  ) return null;

  const todayParts = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone: "Asia/Riyadh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(today);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(todayParts.find((item) => item.type === type)?.value);
  const todayMs = Date.UTC(part("year"), part("month") - 1, part("day"));
  return Math.round((endMs - todayMs) / 86_400_000);
}
