// Helper: download a CSV blob from a server endpoint that requires the
// Authorization header. Browser <a download> can't carry custom headers, so we
// fetch the body, blob it, and trigger a synthetic anchor click.

export async function downloadCsv(token: string | null, url: string, filename: string): Promise<void> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    const msg = (await r.json().catch(() => ({}))).error ?? "تعذر تنزيل الملف";
    throw new Error(msg);
  }
  const blob = await r.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Free the blob URL on the next tick so the click has time to be processed.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
