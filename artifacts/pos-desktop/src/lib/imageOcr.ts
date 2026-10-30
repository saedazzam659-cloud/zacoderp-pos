// ─────────────────────────────────────────────────────────────────────────
// Offline OCR engine (tesseract.js, Arabic + English) — the OFFLINE half of
// the item-import HYBRID OCR. Everything is bundled under public/tesseract
// (worker + LSTM wasm core + ara/eng traineddata), so recognition works with
// ZERO network. The online half (higher accuracy, Gemini vision) lives in the
// api-server route /api/ocr/extract and is preferred when the register is
// online (see ItemImport.tsx).
//
// tesseract returns recognised WORDS with pixel bounding boxes; we cluster them
// into a grid the same way the text-PDF importer clusters text runs: columns by
// x-start, rows by y-top. Tolerances are adaptive (scaled to the median word
// height) so the same code copes with any image resolution.
// ─────────────────────────────────────────────────────────────────────────

import { createWorker } from "tesseract.js";

// public/ assets are served from the app base (import.meta.env.BASE_URL ends
// with "/"). corePath points at the DIRECTORY so tesseract.js v7 auto-picks the
// SIMD-LSTM core when the CPU supports it, else the plain LSTM core.
const BASE = (import.meta.env.BASE_URL || "/").replace(/\/?$/, "/");
const T = (p: string) => `${BASE}tesseract/${p}`;

interface OcrWord { text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }

/**
 * Recognise an image blob (png/jpg/webp) fully offline and return a 2D grid.
 * @param onProgress optional 0..100 recognition progress.
 */
export async function imageToGridOffline(
  blob: Blob,
  onProgress?: (pct: number) => void,
): Promise<string[][]> {
  const worker = await createWorker(["ara", "eng"], 1, {
    workerPath: T("worker.min.js"),
    corePath: T(""),
    langPath: T("tessdata"),
    gzip: true,
    logger: onProgress
      ? (m: { status?: string; progress?: number }) => {
          if (m.status === "recognizing text" && typeof m.progress === "number") {
            onProgress(Math.round(m.progress * 100));
          }
        }
      : undefined,
  });
  try {
    const { data } = await worker.recognize(blob);
    const words = collectWords(data);
    const grid = wordsToGrid(words);
    if (!grid.length) {
      throw new Error("لم يتم التعرّف على نص في الصورة. جرّب صورة أوضح أو أعلى دقة.");
    }
    return grid;
  } finally {
    await worker.terminate();
  }
}

/** Pull words (with bbox) out of the tesseract result, tolerating shape drift. */
function collectWords(data: any): OcrWord[] {
  const out: OcrWord[] = [];
  const push = (w: any) => {
    const text = (w?.text ?? "").trim();
    const b = w?.bbox;
    if (text && b && typeof b.x0 === "number") out.push({ text, bbox: b });
  };
  if (Array.isArray(data?.words) && data.words.length) {
    for (const w of data.words) push(w);
    return out;
  }
  // Fallback: dig words out of lines/paragraphs/blocks.
  for (const block of data?.blocks ?? []) {
    for (const para of block?.paragraphs ?? []) {
      for (const line of para?.lines ?? []) {
        for (const w of line?.words ?? []) push(w);
      }
    }
  }
  return out;
}

/** Cluster words into rows (y-top) and columns (x-start) with adaptive gaps. */
function wordsToGrid(words: OcrWord[]): string[][] {
  if (!words.length) return [];

  // Median word height → adaptive tolerances (resolution-independent).
  const heights = words.map((w) => Math.max(1, w.bbox.y1 - w.bbox.y0)).sort((a, b) => a - b);
  const medH = heights[Math.floor(heights.length / 2)] || 12;
  const YTOL = medH * 0.6;   // same visual line if tops within 60% of a char height
  const XGAP = medH * 1.4;   // new column when x-start jumps > ~1.4 char heights

  // Column starts from clustered x-positions.
  const xs = [...new Set(words.map((w) => Math.round(w.bbox.x0)))].sort((a, b) => a - b);
  const colStarts: number[] = [];
  for (const x of xs) {
    if (!colStarts.length || x - colStarts[colStarts.length - 1] > XGAP) colStarts.push(x);
  }
  const colOf = (x: number): number => {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < colStarts.length; i++) {
      const d = Math.abs(x - colStarts[i]);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };

  // Rows: top-to-bottom (y ascending), then left-to-right within a row.
  words.sort((a, b) => (a.bbox.y0 - b.bbox.y0) || (a.bbox.x0 - b.bbox.x0));
  const grid: string[][] = [];
  let curY = -Infinity;
  let cells: string[] = [];
  const flush = () => {
    if (cells.some((c) => c && c.trim())) grid.push(cells.map((c) => (c ?? "").trim()));
    cells = [];
  };
  for (const w of words) {
    if (Math.abs(w.bbox.y0 - curY) > YTOL) {
      flush();
      curY = w.bbox.y0;
      cells = new Array(colStarts.length).fill("");
    }
    const c = colOf(w.bbox.x0);
    cells[c] = cells[c] ? `${cells[c]} ${w.text}` : w.text;
  }
  flush();
  return grid;
}
