// Helper: download a CSV blob from a server endpoint that requires the
// Authorization header. Browser <a download> can't carry custom headers, so we
// fetch the body, blob it, then hand off to the shared Save-As writer.
import { saveBlob } from "../../../../lib/saveFile";

export async function downloadCsv(token: string | null, url: string, filename: string): Promise<void> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    const msg = (await r.json().catch(() => ({}))).error ?? "تعذر تنزيل الملف";
    throw new Error(msg);
  }
  const blob = await r.blob();
  await saveBlob(blob, filename);
}
