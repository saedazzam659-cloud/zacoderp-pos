import { useRef, useState, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import {
  FileSpreadsheet, FolderOpen, Save, FilePlus2, Plus, Trash2, Columns3, FileUp, ChevronDown, ArrowLeftRight, Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { openFile, saveFile, printHtml, withExtension, extractPdfTable, flattenJournalEntries, type OpenedFile } from "./fileIo";

const XLSX_ACCEPT = {
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "application/vnd.ms-excel": [".xls"],
};
const CSV_ACCEPT = { "text/csv": [".csv"] };
const PDF_ACCEPT = { "application/pdf": [".pdf"] };
const TXT_ACCEPT = { "text/plain": [".txt"] };
const HTML_ACCEPT = { "text/html": [".html"] };
const JSON_ACCEPT = { "application/json": [".json"] };

interface SheetData {
  name: string;
  rows: string[][]; // array of arrays (header:1 layout)
}

const BLANK_COLS = 8;
const BLANK_ROWS = 20;

// Row virtualization: only the rows visible in the viewport are rendered as
// editable inputs. Without this, opening a large spreadsheet would mount tens
// of thousands of <input> elements at once and freeze the browser.
const ROW_H = 32; // fixed body-row height (px) used for the windowing math
const OVERSCAN = 8; // extra rows rendered above/below the viewport for smooth scroll

function blankSheet(name: string): SheetData {
  return {
    name,
    rows: Array.from({ length: BLANK_ROWS }, () => Array.from({ length: BLANK_COLS }, () => "")),
  };
}

// Normalise ragged AoA so every row has the same column count.
function rectify(rows: any[][]): string[][] {
  const width = rows.reduce((m, r) => Math.max(m, r.length), 1);
  return rows.map((r) => {
    const out: string[] = [];
    for (let c = 0; c < width; c++) out.push(r[c] == null ? "" : String(r[c]));
    return out;
  });
}

function colLabel(i: number): string {
  let s = "";
  i += 1;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

export default function ExcelEditor() {
  const { t, i18n } = useTranslation();
  const ar = i18n.language?.startsWith("ar") ?? true;
  const { toast } = useToast();

  const [sheets, setSheets] = useState<SheetData[]>([blankSheet(ar ? "ورقة 1" : "Sheet1")]);
  const [active, setActive] = useState(0);
  const [fileName, setFileName] = useState(ar ? "جدول جديد.xlsx" : "Untitled.xlsx");
  const [handle, setHandle] = useState<OpenedFile["handle"]>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  // Grid column direction: RTL puts column A on the right (natural for Arabic
  // documents like journal entries), LTR puts column A on the left.
  const [gridDir, setGridDir] = useState<"rtl" | "ltr">(ar ? "rtl" : "ltr");
  const [, navigate] = useLocation();
  const handleRef = useRef(handle);
  handleRef.current = handle;
  // Refs keep functional state updaters from reading stale `active`/`sheets`
  // closures under rapid tab switching + edits.
  const activeRef = useRef(active);
  activeRef.current = active;
  const sheetsRef = useRef(sheets);
  sheetsRef.current = sheets;

  // Virtualized-grid scroll state.
  const scrollRef = useRef<HTMLDivElement>(null);
  const theadRef = useRef<HTMLTableSectionElement>(null);
  const rowProbeRef = useRef<HTMLTableRowElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  const [headerH, setHeaderH] = useState(0);
  const [rowH, setRowH] = useState(ROW_H);
  const resetScroll = () => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setScrollTop(0);
  };

  const sheet = sheets[active] ?? sheets[0];

  const updateCell = (r: number, c: number, v: string) => {
    setSheets((prev) => {
      const idx = activeRef.current;
      const next = prev.slice();
      const s = { ...next[idx], rows: next[idx].rows.map((row) => row.slice()) };
      s.rows[r][c] = v;
      next[idx] = s;
      return next;
    });
    setDirty(true);
  };

  const mutateActive = (fn: (s: SheetData) => SheetData) => {
    setSheets((prev) => {
      const idx = activeRef.current;
      const next = prev.slice();
      next[idx] = fn({ ...next[idx], rows: next[idx].rows.map((row) => row.slice()) });
      return next;
    });
    setDirty(true);
  };

  const addRow = () => mutateActive((s) => ({ ...s, rows: [...s.rows, Array.from({ length: s.rows[0]?.length ?? BLANK_COLS }, () => "")] }));
  const removeRow = () => mutateActive((s) => (s.rows.length > 1 ? { ...s, rows: s.rows.slice(0, -1) } : s));
  const addCol = () => mutateActive((s) => ({ ...s, rows: s.rows.map((r) => [...r, ""]) }));
  const removeCol = () => mutateActive((s) => (s.rows[0]?.length > 1 ? { ...s, rows: s.rows.map((r) => r.slice(0, -1)) } : s));

  const addSheet = () => {
    let newIdx = 0;
    setSheets((prev) => {
      newIdx = prev.length;
      return [...prev, blankSheet(`${ar ? "ورقة" : "Sheet"}${prev.length + 1}`)];
    });
    setActive(newIdx);
    setDirty(true);
  };
  const removeSheet = () => {
    if (sheetsRef.current.length <= 1) return;
    const idx = activeRef.current;
    setSheets((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));
    setActive((a) => Math.max(0, a - 1));
    setDirty(true);
  };

  const handleNew = () => {
    if (dirty && !window.confirm(ar ? "تجاهل التغييرات غير المحفوظة؟" : "Discard unsaved changes?")) return;
    setSheets([blankSheet(ar ? "ورقة 1" : "Sheet1")]);
    setActive(0);
    setFileName(ar ? "جدول جديد.xlsx" : "Untitled.xlsx");
    setHandle(null);
    setDirty(false);
    resetScroll();
  };

  const handleOpen = async () => {
    try {
      const opened = await openFile({
        accept: { ...XLSX_ACCEPT, ...CSV_ACCEPT },
        description: ar ? "جداول Excel و CSV" : "Excel & CSV spreadsheets",
      });
      if (!opened) return;
      setBusy(true);
      // Yield once so the disabled/busy UI paints before the synchronous parse.
      await new Promise((r) => setTimeout(r, 0));
      const XLSX: any = await import("xlsx");
      const buf = await opened.file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const loaded: SheetData[] = wb.SheetNames.map((name: string) => {
        const ws = wb.Sheets[name];
        const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: "" });
        const rows = rectify(aoa.length ? aoa : [[""]]);
        return { name, rows };
      });
      setSheets(loaded.length ? loaded : [blankSheet(ar ? "ورقة 1" : "Sheet1")]);
      setActive(0);
      setFileName(opened.file.name);
      setHandle(opened.handle);
      setDirty(false);
      resetScroll();
    } catch (e: any) {
      toast({ title: ar ? "تعذّر فتح الملف" : "Could not open file", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const handleImportPdf = async () => {
    try {
      const opened = await openFile({
        accept: PDF_ACCEPT,
        description: ar ? "ملفات PDF" : "PDF files",
      });
      if (!opened) return;
      setBusy(true);
      const table = await extractPdfTable(opened.file);
      // One continuous, column-aligned table for the WHOLE document (a 298-page
      // report opens as a single editable sheet, not one tab per page). Columns
      // are detected globally so blank debit/credit cells keep their position.
      if (!table.length) {
        toast({
          title: ar ? "لا يوجد نص قابل للاستخراج" : "No extractable text",
          description: ar
            ? "هذا الملف يبدو ممسوحاً ضوئياً (صورة). يتطلب تحويله ميزة OCR غير المتوفرة حالياً."
            : "This PDF appears to be scanned (image-only). Converting it needs OCR, which is not available yet.",
          variant: "destructive",
        });
        return;
      }
      // Journal-entries reports are flattened into the importer's column layout
      // (رقم القيد · التاريخ · الحساب · البيان · مدين · دائن); other PDFs keep the
      // raw aligned table.
      const je = flattenJournalEntries(table);
      const rows = rectify(je ? [je.headers, ...je.rows] : table);
      setSheets([{ name: je ? (ar ? "القيود" : "Entries") : (ar ? "البيانات" : "Data"), rows }]);
      setActive(0);
      // Imported content has no original XLSX file → save creates a new one.
      setFileName(withExtension(opened.file.name, "xlsx"));
      setHandle(null);
      setDirty(true);
      resetScroll();
      toast({
        title: je
          ? (ar ? "تم استيراد القيود" : "Entries imported")
          : (ar ? "تم استيراد PDF" : "PDF imported"),
        description: je
          ? (ar
              ? `تم استخراج ${je.entryCount} قيد (${je.rows.length} سطر) في أعمدة منظّمة. راجعها ثم استخدم «إرسال إلى القيود المحاسبية».`
              : `Extracted ${je.entryCount} entries (${je.rows.length} lines) into clean columns. Review, then use "Send to journal entries".`)
          : (ar
              ? `تم استخراج ${rows.length} سطراً في جدول واحد. راجع البيانات ثم احفظها بصيغة Excel.`
              : `Extracted ${rows.length} rows into one table. Review, then save as Excel.`),
      });
    } catch (e: any) {
      toast({ title: ar ? "تعذّر استيراد PDF" : "Could not import PDF", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  // Hand the active sheet to the Data-Import wizard, pre-seeded for journal
  // entries (analyze → review → commit). The first non-empty row is treated as
  // the header; the remaining rows become objects keyed by those headers.
  const sendToJournalEntries = () => {
    const s = sheets[active] ?? sheets[0];
    const aoa = s?.rows ?? [];
    const headerRow = aoa.find((r) => r.some((c) => String(c ?? "").trim() !== ""));
    if (!headerRow) {
      toast({ title: ar ? "لا توجد بيانات لإرسالها" : "No data to send", variant: "destructive" });
      return;
    }
    const headerIdx = aoa.indexOf(headerRow);
    const headers = headerRow.map((h, i) => {
      const v = String(h ?? "").trim();
      return v === "" ? `${ar ? "عمود" : "Column"} ${i + 1}` : v;
    });
    const dataRows = aoa
      .slice(headerIdx + 1)
      .filter((r) => r.some((c) => String(c ?? "").trim() !== ""))
      .map((r) => {
        const o: Record<string, any> = {};
        headers.forEach((h, i) => { o[h] = r[i] ?? null; });
        return o;
      });
    if (!dataRows.length) {
      toast({ title: ar ? "لا توجد بيانات لإرسالها" : "No data to send", variant: "destructive" });
      return;
    }
    try {
      sessionStorage.setItem("office_je_import", JSON.stringify({ headers, rows: dataRows }));
    } catch {
      toast({ title: ar ? "تعذّر تجهيز البيانات" : "Could not stage data", variant: "destructive" });
      return;
    }
    navigate("/settings/data-io?tab=import");
  };

  const doSave = async (kind: "xlsx" | "csv", saveAs: boolean) => {
    try {
      setBusy(true);
      const XLSX: any = await import("xlsx");
      let blob: Blob;
      let suggested: string;
      let accept: Record<string, string[]>;
      if (kind === "csv") {
        const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
        const csv = XLSX.utils.sheet_to_csv(ws);
        blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
        suggested = withExtension(fileName, "csv");
        accept = CSV_ACCEPT;
      } else {
        const wb = XLSX.utils.book_new();
        sheets.forEach((s) => {
          const ws = XLSX.utils.aoa_to_sheet(s.rows);
          XLSX.utils.book_append_sheet(wb, ws, (s.name || "Sheet").slice(0, 31));
        });
        const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
        blob = new Blob([out], { type: XLSX_ACCEPT["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"][0] });
        suggested = withExtension(fileName, "xlsx");
        accept = { "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"] };
      }
      const sameKind = kind === "xlsx" ? fileName.toLowerCase().endsWith(".xlsx") : fileName.toLowerCase().endsWith(".csv");
      const res = await saveFile(blob, {
        suggestedName: suggested,
        accept,
        description: kind === "xlsx" ? "Excel" : "CSV",
        handle: saveAs || !sameKind ? null : handleRef.current,
      });
      if (res.saved) {
        if (res.handle) setHandle(res.handle);
        setFileName(suggested);
        setDirty(false);
        toast({ title: ar ? "تم الحفظ" : "Saved", description: suggested });
      }
    } catch (e: any) {
      toast({ title: ar ? "تعذّر الحفظ" : "Could not save", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const handlePdf = () => {
    const head = sheet.rows[0] ?? [];
    const body = sheet.rows.slice(1);
    const html = `<h2>${escapeHtml(sheet.name)}</h2><table><thead><tr>${
      head.map((h) => `<th>${escapeHtml(h)}</th>`).join("")
    }</tr></thead><tbody>${
      body.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("")
    }</tbody></table>`;
    printHtml(html, { title: fileName, rtl: ar });
  };

  // Export the ACTIVE sheet to a plain-text format (txt / html / json). XLSX
  // (all sheets) and CSV keep their own save-back-in-place path in doSave.
  const exportAs = async (kind: "txt" | "html" | "json") => {
    try {
      setBusy(true);
      const rows = sheet.rows;
      let blob: Blob;
      let suggested: string;
      let accept: Record<string, string[]>;
      let description: string;
      if (kind === "txt") {
        const txt = rows.map((r) => r.map((c) => String(c ?? "")).join("\t")).join("\r\n");
        blob = new Blob(["\uFEFF" + txt], { type: "text/plain;charset=utf-8" });
        suggested = withExtension(fileName, "txt");
        accept = TXT_ACCEPT;
        description = ar ? "نص" : "Text";
      } else if (kind === "json") {
        blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json;charset=utf-8" });
        suggested = withExtension(fileName, "json");
        accept = JSON_ACCEPT;
        description = "JSON";
      } else {
        const head = rows[0] ?? [];
        const body = rows.slice(1);
        const dir = ar ? "rtl" : "ltr";
        const align = ar ? "right" : "left";
        const html = `<!DOCTYPE html><html dir="${dir}" lang="${ar ? "ar" : "en"}"><head><meta charset="utf-8"><title>${
          escapeHtml(sheet.name)
        }</title><style>table{border-collapse:collapse}th,td{border:1px solid #999;padding:6px 8px;text-align:${align}}th{background:#f1f5f9}</style></head><body><table><thead><tr>${
          head.map((h) => `<th>${escapeHtml(h)}</th>`).join("")
        }</tr></thead><tbody>${
          body.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("")
        }</tbody></table></body></html>`;
        blob = new Blob([html], { type: "text/html;charset=utf-8" });
        suggested = withExtension(fileName, "html");
        accept = HTML_ACCEPT;
        description = "HTML";
      }
      const res = await saveFile(blob, { suggestedName: suggested, accept, description, handle: null });
      if (res.saved) toast({ title: ar ? "تم الحفظ" : "Saved", description: suggested });
    } catch (e: any) {
      toast({ title: ar ? "تعذّر الحفظ" : "Could not save", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const colCount = sheet.rows[0]?.length ?? 0;

  // Measure the scroll viewport, sticky-header height, and the real rendered
  // row height (so the spacer math stays exact regardless of borders/zoom).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      setViewportH(el.clientHeight || 600);
      setHeaderH(theadRef.current?.offsetHeight ?? 0);
      const probe = rowProbeRef.current?.offsetHeight;
      if (probe && probe > 0) setRowH(probe);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [active, colCount, sheet.rows.length]);

  const totalRows = sheet.rows.length;
  const bodyScroll = Math.max(0, scrollTop - headerH);
  const startRow = Math.max(0, Math.floor(bodyScroll / rowH) - OVERSCAN);
  const endRow = Math.min(totalRows, startRow + Math.ceil(viewportH / rowH) + OVERSCAN * 2);
  const topPad = startRow * rowH;
  const bottomPad = Math.max(0, (totalRows - endRow) * rowH);

  return (
    <div className="p-4 sm:p-6 space-y-3" data-testid="page-office-excel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <FileSpreadsheet className="h-5 w-5 text-green-600" />
          {t("nav.officeExcel", { defaultValue: ar ? "محرر الجداول (Excel)" : "Spreadsheet Editor (Excel)" })}
          <span className="text-sm font-normal text-muted-foreground truncate max-w-[40vw]">
            — {fileName}{dirty ? " *" : ""}
          </span>
        </h1>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={handleNew} disabled={busy} data-testid="button-excel-new">
            <FilePlus2 className="h-4 w-4 ms-1" /> {ar ? "جديد" : "New"}
          </Button>
          <Button size="sm" variant="outline" onClick={handleOpen} disabled={busy} data-testid="button-excel-open">
            <FolderOpen className="h-4 w-4 ms-1" /> {ar ? "فتح" : "Open"}
          </Button>
          <Button size="sm" variant="outline" onClick={handleImportPdf} disabled={busy} data-testid="button-excel-importpdf">
            <FileUp className="h-4 w-4 ms-1" /> {ar ? "استيراد PDF" : "Import PDF"}
          </Button>
          <Button size="sm" variant="outline" onClick={sendToJournalEntries} disabled={busy} data-testid="button-excel-tojournal">
            <Send className="h-4 w-4 ms-1" /> {ar ? "إرسال إلى القيود المحاسبية" : "Send to journal entries"}
          </Button>
          <Button size="sm" onClick={() => doSave("xlsx", false)} disabled={busy} data-testid="button-excel-save">
            <Save className="h-4 w-4 ms-1" /> {ar ? "حفظ XLSX" : "Save XLSX"}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={busy} data-testid="button-excel-saveas">
                {ar ? "حفظ باسم" : "Save As"} <ChevronDown className="h-4 w-4 ms-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => doSave("xlsx", true)} data-testid="menu-excel-xlsx">
                Excel (.xlsx)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => doSave("csv", true)} data-testid="menu-excel-csv">
                CSV (.csv)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => exportAs("txt")} data-testid="menu-excel-txt">
                {ar ? "نص" : "Text"} (.txt)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => exportAs("html")} data-testid="menu-excel-html">
                HTML (.html)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => exportAs("json")} data-testid="menu-excel-json">
                JSON (.json)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handlePdf} data-testid="menu-excel-pdf">
                PDF (.pdf)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <Card className="p-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={addRow} data-testid="button-excel-addrow"><Plus className="h-4 w-4 ms-1" /> {ar ? "صف" : "Row"}</Button>
        <Button size="sm" variant="outline" onClick={removeRow} data-testid="button-excel-delrow"><Trash2 className="h-4 w-4 ms-1" /> {ar ? "صف" : "Row"}</Button>
        <Button size="sm" variant="outline" onClick={addCol} data-testid="button-excel-addcol"><Columns3 className="h-4 w-4 ms-1" /> {ar ? "عمود" : "Col"}</Button>
        <Button size="sm" variant="outline" onClick={removeCol} data-testid="button-excel-delcol"><Trash2 className="h-4 w-4 ms-1" /> {ar ? "عمود" : "Col"}</Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setGridDir((d) => (d === "rtl" ? "ltr" : "rtl"))}
          title={ar ? "اتجاه الأعمدة (يمين/يسار)" : "Column direction (right/left)"}
          data-testid="button-excel-gridir"
        >
          <ArrowLeftRight className="h-4 w-4 ms-1" />
          {gridDir === "rtl" ? (ar ? "من اليمين" : "Right→Left") : (ar ? "من اليسار" : "Left→Right")}
        </Button>
        <span className="text-xs text-muted-foreground ms-2">{sheet.rows.length} × {colCount}</span>
      </Card>

      <Card
        ref={scrollRef}
        onScroll={(e) => setScrollTop((e.currentTarget as HTMLDivElement).scrollTop)}
        className="p-0 overflow-auto max-h-[60vh]"
      >
        <table className="border-collapse text-sm" dir={gridDir} data-testid="grid-excel">
          <thead ref={theadRef} className="sticky top-0 z-10">
            <tr>
              <th className="bg-muted border border-border w-10 text-xs text-muted-foreground sticky start-0 z-20" />
              {Array.from({ length: colCount }, (_, c) => (
                <th key={c} className="bg-muted border border-border px-2 py-1 text-xs font-semibold text-muted-foreground min-w-[6rem]">
                  {colLabel(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {topPad > 0 && (
              <tr aria-hidden style={{ height: topPad }}>
                <td colSpan={colCount + 1} className="p-0 border-0" />
              </tr>
            )}
            {sheet.rows.slice(startRow, endRow).map((row, i) => {
              const r = startRow + i;
              return (
                <tr key={r} ref={i === 0 ? rowProbeRef : undefined} style={{ height: ROW_H }}>
                  <td className="bg-muted border border-border text-center text-xs text-muted-foreground sticky start-0 z-10">{r + 1}</td>
                  {Array.from({ length: colCount }, (_, c) => (
                    <td key={c} className="border border-border p-0">
                      <input
                        value={row[c] ?? ""}
                        onChange={(e) => updateCell(r, c, e.target.value)}
                        dir="auto"
                        className="w-full min-w-[6rem] h-8 px-2 py-0 bg-transparent outline-none focus:bg-blue-50 focus:ring-1 focus:ring-blue-400"
                        data-testid={`cell-${r}-${c}`}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
            {bottomPad > 0 && (
              <tr aria-hidden style={{ height: bottomPad }}>
                <td colSpan={colCount + 1} className="p-0 border-0" />
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <div className="flex flex-wrap items-center gap-1">
        {sheets.map((s, i) => (
          <button
            key={i}
            type="button"
            onClick={() => { setActive(i); resetScroll(); }}
            className={`px-3 py-1 text-sm rounded-t border-b-2 ${
              i === active ? "border-green-600 font-semibold bg-card" : "border-transparent text-muted-foreground hover:bg-muted"
            }`}
            data-testid={`tab-sheet-${i}`}
          >
            {s.name}
          </button>
        ))}
        <button type="button" onClick={addSheet} title={ar ? "إضافة ورقة" : "Add sheet"} className="px-2 py-1 rounded hover:bg-muted" data-testid="button-add-sheet">
          <Plus className="h-4 w-4" />
        </button>
        {sheets.length > 1 && (
          <button type="button" onClick={removeSheet} title={ar ? "حذف الورقة" : "Delete sheet"} className="px-2 py-1 rounded hover:bg-muted text-red-600" data-testid="button-del-sheet">
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function escapeHtml(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
