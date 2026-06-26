import DOMPurify from "dompurify";

// ─── Office file I/O helpers ──────────────────────────────────────────────
// Open and save EXTERNAL files from the browser. Uses the File System Access
// API (showOpenFilePicker / showSaveFilePicker) when available so the editor
// can write straight back to the file the user opened. Falls back to a hidden
// <input type=file> for opening and an anchor-download for saving on browsers
// that lack the API (Firefox, Safari, in-app webviews).

export interface OpenedFile {
  file: File;
  // FileSystemFileHandle when the File System Access API is available, else null.
  handle: FileSystemFileHandle | null;
}

type AcceptMap = Record<string, string[]>;

const win = () => window as any;

export function hasFsAccess(): boolean {
  return typeof win().showOpenFilePicker === "function";
}

// Open a single file. Returns null when the user cancels.
export async function openFile(opts: {
  accept: AcceptMap;
  description?: string;
}): Promise<OpenedFile | null> {
  const w = win();
  if (typeof w.showOpenFilePicker === "function") {
    try {
      const [handle] = await w.showOpenFilePicker({
        multiple: false,
        types: [{ description: opts.description ?? "ملفات", accept: opts.accept }],
        excludeAcceptAllOption: false,
      });
      const file = await handle.getFile();
      return { file, handle };
    } catch (e: any) {
      if (e?.name === "AbortError") return null;
      // Any other failure (e.g. permission) → fall back to the input picker.
    }
  }
  return openViaInput(opts.accept);
}

function openViaInput(accept: AcceptMap): Promise<OpenedFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    const exts = Object.values(accept).flat();
    const mimes = Object.keys(accept);
    input.accept = [...mimes, ...exts].join(",");
    let settled = false;
    input.onchange = () => {
      settled = true;
      const file = input.files?.[0] ?? null;
      resolve(file ? { file, handle: null } : null);
    };
    // Best-effort cancel detection (not all browsers fire this).
    window.addEventListener(
      "focus",
      () => setTimeout(() => { if (!settled) resolve(null); }, 500),
      { once: true },
    );
    input.click();
  });
}

async function writeToHandle(handle: FileSystemFileHandle, data: Blob): Promise<boolean> {
  try {
    const writable = await (handle as any).createWritable();
    await writable.write(data);
    await writable.close();
    return true;
  } catch {
    return false;
  }
}

// Save a blob. When `handle` is supplied (the file the user opened) the data is
// written straight back to it. Otherwise a Save dialog (or download) is used.
// Returns the handle that was written to, so callers can keep saving in place.
export async function saveFile(
  data: Blob,
  opts: {
    suggestedName: string;
    accept: AcceptMap;
    description?: string;
    handle?: FileSystemFileHandle | null;
  },
): Promise<{ saved: boolean; handle: FileSystemFileHandle | null }> {
  const w = win();

  if (opts.handle) {
    const ok = await writeToHandle(opts.handle, data);
    if (ok) return { saved: true, handle: opts.handle };
    // Fall through to a fresh dialog when writing back fails.
  }

  if (typeof w.showSaveFilePicker === "function") {
    let handle: FileSystemFileHandle;
    try {
      handle = await w.showSaveFilePicker({
        suggestedName: opts.suggestedName,
        types: [{ description: opts.description ?? "ملفات", accept: opts.accept }],
      });
    } catch (e: any) {
      if (e?.name === "AbortError") return { saved: false, handle: null };
      throw e; // surface real picker failures to the caller
    }
    const writable = await (handle as any).createWritable();
    await writable.write(data);
    await writable.close();
    return { saved: true, handle };
  }

  // File System Access API unavailable → download fallback.
  downloadBlob(data, opts.suggestedName);
  return { saved: true, handle: null };
}

export function downloadBlob(data: Blob, filename: string) {
  const url = URL.createObjectURL(data);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function readAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return file.arrayBuffer();
}

export function readAsText(file: File): Promise<string> {
  return file.text();
}

// Swap/append a file extension on a name (keeps the base).
export function withExtension(name: string, ext: string): string {
  const base = name.replace(/\.[^./\\]+$/, "");
  return `${base}.${ext.replace(/^\./, "")}`;
}

// Print arbitrary HTML in an isolated iframe so the user can "Save as PDF".
// Isolated document avoids the app's flex/overflow ancestors clipping output.
// HTML is sanitized first — the iframe is same-origin so unsanitized markup
// could execute scripts in the app context.
export function printHtml(rawHtml: string, opts?: { title?: string; rtl?: boolean }) {
  const innerHtml = DOMPurify.sanitize(rawHtml, { USE_PROFILES: { html: true } });
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);
  const dir = opts?.rtl === false ? "ltr" : "rtl";
  const doc = iframe.contentDocument!;
  doc.open();
  doc.write(`<!DOCTYPE html><html dir="${dir}" lang="ar"><head><meta charset="utf-8"><title>${
    opts?.title ?? "طباعة"
  }</title><style>
    *{box-sizing:border-box;}
    body{font-family:'Segoe UI',Tahoma,Arial,sans-serif;margin:24px;color:#111;line-height:1.6;}
    h1,h2,h3{margin:0.4em 0;}
    table{border-collapse:collapse;width:100%;}
    th,td{border:1px solid #999;padding:6px 8px;text-align:${dir === "rtl" ? "right" : "left"};font-size:13px;}
    th{background:#f1f5f9;}
    @page{margin:14mm;}
  </style></head><body>${innerHtml}</body></html>`);
  doc.close();
  const cleanup = () => setTimeout(() => iframe.remove(), 1000);
  iframe.onload = () => {
    try {
      iframe.contentWindow!.focus();
      iframe.contentWindow!.print();
    } finally {
      cleanup();
    }
  };
}
