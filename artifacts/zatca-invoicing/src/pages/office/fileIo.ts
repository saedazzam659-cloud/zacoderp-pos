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

// ─── PDF text extraction (PDF → Word / Excel) ─────────────────────────────
// Extracts the TEXT layer of a digitally-generated PDF using pdf.js. Scanned
// (image-only) PDFs have no text layer and yield empty pages — those need OCR,
// which is a separate (deferred) feature. Loaded dynamically to keep the main
// bundle light.

export interface PdfLine {
  // Text cells on this visual line, ordered left→right (grouped by x-gaps).
  cells: string[];
  // The whole line as a single string (cells joined with spaces).
  text: string;
}
export interface PdfPage {
  lines: PdfLine[];
}

let pdfWorkerReady = false;
async function loadPdf(file: File): Promise<any> {
  const pdfjs: any = await import("pdfjs-dist");
  if (!pdfWorkerReady) {
    // Stable Vite worker URL (resolved + fingerprinted at build); set once.
    const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    pdfWorkerReady = true;
  }
  const buf = await file.arrayBuffer();
  return pdfjs.getDocument({ data: buf }).promise;
}

// True when Arabic/Hebrew script dominates → the line reads right→left.
function isRtlLine(s: string): boolean {
  const rtl = (s.match(/[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
  const ltr = (s.match(/[A-Za-z]/g) || []).length;
  return rtl > ltr;
}

// Group raw text items into visual lines, then split each line into cells by
// horizontal gaps (so tabular PDFs map onto spreadsheet columns). Direction-
// aware: RTL lines are read right→left so Arabic text and table columns keep
// their logical order.
function itemsToLines(items: any[]): PdfLine[] {
  type Tok = { str: string; x: number; y: number; w: number };
  const toks: Tok[] = items
    .filter((it) => typeof it?.str === "string" && it.str.trim() !== "")
    .map((it) => ({
      str: it.str,
      x: it.transform?.[4] ?? 0,
      y: it.transform?.[5] ?? 0,
      w: it.width ?? 0,
    }));
  if (!toks.length) return [];

  // Cluster by Y (lines). Tolerance scaled to typical line height.
  const yTol = 3;
  toks.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: Tok[][] = [];
  for (const tk of toks) {
    const row = rows.find((r) => Math.abs(r[0].y - tk.y) <= yTol);
    if (row) row.push(tk);
    else rows.push([tk]);
  }

  return rows.map((row) => {
    const physical = row.slice().sort((a, b) => a.x - b.x);
    const rtl = isRtlLine(physical.map((t) => t.str).join(""));
    // Iterate in reading order: LTR left→right, RTL right→left.
    const reading = rtl ? physical.slice().reverse() : physical;
    // Split into cells when the horizontal gap is large relative to glyph size.
    const cells: string[] = [];
    let cur = "";
    let prev: { x: number; end: number } | null = null;
    for (const tk of reading) {
      const box = { x: tk.x, end: tk.x + tk.w };
      const charW = tk.w / Math.max(tk.str.length, 1);
      // Gap toward the previous token, measured in reading direction.
      const gap = prev == null ? 0 : rtl ? prev.x - box.end : box.x - prev.end;
      if (prev != null && gap > Math.max(charW * 2.2, 12)) {
        cells.push(cur.trim());
        cur = "";
      } else if (cur && gap > charW * 0.3) {
        cur += " ";
      }
      cur += tk.str;
      prev = box;
    }
    if (cur.trim()) cells.push(cur.trim());
    return { cells, text: cells.join(" ").replace(/\s+/g, " ").trim() };
  }).filter((l) => l.text !== "");
}

export async function extractPdf(file: File): Promise<PdfPage[]> {
  const pdf = await loadPdf(file);
  const pages: PdfPage[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    pages.push({ lines: itemsToLines(content.items) });
  }
  return pages;
}

// ── Aligned tabular extraction ───────────────────────────────────────────────
// itemsToLines splits each line independently by gaps, so an EMPTY cell (e.g. a
// blank "debit" or "credit" column on a journal-entry line) is simply dropped —
// which makes columns ragged and shifts numbers into the wrong column. For real
// tables we detect column boundaries GLOBALLY from the vertical whitespace that
// every row shares, so blank cells survive as empty strings and every row lines
// up on the same columns.

interface RawTok { str: string; x: number; y: number; w: number; }

function pageRawToks(items: any[]): RawTok[] {
  return items
    .filter((it) => typeof it?.str === "string" && it.str.trim() !== "")
    .map((it) => ({
      str: it.str,
      x: it.transform?.[4] ?? 0,
      y: it.transform?.[5] ?? 0,
      w: it.width ?? 0,
    }));
}

function groupRowsByY(toks: RawTok[], yTol = 3): RawTok[][] {
  const sorted = toks.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: RawTok[][] = [];
  for (const tk of sorted) {
    const row = rows.find((r) => Math.abs(r[0].y - tk.y) <= yTol);
    if (row) row.push(tk);
    else rows.push([tk]);
  }
  return rows;
}

function medianPositive(nums: number[]): number {
  const a = nums.filter((n) => Number.isFinite(n) && n > 0).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Column separator x-positions, derived from vertical whitespace shared by every
// row. Returns ascending boundaries; the columns are the segments between them.
function detectColumnBounds(toks: RawTok[]): number[] {
  if (!toks.length) return [];
  const intervals = toks
    .map((t) => [t.x, t.x + Math.max(t.w, 1)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1] + 0.5) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  const glyphW = medianPositive(toks.map((t) => t.w / Math.max(t.str.length, 1)));
  const minGap = Math.max(6, (glyphW || 4) * 1.6);
  const bounds: number[] = [];
  for (let i = 1; i < merged.length; i++) {
    const gap = merged[i][0] - merged[i - 1][1];
    if (gap >= minGap) bounds.push((merged[i - 1][1] + merged[i][0]) / 2);
  }
  return bounds;
}

function colIndexFor(centerX: number, bounds: number[]): number {
  let i = 0;
  while (i < bounds.length && centerX > bounds[i]) i++;
  return i;
}

// Per-line gap split (fallback for prose / non-gridded PDFs), reading-direction
// aware like itemsToLines.
function splitRowByGaps(row: RawTok[]): string[] {
  const physical = row.slice().sort((a, b) => a.x - b.x);
  const rtl = isRtlLine(physical.map((t) => t.str).join(""));
  const reading = rtl ? physical.slice().reverse() : physical;
  const cells: string[] = [];
  let cur = "";
  let prev: { x: number; end: number } | null = null;
  for (const tk of reading) {
    const box = { x: tk.x, end: tk.x + tk.w };
    const charW = tk.w / Math.max(tk.str.length, 1);
    const gap = prev == null ? 0 : rtl ? prev.x - box.end : box.x - prev.end;
    if (prev != null && gap > Math.max(charW * 2.2, 12)) {
      cells.push(cur.trim());
      cur = "";
    } else if (cur && gap > charW * 0.3) {
      cur += " ";
    }
    cur += tk.str;
    prev = box;
  }
  if (cur.trim()) cells.push(cur.trim());
  return cells.filter((_, i, a) => a.length > 0);
}

// Extract a PDF as ONE aligned table (rows × columns), with columns consistent
// across every page. Falls back to per-line gap splitting when no stable column
// grid is found (e.g. prose PDFs) so non-tabular files still import sensibly.
export async function extractPdfTable(file: File): Promise<string[][]> {
  const pdf = await loadPdf(file);
  const pageRows: RawTok[][][] = [];
  const all: RawTok[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const toks = pageRawToks(content.items);
    if (!toks.length) continue;
    pageRows.push(groupRowsByY(toks));
    all.push(...toks);
  }
  if (!all.length) return [];
  const rtl = isRtlLine(all.map((t) => t.str).join(""));
  const bounds = detectColumnBounds(all);

  // No usable grid (or absurdly many columns ⇒ prose, not a table): fall back to
  // the per-line gap heuristic.
  if (bounds.length === 0 || bounds.length > 40) {
    const out: string[][] = [];
    for (const rows of pageRows) {
      for (const row of rows) {
        const cells = splitRowByGaps(row);
        if (cells.some((c) => c !== "")) out.push(cells);
      }
    }
    return out;
  }

  const ncols = bounds.length + 1;
  const out: string[][] = [];
  for (const rows of pageRows) {
    for (const row of rows) {
      const buckets: RawTok[][] = Array.from({ length: ncols }, () => []);
      for (const tk of row) buckets[colIndexFor(tk.x + tk.w / 2, bounds)].push(tk);
      let cells = buckets.map((b) =>
        b.sort((a, c) => a.x - c.x).map((t) => t.str).join(" ").replace(/\s+/g, " ").trim(),
      );
      if (rtl) cells = cells.reverse();
      if (cells.some((c) => c !== "")) out.push(cells);
    }
  }
  return out;
}

// ── Journal-entries report flattener ─────────────────────────────────────────
export interface JournalEntriesFlat {
  headers: string[];
  rows: string[][];
  entryCount: number;
}

const JE_FLAT_HEADERS = ["رقم القيد", "التاريخ", "الحساب", "البيان", "مدين", "دائن"];

function parseAmount(s: string): string {
  const cleaned = (s || "").replace(/[^\d.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return "";
  const n = Number(cleaned);
  return Number.isFinite(n) ? String(n) : "";
}

function findDate(s: string): string {
  const m = s.match(/\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}/);
  return m ? m[0] : "";
}

// Flatten a journal-entries PDF report (repeating "رقم القيد …" header blocks,
// each with an الحساب/البيان/مدين/دائن sub-table) into ONE flat table whose
// columns line up with the Data-Import wizard's `journalEntries` entity:
// رقم القيد · التاريخ · الحساب · البيان · مدين · دائن — one row per posting line,
// header values repeated on every line. Returns null when the table is not a
// recognisable journal-entries report (caller then keeps the raw aligned table).
export function flattenJournalEntries(table: string[][]): JournalEntriesFlat | null {
  if (!table.length) return null;
  const joined = table.map((r) => r.join(" "));
  const hasDoc = joined.some((s) => /رقم\s*القيد/.test(s));
  const hasDC = joined.some((s) => /مدين/.test(s) && /دائن/.test(s));
  if (!hasDoc || !hasDC) return null;

  const resolveHeader = (row: string[]) => {
    let account = -1, desc = -1, debit = -1, credit = -1;
    row.forEach((c, i) => {
      const v = c.trim();
      if (account < 0 && /(الحساب|رقم الحساب|كود الحساب)/.test(v)) account = i;
      if (desc < 0 && /(البيان|الوصف)/.test(v)) desc = i;
      if (debit < 0 && /مدين/.test(v)) debit = i;
      if (credit < 0 && /دائن/.test(v)) credit = i;
    });
    if (account >= 0 && debit >= 0 && credit >= 0) return { account, desc, debit, credit };
    return null;
  };

  let colMap: { account: number; desc: number; debit: number; credit: number } | null = null;
  const rows: string[][] = [];
  let curDoc = "";
  let curDate = "";
  let entryCount = 0;

  for (const row of table) {
    const line = row.join(" ").trim();
    if (!line) continue;

    // Header line: "رقم القيد: 1133  التاريخ: 2022/1/1 …"
    if (/رقم\s*القيد/.test(line)) {
      const docM = line.match(/رقم\s*القيد\s*[:：]?\s*(\d+)/);
      if (docM) { curDoc = docM[1]; entryCount++; }
      const d = findDate(line);
      if (d) curDate = d;
      continue;
    }
    // Column-header row → (re)learn the column layout, then skip.
    const hdr = resolveHeader(row);
    if (hdr) { colMap = hdr; continue; }
    // Totals row → skip.
    if (/(الإجمالي|الاجمالي|المجموع)/.test(line)) continue;
    if (!colMap || !curDoc) continue;

    const account = (row[colMap.account] ?? "").trim();
    // A real posting line starts with a numeric account code.
    if (!/^\d{2,}/.test(account)) continue;
    const debit = parseAmount(row[colMap.debit] ?? "");
    const credit = parseAmount(row[colMap.credit] ?? "");
    if (debit === "" && credit === "") continue;
    const desc = colMap.desc >= 0 ? (row[colMap.desc] ?? "").trim() : "";
    rows.push([curDoc, curDate, account, desc, debit || "0", credit || "0"]);
  }

  if (!rows.length) return null;
  return { headers: JE_FLAT_HEADERS.slice(), rows, entryCount };
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
