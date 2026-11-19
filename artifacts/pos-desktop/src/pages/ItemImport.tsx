// استيراد الأصناف من Excel / PDF / صورة (OCR) / لصق يدوي. القراءة الضوئية للصور
// هجينة: عند الاتصال تُقرأ عبر السحابة (Gemini vision، دقّة أعلى) وبدون إنترنت
// تُقرأ محليًا بالكامل عبر tesseract.js (ملفات مضمّنة داخل التطبيق، بدون شبكة).
// يطابق كل سطر مع الأصناف الموجودة (كود ← باركود ← اسم)، يحدّث الأسعار تلقائيًا
// للأصناف الموجودة، يضيف الجديد مرّة واحدة بدون تكرار، ويربط القائمة كلها بعلامة
// تجارية واحدة (كل علامة بسعرها / باركودها الخاص على نفس الصنف).

import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import * as pdfjsLib from "pdfjs-dist";
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker";
import { listItems, type LocalItem } from "../lib/items";
import { listBrands, createBrand, type Brand } from "../lib/brands";
import { emitData, useDataRefresh } from "../lib/dataBus";
import {
  IMPORT_FIELDS, guessMapping, parseRows, buildPlan, applyPlan,
  resolveImportUomId,
  type ColMapping, type ImportField, type ParsedRow, type RowPlan, type PlanSummary, type ApplyResult,
} from "../lib/importItems";
import { currencySymbol } from "../lib/currency";
import { imageToGridOffline } from "../lib/imageOcr";
import {
  extractPdfCatalogPage,
  extractPdfCatalogFromGrid,
  hasUnparsedCatalogCodes,
  gridDetectPdfCatalogBrand,
  pdfCatalogItemsToGrid,
  type PdfCatalogItem,
  type PdfCatalogTextRun,
} from "../lib/pdfCatalogImport";
import {
  describePdfReadError,
  NoPdfTextLayerError,
  openLocalPdf,
} from "../lib/localPdfFile";
import { createApi } from "../lib/api";
import { loadDeviceToken } from "../lib/tauri-shim";
import { IS_TAURI } from "../lib/localStore";
import { localizeStaticUiText } from "../lib/appSettings";

// Instantiate the pdf.js worker via Vite's `?worker` bundling (a real Worker
// assigned to workerPort) instead of a `?url` string handed to workerSrc. The
// URL form fails to load inside the Tauri webview (module-worker fetch under the
// custom app protocol), which surfaced as a generic "تعذّرت قراءة الملف" — a
// bundled Worker instance loads reliably in both the browser preview and Tauri.
pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker();

// ─── source parsers ─────────────────────────────────────────────────────

async function excelToGrid(buf: ArrayBuffer): Promise<string[][]> {
  const wb = XLSX.read(buf, { type: "array" });
  const first = wb.SheetNames[0];
  if (!first) return [];
  const ws = wb.Sheets[first];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "" });
  return aoa.map((row) => (Array.isArray(row) ? row.map((c) => (c == null ? "" : String(c).trim())) : []));
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface PdfReadResult {
  grid: string[][];
  brandDetected: string | null;
  parsedCatalogRows: number;
  pagesWithUnparsedCodes: number;
  pages: number;
}

/** Convert one page's positioned text to a compact generic grid. */
function pageRunsToGrid(runs: PdfCatalogTextRun[]): string[][] {
  if (!runs.length) return [];
  const xs = [...new Set(runs.map((run) => Math.round(run.x)))].sort((a, b) => a - b);
  const colStarts: number[] = [];
  for (const x of xs) {
    if (!colStarts.length || x - colStarts[colStarts.length - 1] > 18) colStarts.push(x);
  }
  const colOf = (x: number) => {
    let best = 0, bestDistance = Infinity;
    for (let i = 0; i < colStarts.length; i++) {
      const distance = Math.abs(x - colStarts[i]);
      if (distance < bestDistance) { bestDistance = distance; best = i; }
    }
    return best;
  };
  const sorted = [...runs].sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const grid: string[][] = [];
  let currentY = Infinity;
  let cells: string[] = [];
  const flush = () => {
    if (cells.some((cell) => cell.trim())) grid.push(cells.map((cell) => cell.trim()));
    cells = [];
  };
  for (const run of sorted) {
    if (Math.abs(run.y - currentY) > 4) {
      flush();
      currentY = run.y;
      cells = new Array(colStarts.length).fill("");
    }
    const column = colOf(run.x);
    cells[column] = cells[column] ? `${cells[column]} ${run.str}` : run.str;
  }
  flush();
  return grid;
}

/**
 * Parse one page at a time. The application retains only import rows and the
 * compact fallback grid, not thousands of positioned text-run objects. PDF.js
 * requests local-file byte ranges instead of loading the complete PDF at once.
 */
async function pdfToGrid(
  file: File,
  onPage: (done: number, total: number) => void,
  onBytes: (loaded: number, total: number) => void,
): Promise<PdfReadResult> {
  const { document: doc, transport } = await openLocalPdf(file, file.name, onBytes);
  const genericGrid: string[][] = [];
  const catalogItems: PdfCatalogItem[] = [];
  let previousTitle: string | undefined;
  let brandDetected: string | null = null;
  let pagesWithUnparsedCodes = 0;
  let textRunCount = 0;
  let catalogFormatFound = false;
  const pageCount = doc.numPages;
  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const runs: PdfCatalogTextRun[] = [];
      for (const item of content.items as Array<{ str?: string; transform: number[]; width?: number }>) {
        const str = (item.str ?? "").trim();
        if (!str) continue;
        runs.push({ str, x: item.transform[4], y: item.transform[5], width: item.width });
      }
      textRunCount += runs.length;
      const pageResult = extractPdfCatalogPage(runs, previousTitle);
      previousTitle = pageResult.productTitle ?? previousTitle;
      brandDetected ??= pageResult.detectedBrand;
      if (pageResult.items.length && !catalogFormatFound) {
        catalogFormatFound = true;
        genericGrid.length = 0;
      }
      for (const item of pageResult.items) catalogItems.push(item);
      if (hasUnparsedCatalogCodes(runs.map((run) => run.str), pageResult.items)) pagesWithUnparsedCodes++;
      if (!catalogFormatFound) {
        for (const row of pageRunsToGrid(runs)) genericGrid.push(row);
      }
      await page.cleanup();
      onPage(pageNumber, pageCount);
    }
    if (!textRunCount) throw new NoPdfTextLayerError();
    return {
      grid: catalogItems.length ? pdfCatalogItemsToGrid(catalogItems) : genericGrid,
      brandDetected,
      parsedCatalogRows: catalogItems.length,
      pagesWithUnparsedCodes,
      pages: pageCount,
    };
  } catch (error) {
    throw transport.failureReason ?? error;
  } finally {
    await doc.destroy();
  }
}

function pasteToGrid(text: string): string[][] {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim().length);
  return lines.map((line) => {
    if (line.includes("\t")) return line.split("\t").map((c) => c.trim());
    if (line.includes(",")) return line.split(",").map((c) => c.trim());
    return line.split(/\s{2,}/).map((c) => c.trim());
  });
}

// Encode a blob as RAW base64 (no data: URI — the prod edge WAF 403s data:
// base64 URIs; we send base64 + mime as separate fields to /api/ocr/extract).
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

// OCR scanned PDFs sequentially; never keep rendered page images in an array.
async function scanPdfPages(
  file: File,
  onPage: (page: number, total: number, blob: Blob) => Promise<void>,
  onBytes: (loaded: number, total: number) => void,
): Promise<void> {
  const { document: doc, transport } = await openLocalPdf(file, file.name, onBytes);
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error(`تعذّر تجهيز الصفحة ${pageNumber} للتعرّف الضوئي.`);
      await page.render({ canvas, canvasContext: ctx, viewport } as any).promise;
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((value) => resolve(value), "image/png"));
      canvas.width = 0;
      canvas.height = 0;
      if (blob) await onPage(pageNumber, doc.numPages, blob);
      await page.cleanup();
    }
  } catch (error) {
    throw transport.failureReason ?? error;
  } finally {
    await doc.destroy();
  }
}

// ─── component ──────────────────────────────────────────────────────────

type Step = "source" | "map" | "preview" | "done";
type SourceKind = "excel" | "pdf" | "image" | "paste";

export default function ItemImport() {
  const [step, setStep] = useState<Step>("source");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const sym = currencySymbol();

  const [grid, setGrid] = useState<string[][]>([]);
  const [hasHeader, setHasHeader] = useState(true);
  const [mapping, setMapping] = useState<ColMapping>({});
  const [updatePrices, setUpdatePrices] = useState(true);

  const [existing, setExisting] = useState<LocalItem[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [brandMode, setBrandMode] = useState<"none" | "existing" | "new">("none");
  const [brandId, setBrandId] = useState<number | "">("");
  const [newBrandName, setNewBrandName] = useState("");
  const [brandAutoSelected, setBrandAutoSelected] = useState(false);
  const [autoDetectedBrandName, setAutoDetectedBrandName] = useState<string | null>(null);

  const [pasteText, setPasteText] = useState("");
  const [sourceKind, setSourceKind] = useState<SourceKind>("excel");
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [progressLabel, setProgressLabel] = useState("");
  const [pdfWarning, setPdfWarning] = useState<string | null>(null);
  const [ocrNote, setOcrNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function reloadRefs() {
    setExisting(await listItems());
    setBrands(listBrands());
  }
  useEffect(() => { void reloadRefs(); }, []);
  useDataRefresh(["items", "brands"], () => { void reloadRefs(); });

  const ncols = useMemo(() => grid.reduce((m, r) => Math.max(m, r.length), 0), [grid]);

  function afterParse(g: string[][]) {
    if (!g.length) { setErr("الملف/النص لا يحتوي على بيانات."); return; }
    setGrid(g);
    setMapping(guessMapping(g[0] ?? []));
    setHasHeader(true);
    setErr(null);
    setStep("map");
  }

  function preselectPdfBrand(brandName: string) {
    const localBrands = listBrands();
    setBrands(localBrands);
    const targetName = brandName.trim().toLowerCase().replace(/\s+/g, " ");
    const existingBrand = localBrands.find((brand) =>
      [brand.nameAr, brand.nameEn ?? ""].some((name) =>
        name.trim().toLowerCase().replace(/\s+/g, " ") === targetName,
      ),
    );
    setBrandAutoSelected(true);
    setAutoDetectedBrandName(brandName);
    if (existingBrand) {
      setBrandMode("existing");
      setBrandId(existingBrand.id);
      setNewBrandName("");
    } else {
      setBrandMode("new");
      setBrandId("");
      setNewBrandName(brandName);
    }
  }

  // Hybrid OCR: prefer the cloud (Gemini vision, higher accuracy) when online
  // with a device token; otherwise fall back to fully-offline tesseract.js.
  // Standalone mode has no device token → always offline. See imageOcr.ts.
  async function ocrBlobHybrid(blob: Blob, pageProgress?: { page: number; total: number }): Promise<string[][]> {
    const dt = IS_TAURI ? await loadDeviceToken() : null;
    const canCloud = typeof navigator !== "undefined" && navigator.onLine && !!dt;
    if (canCloud) {
      try {
        const base64 = await blobToBase64(blob);
        const baseUrl = localStorage.getItem("pos_desktop_server_url") ?? "https://zacoderp.com";
        const api = createApi({ baseUrl, deviceToken: dt, timeoutMs: 60_000 });
        const res = await api.ocrExtract(base64, blob.type || "image/png");
        if (res.ok && res.rows && res.rows.length) {
          setOcrNote("تمت القراءة عبر السحابة (دقّة عالية).");
          return res.rows;
        }
        throw new Error(res.error || "cloud ocr empty");
      } catch {
        const g = await imageToGridOffline(blob, (pct) => {
          setProgress(pageProgress ? { done: pageProgress.page, total: pageProgress.total } : { done: pct, total: 100 });
          setProgressLabel(pageProgress
            ? `جارٍ التعرّف الضوئي على الصفحة ${pageProgress.page} من ${pageProgress.total} (${pct}٪)`
            : `جارٍ قراءة الصورة… ${pct}٪`);
        });
        setOcrNote("تعذّرت القراءة السحابية — تمت القراءة دون اتصال.");
        return g;
      }
    }
    const g = await imageToGridOffline(blob, (pct) => {
      setProgress(pageProgress ? { done: pageProgress.page, total: pageProgress.total } : { done: pct, total: 100 });
      setProgressLabel(pageProgress
        ? `جارٍ التعرّف الضوئي على الصفحة ${pageProgress.page} من ${pageProgress.total} (${pct}٪)`
        : `جارٍ قراءة الصورة… ${pct}٪`);
    });
    setOcrNote("تمت القراءة دون اتصال (وضع محلي).");
    return g;
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true); setErr(null); setOcrNote(null); setPdfWarning(null); setProgress(null); setProgressLabel("");
    let fileReadFailed = false;
    try {
      if (sourceKind === "image") {
        afterParse(await ocrBlobHybrid(file));
      } else if (sourceKind === "pdf") {
        setProgressLabel("جارٍ فتح ملف PDF وتجهيزه للقراءة");
        setBrandAutoSelected(false);
        setAutoDetectedBrandName(null);
        setBrandMode("none");
        setBrandId("");
        setNewBrandName("");
        let pdfResult: PdfReadResult;
        try {
          pdfResult = await pdfToGrid(file, (done, total) => {
            setProgress({ done, total });
            setProgressLabel(`جارٍ قراءة صفحات PDF: ${done} من ${total}`);
          }, (loaded, total) => {
            setProgressLabel(`جارٍ تحميل أجزاء PDF: ${formatFileSize(loaded)} من ${formatFileSize(total)}`);
          });
        } catch (pdfError) {
          if (!(pdfError instanceof NoPdfTextLayerError)) throw pdfError;
          const scannedPages: string[][] = [];
          const scannedCatalogItems: PdfCatalogItem[] = [];
          let scannedCatalogFormatFound = false;
          let scannedPagesWithUnparsedCodes = 0;
          let scannedBrandDetected: string | null = null;
          await scanPdfPages(file, async (page, total, blob) => {
            setProgress({ done: page, total });
            setProgressLabel(`جارٍ تجهيز الصفحة ${page} من ${total} للتعرّف الضوئي`);
            const pageGrid = await ocrBlobHybrid(blob, { page, total });
            const pageResult = extractPdfCatalogFromGrid(pageGrid);
            scannedBrandDetected ??= pageResult.detectedBrand ?? gridDetectPdfCatalogBrand(pageGrid);
            if (hasUnparsedCatalogCodes(pageGrid.flat(), pageResult.items)) scannedPagesWithUnparsedCodes++;
            if (pageResult.items.length && !scannedCatalogFormatFound) {
              scannedCatalogFormatFound = true;
              scannedPages.length = 0;
            }
            for (const item of pageResult.items) scannedCatalogItems.push(item);
            if (!pageResult.items.length) {
              if (!scannedCatalogFormatFound) for (const row of pageGrid) scannedPages.push(row);
            }
            setProgress({ done: page, total });
            setProgressLabel(`اكتملت قراءة الصفحة ${page} من ${total}`);
          }, (loaded, total) => {
            setProgressLabel(`جارٍ تحميل أجزاء PDF الممسوح: ${formatFileSize(loaded)} من ${formatFileSize(total)}`);
          });
          if (!scannedPages.length && !scannedCatalogItems.length) throw pdfError;
          pdfResult = {
            grid: scannedCatalogItems.length ? pdfCatalogItemsToGrid(scannedCatalogItems) : scannedPages,
            brandDetected: scannedBrandDetected,
            parsedCatalogRows: scannedCatalogItems.length,
            pagesWithUnparsedCodes: scannedPagesWithUnparsedCodes,
            pages: 0,
          };
          setOcrNote("تمت قراءة صفحات PDF الممسوحة بالتعرّف الضوئي.");
        }
        if (pdfResult.brandDetected) preselectPdfBrand(pdfResult.brandDetected);
        afterParse(pdfResult.grid);
        if (pdfResult.parsedCatalogRows) {
          setOcrNote(`تم استخراج ${pdfResult.parsedCatalogRows} صفًا من جدول الأصناف. راجع المعاينة قبل الحفظ.`);
        }
        if (pdfResult.pagesWithUnparsedCodes) {
          setPdfWarning(`تعذّر ربط بعض الصفحات التي تحتوي على أكواد تلقائيًا (${pdfResult.pagesWithUnparsedCodes} صفحة). راجع الأعمدة والمعاينة قبل الاستيراد.`);
        }
        if (!pdfResult.parsedCatalogRows && pdfResult.brandDetected) {
          setOcrNote((current) => current || `تم تحديد ${pdfResult.brandDetected ?? "العلامة"} كعلامة تجارية لهذه الدفعة.`);
        }
      } else {
        const buf = await file.arrayBuffer();
        afterParse(await excelToGrid(buf));
      }
    } catch (ex) {
      fileReadFailed = true;
      const detail = describePdfReadError(ex);
      setErr(`تعذّرت قراءة «${file.name}» (${formatFileSize(file.size)}): ${detail}`);
      console.error("[ItemImport] file read failed:", ex);
    } finally {
      setBusy(false);
      setProgress(null);
      setProgressLabel("");
      // Keep the chosen filename visible after failure. Clear it only after
      // success; clicking the input clears it so the same file can be retried.
      if (!fileReadFailed && fileRef.current) fileRef.current.value = "";
    }
  }

  function onPaste() {
    const g = pasteToGrid(pasteText);
    afterParse(g);
  }

  const parsedRows: ParsedRow[] = useMemo(
    () => (grid.length ? parseRows(grid, mapping, hasHeader) : []),
    [grid, mapping, hasHeader],
  );

  const summary: PlanSummary | null = useMemo(() => {
    if (!parsedRows.length) return null;
    return buildPlan(parsedRows, existing, { updatePrices });
  }, [parsedRows, existing, updatePrices]);
  const selectedBrand = brandMode === "existing" ? brands.find((brand) => brand.id === Number(brandId)) : null;
  const isAutoDetectedBrandSelected = brandAutoSelected && !!autoDetectedBrandName && (
    brandMode === "new"
      ? newBrandName.trim().toLowerCase().replace(/\s+/g, " ") === autoDetectedBrandName.trim().toLowerCase().replace(/\s+/g, " ")
      : brandMode === "existing"
        ? [selectedBrand?.nameAr ?? "", selectedBrand?.nameEn ?? ""].some((name) =>
          name.trim().toLowerCase().replace(/\s+/g, " ") === autoDetectedBrandName.trim().toLowerCase().replace(/\s+/g, " "),
        )
        : false
  );

  function resetAll() {
    setStep("source"); setGrid([]); setMapping({}); setPasteText("");
    setResult(null); setProgress(null); setErr(null);
    setBrandMode("none"); setBrandId(""); setNewBrandName("");
    setBrandAutoSelected(false); setAutoDetectedBrandName(null); setPdfWarning(null); setProgressLabel("");
  }

  async function runImport() {
    if (!summary) return;
    setBusy(true); setErr(null); setProgress({ done: 0, total: summary.plans.length });
    setProgressLabel("جارٍ التحقق من البيانات قبل الحفظ");
    try {
      const missingUnit = summary.plans.find((plan) =>
        plan.kind === "new" && resolveImportUomId(plan.row.uomName) == null,
      );
      if (missingUnit) {
        const label = missingUnit.row.uomName || "الوحدة الافتراضية";
        throw new Error(`وحدة القياس «${label}» غير موجودة في إعدادات الوحدات. أضفها أولًا ثم أعد الاستيراد.`);
      }

      let useBrandId: number | null = null;
      if (brandMode === "existing" && brandId !== "") useBrandId = Number(brandId);
      if (brandMode === "new") {
        const name = newBrandName.trim();
        if (!name) throw new Error("اكتب اسم العلامة التجارية الجديدة.");
        const duplicate = listBrands().find((brand) =>
          [brand.nameAr, brand.nameEn ?? ""].some((label) => label.trim().toLowerCase() === name.toLowerCase()),
        );
        useBrandId = duplicate?.id ?? createBrand({ nameAr: name }).id;
      }
      setProgressLabel("جارٍ حفظ الأصناف وربط العلامة التجارية");
      const res = await applyPlan(summary.plans, {
        brandId: useBrandId,
        onProgress: (done, total) => {
          setProgress({ done, total });
          setProgressLabel(`جارٍ حفظ الأصناف: ${done} من ${total}`);
        },
      });
      setResult(res);
      setStep("done");
      emitData("items", "brands");
      await reloadRefs();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "فشل الاستيراد.");
    } finally {
      setBusy(false);
      setProgress(null);
      setProgressLabel("");
    }
  }

  // ── render ──
  return (
    <div style={S.wrap}>
      <div style={S.headerRow}>
        <div>
          <h2 style={S.h2}>استيراد الأصناف من ملف</h2>
          <div style={S.sub}>Excel أو PDF نصّي أو لصق يدوي — تحديث الأسعار تلقائيًا للأصناف الموجودة وإضافة الجديد بدون تكرار، مع ربط القائمة بعلامة تجارية.</div>
        </div>
        {step !== "source" && (
          <button style={S.btnGhost} onClick={resetAll} disabled={busy}>↺ البدء من جديد</button>
        )}
      </div>

      {/* step indicator */}
      <div style={S.steps}>
        {(["source", "map", "preview", "done"] as Step[]).map((s, i) => (
          <div key={s} style={{ ...S.stepChip, ...(step === s ? S.stepChipActive : {}) }}>
            {i + 1}. {STEP_LABELS[s]}
          </div>
        ))}
      </div>

      {err && <div style={S.err}>{err}</div>}
      {ocrNote && !err && <div style={S.hint}>{ocrNote}</div>}
      {pdfWarning && <div style={S.warn} role="status" data-testid="warning-pdf-pages">{pdfWarning}</div>}

      {step === "source" && (
        <div style={S.card}>
          <div style={S.tabs}>
            {(["excel", "pdf", "image", "paste"] as SourceKind[]).map((k) => (
              <button key={k} style={{ ...S.tab, ...(sourceKind === k ? S.tabActive : {}) }} onClick={() => {
                setSourceKind(k); setErr(null); setOcrNote(null); setPdfWarning(null);
                if (k !== "pdf" && brandAutoSelected) {
                  setBrandAutoSelected(false); setAutoDetectedBrandName(null); setBrandMode("none"); setBrandId(""); setNewBrandName("");
                }
              }}>
                {SOURCE_LABELS[k]}
              </button>
            ))}
          </div>

          {sourceKind !== "paste" ? (
            <div style={{ padding: "18px 4px" }}>
              <p style={S.hint}>
                {sourceKind === "excel"
                  ? "اختر ملف Excel (‎.xlsx / .xls / .csv). أول صف يُفترض أنه العناوين."
                  : sourceKind === "pdf"
                  ? "اختر ملف PDF. لو كان نصّيًا يُستخرج الجدول مباشرة؛ ولو كان صورة ممسوحة يُقرأ بالتعرّف الضوئي (OCR) تلقائيًا."
                  : "اختر صورة لقائمة الأسعار (JPG / PNG / WebP). تُقرأ عبر السحابة عند الاتصال (دقّة أعلى) أو محليًا بدون إنترنت."}
              </p>
              <input
                ref={fileRef}
                type="file"
                accept={sourceKind === "excel" ? ".xlsx,.xls,.csv" : sourceKind === "pdf" ? ".pdf" : "image/png,image/jpeg,image/webp,image/*"}
                onChange={onFile}
                onClick={(event) => { event.currentTarget.value = ""; setErr(null); }}
                disabled={busy}
                style={S.file}
                data-testid="input-item-import-file"
              />
              {busy && (
                <div style={S.hint} role="status" data-testid="status-item-import-progress">
                  {progressLabel || "جارٍ القراءة…"}
                  {progress && progress.total > 1 && (
                    <progress max={progress.total} value={progress.done} style={{ display: "block", width: "100%", marginTop: 8 }} />
                  )}
                </div>
              )}
            </div>
          ) : (
            <div style={{ padding: "12px 4px" }}>
              <p style={S.hint}>الصق البيانات هنا (كل صنف في سطر، الأعمدة مفصولة بـ Tab أو فاصلة). أول سطر يُفترض أنه العناوين.</p>
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                rows={10}
                style={S.textarea}
                placeholder={"الاسم\tالكود\tالباركود\tالسعر\nقلم أزرق\tP-001\t6221234567890\t5.50"}
              />
              <div style={S.btnRow}>
                <button style={S.btnPrimary} disabled={!pasteText.trim()} onClick={onPaste}>متابعة ←</button>
              </div>
            </div>
          )}
        </div>
      )}

      {step === "map" && (
        <div style={S.card}>
          <div style={S.mapTop}>
            <label style={S.check}>
              <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
              الصف الأول عناوين (تجاهله كبيانات)
            </label>
            <span style={S.hint}>عدد الأعمدة: {ncols} — عدد الصفوف: {grid.length}{hasHeader ? " (منها صف عناوين)" : ""}</span>
          </div>

          <div style={S.mapGrid}>
            {IMPORT_FIELDS.map((f) => (
              <div key={f.key} style={S.mapCell}>
                <label style={S.mapLabel}>{f.label}{f.key === "nameAr" ? " *" : ""}</label>
                <select
                  value={mapping[f.key] ?? -1}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setMapping((m) => {
                      const next = { ...m };
                      // clear any other field pointing at this column (one col → one field)
                      if (v >= 0) for (const k of Object.keys(next) as ImportField[]) if (next[k] === v) delete next[k];
                      if (v < 0) delete next[f.key]; else next[f.key] = v;
                      return next;
                    });
                  }}
                  style={S.select}
                >
                  <option value={-1}>— بدون —</option>
                  {Array.from({ length: ncols }).map((_, c) => (
                    <option key={c} value={c}>{colLabel(grid, hasHeader, c)}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          {/* raw preview */}
          <div style={S.previewScroll}>
            <table style={S.table}>
              <thead>
                <tr>{Array.from({ length: ncols }).map((_, c) => <th key={c} style={S.th}>{colLabel(grid, hasHeader, c)}</th>)}</tr>
              </thead>
              <tbody>
                {grid.slice(hasHeader ? 1 : 0, (hasHeader ? 1 : 0) + 5).map((row, ri) => (
                  <tr key={ri}>{Array.from({ length: ncols }).map((_, c) => <td key={c} style={S.td}>{row[c] ?? ""}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={S.btnRow}>
            <button style={S.btnGhost} onClick={() => setStep("source")}>→ رجوع</button>
            <button
              style={S.btnPrimary}
              disabled={mapping.nameAr == null && mapping.code == null && mapping.barcode == null}
              onClick={() => { setErr(null); setStep("preview"); }}
            >
              معاينة النتائج ←
            </button>
          </div>
          {mapping.nameAr == null && mapping.code == null && mapping.barcode == null && (
            <div style={S.warn}>حدّد على الأقل عمود «اسم الصنف» أو «الكود» أو «الباركود».</div>
          )}
        </div>
      )}

      {step === "preview" && summary && (
        <div style={S.card}>
          <div style={S.countRow}>
            <Stat label="أصناف جديدة" value={summary.counts.new} tone="new" />
            <Stat label="تحديث سعر" value={summary.counts.priceUpdate} tone="upd" />
            <Stat label="بدون تغيير" value={summary.counts.unchanged} tone="same" />
            <Stat label="متجاهَل" value={summary.counts.invalid} tone="bad" />
          </div>

          <div style={S.optRow}>
            <label style={S.check}>
              <input type="checkbox" checked={updatePrices} onChange={(e) => setUpdatePrices(e.target.checked)} />
              تحديث أسعار الأصناف الموجودة تلقائيًا
            </label>
          </div>

          {/* brand tagging */}
          <div style={S.brandBox}>
            <div style={S.brandTitle}>🏷️ ربط القائمة بعلامة تجارية</div>
            {isAutoDetectedBrandSelected && autoDetectedBrandName && (
              <div style={S.hint} data-testid="text-import-brand">
                تم تحديد العلامة التجارية {autoDetectedBrandName} تلقائيًا من ملف PDF. يمكنك تغييرها قبل الحفظ.
              </div>
            )}
            <div style={S.brandModes}>
              {([["none", "بدون علامة"], ["existing", "علامة موجودة"], ["new", "علامة جديدة"]] as const).map(([m, lbl]) => (
                <label key={m} style={S.radio}>
                  <input type="radio" name="brandmode" checked={brandMode === m} onChange={() => setBrandMode(m)} />
                  {localizeStaticUiText(lbl)}
                </label>
              ))}
            </div>
            {brandMode === "existing" && (
              <select value={brandId} onChange={(e) => setBrandId(e.target.value === "" ? "" : Number(e.target.value))} style={S.select}>
                <option value="">— اختر علامة —</option>
                {brands.map((b) => <option key={b.id} value={b.id}>{b.nameAr}{b.code ? ` (${b.code})` : ""}</option>)}
              </select>
            )}
            {brandMode === "new" && (
              <input value={newBrandName} onChange={(e) => setNewBrandName(e.target.value)} placeholder="اسم العلامة التجارية الجديدة" style={S.input} />
            )}
            {brandMode !== "none" && (
              <div style={S.hint}>كل صنف في القائمة سيُربط بهذه العلامة، محمّلاً سعرها/باركودها/تكلفتها من نفس السطر. الصنف الواحد يمكن أن يحمل عدة علامات.</div>
            )}
          </div>

          {/* row preview */}
          <div style={S.previewScroll}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>الحالة</th>
                  <th style={S.th}>الاسم</th>
                  <th style={S.th}>الكود</th>
                  <th style={S.th}>الباركود</th>
                  <th style={S.th}>وحدة القياس</th>
                  <th style={S.th}>السعر الحالي</th>
                  <th style={S.th}>السعر الجديد</th>
                </tr>
              </thead>
              <tbody>
                {summary.plans.slice(0, 200).map((p, i) => <PlanRow key={i} p={p} sym={sym} />)}
              </tbody>
            </table>
            {summary.plans.length > 200 && <div style={S.hint}>يتم عرض أول 200 سطر فقط؛ الاستيراد يشمل كل الأسطر ({summary.plans.length}).</div>}
          </div>

          {progress && (
            <div style={S.progressWrap}>
              <div style={{ ...S.progressBar, width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} />
              <span style={S.progressTxt}>{progress.done} / {progress.total}</span>
            </div>
          )}

          <div style={S.btnRow}>
            <button style={S.btnGhost} onClick={() => setStep("map")} disabled={busy}>→ رجوع</button>
            <button
              style={S.btnPrimary}
              disabled={busy || (summary.counts.new + summary.counts.priceUpdate === 0 && brandMode === "none")}
              onClick={runImport}
            >
              {busy ? "جارٍ الاستيراد…" : "تنفيذ الاستيراد ←"}
            </button>
          </div>
        </div>
      )}

      {step === "done" && result && (
        <div style={S.card}>
          <div style={S.doneTitle}>✅ تم الاستيراد بنجاح</div>
          <div style={S.countRow}>
            <Stat label="أصناف مضافة" value={result.inserted} tone="new" />
            <Stat label="أسعار مُحدَّثة" value={result.priceUpdated} tone="upd" />
            <Stat label="روابط علامات" value={result.brandLinked} tone="brand" />
            <Stat label="متجاهَل" value={result.skipped} tone="bad" />
          </div>
          <div style={S.btnRow}>
            <button style={S.btnPrimary} onClick={resetAll}>استيراد قائمة أخرى</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── small helpers ──────────────────────────────────────────────────────

function colLabel(grid: string[][], hasHeader: boolean, c: number): string {
  const head = hasHeader ? (grid[0]?.[c] ?? "").trim() : "";
  const letter = `عمود ${c + 1}`;
  return head ? `${head} — ${letter}` : letter;
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "new" | "upd" | "same" | "bad" | "brand" }) {
  return (
    <div style={{ ...S.stat, ...STAT_TONE[tone] }}>
      <div style={S.statVal}>{value}</div>
      <div style={S.statLbl}>{label}</div>
    </div>
  );
}

function PlanRow({ p, sym }: { p: RowPlan; sym: string }) {
  const badge = KIND_BADGE[p.kind];
  return (
    <tr>
      <td style={S.td}><span style={{ ...S.badge, ...badge.style }}>{badge.label}</span>{p.matchedBy ? <span style={S.matchedBy}> ({MATCH_LABEL[p.matchedBy]})</span> : null}</td>
      <td style={S.td}>{p.row.nameAr || <span style={S.muted}>—</span>}</td>
      <td style={S.tdMono}>{p.row.code || (p.kind === "new" ? "تلقائي عند الحفظ" : "—")}</td>
      <td style={S.tdMono}>{p.row.barcode || "—"}</td>
      <td style={S.td} data-testid={`text-import-uom-${p.row.rowIndex}`}>{p.row.uomName || "—"}</td>
      <td style={S.tdNum}>{p.oldPrice != null ? `${p.oldPrice.toFixed(2)} ${sym}` : "—"}</td>
      <td style={S.tdNum}>{p.newPrice != null ? `${p.newPrice.toFixed(2)} ${sym}` : "—"}</td>
    </tr>
  );
}

const STEP_LABELS: Record<Step, string> = { source: "المصدر", map: "ربط الأعمدة", preview: "المعاينة", done: "تم" };
const SOURCE_LABELS: Record<SourceKind, string> = { excel: "📊 ملف Excel", pdf: "📄 ملف PDF", image: "📷 صورة (OCR)", paste: "📋 لصق يدوي" };
const MATCH_LABEL: Record<"code" | "barcode" | "name", string> = { code: "بالكود", barcode: "بالباركود", name: "بالاسم" };
const KIND_BADGE: Record<RowPlan["kind"], { label: string; style: React.CSSProperties }> = {
  new: { label: "جديد", style: { background: "#dcfce7", color: "#166534" } },
  price_update: { label: "تحديث سعر", style: { background: "#fef9c3", color: "#854d0e" } },
  unchanged: { label: "بدون تغيير", style: { background: "#f1f5f9", color: "#475569" } },
  invalid: { label: "متجاهَل", style: { background: "#fee2e2", color: "#991b1b" } },
};
const STAT_TONE: Record<string, React.CSSProperties> = {
  new: { borderColor: "#bbf7d0", background: "#f0fdf4" },
  upd: { borderColor: "#fde68a", background: "#fffbeb" },
  same: { borderColor: "#e2e8f0", background: "#f8fafc" },
  bad: { borderColor: "#fecaca", background: "#fef2f2" },
  brand: { borderColor: "#ddd6fe", background: "#f5f3ff" },
};

const S = {
  wrap: { width: "100%", maxWidth: "none", minWidth: 0, boxSizing: "border-box" } as React.CSSProperties,
  headerRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 16 } as React.CSSProperties,
  h2: { margin: 0, fontSize: 22, color: "#0f172a" } as React.CSSProperties,
  sub: { fontSize: 13, color: "#64748b", marginTop: 4, maxWidth: 620, lineHeight: 1.6 } as React.CSSProperties,
  steps: { display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" } as React.CSSProperties,
  stepChip: { padding: "6px 12px", background: "#f1f5f9", color: "#64748b", borderRadius: 999, fontSize: 13, fontWeight: 600 } as React.CSSProperties,
  stepChipActive: { background: "#2563eb", color: "#fff" } as React.CSSProperties,
  card: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 20 } as React.CSSProperties,
  tabs: { display: "flex", gap: 8, borderBottom: "1px solid #e2e8f0", paddingBottom: 12 } as React.CSSProperties,
  tab: { padding: "9px 16px", background: "#f8fafc", color: "#475569", border: "1px solid #e2e8f0", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600, fontFamily: "inherit" } as React.CSSProperties,
  tabActive: { background: "#eff6ff", color: "#1d4ed8", borderColor: "#bfdbfe" } as React.CSSProperties,
  hint: { fontSize: 13, color: "#64748b", marginTop: 8, lineHeight: 1.6 } as React.CSSProperties,
  warn: { fontSize: 13, color: "#b45309", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: 10, marginTop: 10 } as React.CSSProperties,
  file: { display: "block", marginTop: 8, fontSize: 14 } as React.CSSProperties,
  textarea: { width: "100%", padding: 12, fontSize: 13, border: "1px solid #cbd5e1", borderRadius: 8, fontFamily: "ui-monospace, monospace", boxSizing: "border-box", marginTop: 8 } as React.CSSProperties,
  input: { width: "100%", padding: "10px 12px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 8, fontFamily: "inherit", boxSizing: "border-box", marginTop: 8 } as React.CSSProperties,
  select: { width: "100%", padding: "8px 10px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 8, fontFamily: "inherit", background: "#fff", boxSizing: "border-box" } as React.CSSProperties,
  mapTop: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" } as React.CSSProperties,
  check: { display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#334155", cursor: "pointer" } as React.CSSProperties,
  mapGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12, marginBottom: 16 } as React.CSSProperties,
  mapCell: {} as React.CSSProperties,
  mapLabel: { display: "block", fontSize: 13, color: "#475569", fontWeight: 600, marginBottom: 4 } as React.CSSProperties,
  previewScroll: { overflowX: "auto", border: "1px solid #e2e8f0", borderRadius: 8, marginBottom: 16 } as React.CSSProperties,
  table: { width: "100%", borderCollapse: "collapse", background: "#fff", fontSize: 13 } as React.CSSProperties,
  th: { textAlign: "right", padding: "10px 12px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontSize: 12, color: "#475569", fontWeight: 600, whiteSpace: "nowrap" } as React.CSSProperties,
  td: { padding: "8px 12px", borderBottom: "1px solid #f1f5f9", color: "#0f172a", whiteSpace: "nowrap" } as React.CSSProperties,
  tdMono: { padding: "8px 12px", borderBottom: "1px solid #f1f5f9", color: "#0f172a", fontFamily: "ui-monospace, monospace", fontSize: 12 } as React.CSSProperties,
  tdNum: { padding: "8px 12px", borderBottom: "1px solid #f1f5f9", color: "#0f172a", textAlign: "left", whiteSpace: "nowrap" } as React.CSSProperties,
  muted: { color: "#cbd5e1" } as React.CSSProperties,
  badge: { display: "inline-block", padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 700 } as React.CSSProperties,
  matchedBy: { fontSize: 11, color: "#94a3b8" } as React.CSSProperties,
  btnRow: { display: "flex", gap: 8, marginTop: 8, justifyContent: "flex-start" } as React.CSSProperties,
  btnPrimary: { padding: "10px 18px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600, fontFamily: "inherit" } as React.CSSProperties,
  btnGhost: { padding: "10px 18px", background: "#fff", color: "#475569", border: "1px solid #cbd5e1", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600, fontFamily: "inherit" } as React.CSSProperties,
  err: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: 12, borderRadius: 8, marginBottom: 14, fontSize: 13 } as React.CSSProperties,
  countRow: { display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" } as React.CSSProperties,
  stat: { flex: "1 1 120px", border: "1px solid", borderRadius: 10, padding: "12px 14px", textAlign: "center" } as React.CSSProperties,
  statVal: { fontSize: 26, fontWeight: 800, color: "#0f172a" } as React.CSSProperties,
  statLbl: { fontSize: 12, color: "#64748b", marginTop: 2 } as React.CSSProperties,
  optRow: { marginBottom: 14 } as React.CSSProperties,
  brandBox: { background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: 14, marginBottom: 16 } as React.CSSProperties,
  brandTitle: { fontSize: 14, fontWeight: 700, color: "#334155", marginBottom: 10 } as React.CSSProperties,
  brandModes: { display: "flex", gap: 16, marginBottom: 10, flexWrap: "wrap" } as React.CSSProperties,
  radio: { display: "flex", alignItems: "center", gap: 6, fontSize: 14, color: "#334155", cursor: "pointer" } as React.CSSProperties,
  progressWrap: { position: "relative", height: 26, background: "#f1f5f9", borderRadius: 8, overflow: "hidden", marginBottom: 14 } as React.CSSProperties,
  progressBar: { position: "absolute", insetInlineStart: 0, top: 0, bottom: 0, background: "#22c55e", transition: "width .1s" } as React.CSSProperties,
  progressTxt: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: "#0f172a" } as React.CSSProperties,
  doneTitle: { fontSize: 18, fontWeight: 700, color: "#166534", marginBottom: 16 } as React.CSSProperties,
};
