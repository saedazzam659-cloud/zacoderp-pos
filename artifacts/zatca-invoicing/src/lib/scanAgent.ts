// ─── Local scan-agent client ──────────────────────────────────────────────
// Browsers cannot talk to TWAIN/WIA scanners directly (security sandbox).
// The universal workaround: a tiny local helper ("Zacode Scan Agent", a
// single .bat the user downloads from the archive dialog) listens on
// http://127.0.0.1:27345 and drives ANY Windows-installed scanner via WIA.
// 127.0.0.1 counts as a secure context, so the HTTPS app may fetch it; the
// agent answers Chrome's Private-Network-Access preflight with
// `Access-Control-Allow-Private-Network: true`.

const AGENT_BASE = "http://127.0.0.1:27345";

export interface ScannerDevice {
  id: string;
  name: string;
}

async function fetchAgent(path: string, init?: RequestInit, timeoutMs = 4000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${AGENT_BASE}${path}`, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** true when the local agent is up and responding. */
export async function agentHealth(): Promise<boolean> {
  try {
    const r = await fetchAgent("/health", undefined, 2500);
    if (!r.ok) return false;
    const j = await r.json();
    return j?.ok === true && j?.agent === "zacode-scan";
  } catch {
    return false;
  }
}

/** List scanners installed on the user's Windows machine. */
export async function agentDevices(): Promise<ScannerDevice[]> {
  const r = await fetchAgent("/devices", undefined, 15000);
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.ok) throw new Error(j?.error ?? "تعذّر قراءة قائمة الماسحات");
  return Array.isArray(j.devices) ? j.devices : [];
}

export interface ScanOptions {
  deviceId?: string | null;
  /** 75–600, default 200 */
  dpi?: number;
  /** WIA intent: 1 = colour, 2 = grayscale, 4 = black & white */
  color?: 1 | 2 | 4;
}

/** Run one scan and return the page as a data-URL (image/jpeg). */
export async function agentScan(opts: ScanOptions = {}): Promise<string> {
  const r = await fetchAgent(
    "/scan",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: opts.deviceId ?? null,
        dpi: opts.dpi ?? 200,
        color: opts.color ?? 1,
      }),
    },
    180_000, // scanning a page can genuinely take a couple of minutes
  );
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.ok || !j?.imageBase64) {
    const raw = String(j?.error ?? "فشل المسح الضوئي");
    if (raw === "NO_SCANNER") throw new Error("لا يوجد ماسح ضوئي معرّف على هذا الجهاز");
    throw new Error(raw);
  }
  return `data:${j.contentType || "image/jpeg"};base64,${j.imageBase64}`;
}

/** Convert an agent data-URL into a File (so the normal page pipeline applies). */
export function dataUrlToFile(dataUrl: string, filename: string): File {
  const [head, b64] = dataUrl.split(",", 2);
  const mime = /data:([^;]+)/.exec(head)?.[1] ?? "image/jpeg";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], filename, { type: mime });
}
